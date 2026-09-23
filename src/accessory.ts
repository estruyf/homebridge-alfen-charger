import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { Backoff } from './charger/mutex';
import {
  DEFAULT_PHASES,
  MIN_CHARGE_CURRENT_A,
  PAUSE_CURRENT_A,
  ampsToPower,
  maxPowerKw,
  minPowerKw,
} from './charger/params';
import { isChargingEnabled, isDrawingPower, isVehicleConnected, summariseState } from './charger/state';
import type { ChargerBackend, ChargerState, Logger } from './charger/types';
import { resolveTargetAmps, type AlfenPlatformConfig } from './config';
import type { AlfenChargerPlatform } from './platform';

/** How long a cached reading may be served to HomeKit before we call it stale. */
const STATE_MAX_AGE_MS = 5 * 60_000;

/**
 * The HomeKit face of the charger.
 *
 * Two separate accessories, so the Home app gives each its own tile rather than
 * folding them into one where a single tap hits whichever service HomeKit picks:
 *
 *  - Charging   - an Outlet. `On` writes the socket current limit
 *                 (chargeCurrent / 0 A); `OutletInUse` reflects real power draw.
 *  - Connection - a Switch that holds or releases the charger's single API session.
 *
 * Both are driven from one poll loop, which is why they live in one class.
 */
export class AlfenChargerAccessory {
  private readonly outlet: Service;
  private readonly connectionSwitch: Service;

  private readonly backoff = new Backoff();
  private pollTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  /** Last successful reading, served to HomeKit between polls. */
  private lastState: ChargerState | undefined;
  /**
   * What we last asked the charger to do. HomeKit gets this immediately after a
   * write so the toggle does not spring back while the charger catches up.
   */
  private pendingChargingState: boolean | undefined;
  /**
   * True while the plugin holds the charger's session and is polling.
   *
   * The charger allows one session at a time, so this is also what decides
   * whether the Eve Connect app can get in: false means we have stood down.
   */
  private connected = true;
  /** So a charge rate that cannot be honoured is reported once, not every poll. */
  private warnedAboutClamp = false;

  constructor(
    private readonly platform: AlfenChargerPlatform,
    private readonly chargingAccessory: PlatformAccessory,
    private readonly connectionAccessory: PlatformAccessory,
    private readonly backend: ChargerBackend,
    private readonly config: AlfenPlatformConfig,
    private readonly log: Logger,
  ) {
    const { Service, Characteristic } = this.platform;

    this.describe(this.chargingAccessory);
    this.describe(this.connectionAccessory);

    // Earlier versions put all three services on one accessory, which the Home
    // app shows as a single grouped tile. Drop the extras so the charging
    // accessory is left with just the outlet and gets a tile of its own.
    this.removeLegacyServices(this.chargingAccessory, ['charging', 'connection'], ['Charging', 'Connected', 'App access']);

    this.outlet =
      this.chargingAccessory.getServiceById(Service.Outlet, 'charge-point') ??
      this.chargingAccessory.addService(Service.Outlet, this.chargingAccessory.displayName, 'charge-point');
    this.outlet.setCharacteristic(Characteristic.ConfiguredName, this.chargingAccessory.displayName);
    // On starts and stops the charging session; OutletInUse is the read-only
    // "is the car actually drawing?".
    this.outlet
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.getChargingOn())
      .onSet((value) => this.setChargingOn(value));
    this.outlet.getCharacteristic(Characteristic.OutletInUse).onGet(() => this.getOutletInUse());

    this.connectionSwitch =
      this.connectionAccessory.getServiceById(Service.Switch, 'connection') ??
      this.connectionAccessory.addService(Service.Switch, this.connectionAccessory.displayName, 'connection');
    this.connectionSwitch.setCharacteristic(
      Characteristic.ConfiguredName,
      this.connectionAccessory.displayName,
    );
    this.connectionSwitch
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.connected)
      .onSet((value) => this.setConnected(value));
  }

  /** Stamp the shared identity onto an accessory's information service. */
  private describe(accessory: PlatformAccessory): void {
    const { Service, Characteristic } = this.platform;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Alfen')
      .setCharacteristic(Characteristic.Model, 'Eve Single')
      .setCharacteristic(Characteristic.SerialNumber, this.config.host);
  }

  /**
   * Strip services a previous version added to this accessory.
   *
   * Matched on subtype first, since that survives a rename in the Home app, and
   * on the original display names as a fallback for accessories cached before
   * subtypes were used consistently.
   */
  private removeLegacyServices(
    accessory: PlatformAccessory,
    subtypes: string[],
    names: string[],
  ): void {
    const { Service } = this.platform;
    const doomed = new Set<Service>();

    for (const subtype of subtypes) {
      const bySubtype =
        accessory.getServiceById(Service.Switch, subtype) ??
        accessory.getServiceById(Service.Outlet, subtype);
      if (bySubtype) {
        doomed.add(bySubtype);
      }
    }
    for (const name of names) {
      const byName = accessory.getService(name);
      // Never remove the outlet we are about to reuse, whatever it is called.
      if (byName && byName.subtype !== 'charge-point') {
        doomed.add(byName);
      }
    }

    for (const service of doomed) {
      this.log.info(
        `Removing the old "${service.displayName}" service from ${accessory.displayName}: ` +
          'it now has its own tile in the Home app.',
      );
      accessory.removeService(service);
    }
  }

  /** Connect, read identity, and start polling. */
  async begin(): Promise<void> {
    try {
      const info = await this.backend.getDeviceInfo();
      this.log.info(
        `Connected to ${info.identity} (${info.model}, firmware ${info.firmwareVersion}) at ${this.config.host}`,
      );
      for (const accessory of [this.chargingAccessory, this.connectionAccessory]) {
        accessory
          .getService(this.platform.Service.AccessoryInformation)!
          .setCharacteristic(this.platform.Characteristic.Model, info.model)
          .setCharacteristic(this.platform.Characteristic.SerialNumber, info.identity)
          .setCharacteristic(this.platform.Characteristic.FirmwareRevision, info.firmwareVersion);
      }
    } catch (err) {
      // /api/info is unauthenticated, so this failing usually means the host is
      // wrong or unreachable. Carry on: polling will report the real problem.
      this.log.warn(`Could not read charger info: ${(err as Error).message}`);
    }

    if (this.backend.isExclusive) {
      this.log.info(
        'The charger allows one session at a time: while this plugin is connected, ' +
          `the Eve Connect app cannot log in. Turn off "${this.connectionAccessory.displayName}" to hand the session over.`,
      );
    }

    this.schedulePoll(0);
  }

  stopPolling(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ------------------------------------------------------------- HomeKit gets

  private getChargingOn(): CharacteristicValue {
    if (this.pendingChargingState !== undefined) {
      return this.pendingChargingState;
    }
    const state = this.requireFreshState();
    const enabled = isChargingEnabled(state);
    if (enabled === null) {
      throw this.communicationFailure();
    }
    return enabled;
  }

  private getOutletInUse(): CharacteristicValue {
    const state = this.requireFreshState();
    return isDrawingPower(state, this.config.powerThresholdW);
  }

  /**
   * Return the most recent reading, or tell HomeKit we are not responding.
   *
   * While we are disconnected we deliberately keep serving the last reading:
   * the session belongs to the phone app, and showing stale-but-true values is
   * more useful than painting the tiles as unresponsive.
   */
  private requireFreshState(): ChargerState {
    const state = this.lastState;
    if (!state) {
      throw this.communicationFailure();
    }
    if (this.connected && Date.now() - state.readAt > STATE_MAX_AGE_MS) {
      throw this.communicationFailure();
    }
    return state;
  }

  private communicationFailure(): Error {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  // ------------------------------------------------------------- HomeKit sets

  private async setChargingOn(value: CharacteristicValue): Promise<void> {
    const on = value === true;

    if (!this.connected) {
      this.log.warn(
        `Ignoring a charging change: "${this.connectionAccessory.displayName}" is off, ` +
          'so the plugin has no charger session.',
      );
      throw this.communicationFailure();
    }

    const amps = on ? this.resolveChargeAmps() : PAUSE_CURRENT_A;
    this.log.info(
      `${on ? 'Resuming' : 'Pausing'} charging (socket limit -> ${this.describeLimit(amps)})`,
    );

    // Show the requested position straight away; the next poll replaces it with
    // whatever the charger actually reports.
    this.pendingChargingState = on;
    this.syncChargingCharacteristics(on);

    try {
      await this.backend.setMaxCurrent(amps);
      this.backoff.reset();
      this.log.info(
        `Charging ${on ? 'resumed' : 'paused'} (socket limit is now ${this.describeLimit(amps)})`,
      );
      // Refresh soon so OutletInUse and the switch settle on real values.
      this.schedulePoll(3_000);
    } catch (err) {
      this.pendingChargingState = undefined;
      this.log.error(`Could not ${on ? 'resume' : 'pause'} charging: ${(err as Error).message}`);
      // Put the tiles back where the charger last had them.
      if (this.lastState) {
        const actual = isChargingEnabled(this.lastState);
        if (actual !== null) {
          this.syncChargingCharacteristics(actual);
        }
      }
      throw this.communicationFailure();
    }
  }

  /**
   * Take or release the charger's single API session.
   *
   * On  - log in and poll, so charging can be controlled from HomeKit.
   * Off - log out and stop polling, freeing the charger for the Eve Connect app.
   */
  private async setConnected(value: CharacteristicValue): Promise<void> {
    const on = value === true;
    if (on === this.connected) {
      return;
    }

    if (!on) {
      this.connected = false;
      this.stopPollTimer();
      this.log.info('Disconnecting: logging out and pausing polling so the Eve Connect app can connect.');
      try {
        await this.backend.disconnect();
        this.log.info('Session released. The Eve Connect app can log in now.');
      } catch (err) {
        this.log.warn(`Logout did not complete cleanly: ${(err as Error).message}`);
      }
      return;
    }

    this.connected = true;
    this.log.info('Connecting: logging in and resuming polling.');
    this.backoff.reset();
    try {
      await this.backend.connect();
    } catch (err) {
      // The app may still be holding the session; polling will retry with backoff.
      this.log.warn(
        `Could not log back in yet: ${(err as Error).message}. ` +
          'If the Eve Connect app is still open, close it and the plugin will reconnect.',
      );
    }
    this.schedulePoll(0);
  }

  // --------------------------------------------------------------- conversion

  /** Phases wired to this socket, as reported by the charger. */
  private get phases(): number {
    const reported = this.lastState?.maxPhases;
    return reported === 1 || reported === 3 ? reported : DEFAULT_PHASES;
  }

  /**
   * Turn the configured charge target into whole amps for this socket.
   *
   * The charger stores amps, so a kW setting has to be converted, and that
   * depends on how many phases are wired. If the request cannot be honoured we
   * say so once rather than quietly charging at a different rate.
   */
  private resolveChargeAmps(): number {
    const { amps, requestedAmps, clamped } = resolveTargetAmps(
      this.config.chargeTarget,
      this.phases,
      this.config.nominalVoltage,
    );

    if (clamped && !this.warnedAboutClamp) {
      this.warnedAboutClamp = true;
      const target = this.config.chargeTarget;
      const asked =
        target.kind === 'power' ? `${target.kilowatts} kW` : `${target.amps}A`;
      const range =
        `${minPowerKw(this.phases, this.config.nominalVoltage)}-` +
        `${maxPowerKw(this.phases, this.config.nominalVoltage)} kW`;
      this.log.warn(
        `Configured charge rate of ${asked} works out as ${requestedAmps}A on ${this.phases} phase(s), ` +
          `which this socket cannot do. Using ${this.describeLimit(amps)} instead. Valid range: ${range}.`,
      );
    }

    return amps;
  }

  /** Format a current limit with the kW figure alongside, since kW is configured. */
  private describeLimit(amps: number): string {
    if (amps < MIN_CHARGE_CURRENT_A) {
      return `${amps}A (below the ${MIN_CHARGE_CURRENT_A}A minimum, so charging stops)`;
    }
    return `${amps}A = ${ampsToPower(amps, this.phases, this.config.nominalVoltage)} kW`;
  }

  // ------------------------------------------------------------------ polling

  private stopPollTimer(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped || !this.connected) {
      return;
    }
    this.stopPollTimer();
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, delayMs);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.connected) {
      return;
    }

    if (this.backoff.isBlocked()) {
      this.schedulePoll(this.backoff.remainingMs());
      return;
    }

    try {
      const state = await this.backend.readState();
      this.backoff.reset();
      this.lastState = state;
      this.log.debug(`Charger state: ${summariseState(state)}`);
      this.applyState(state);
      this.schedulePoll(this.config.pollIntervalMs);
    } catch (err) {
      const waitMs = this.backoff.fail();
      const message = (err as Error).message;
      // First failure is a warning; after that keep it to debug so a charger
      // that is offline overnight does not fill the log.
      if (this.backoff.failureCount === 1) {
        this.log.warn(`Could not read the charger: ${message}. Retrying in ${Math.round(waitMs / 1000)}s.`);
      } else {
        this.log.debug(
          `Charger read failed (attempt ${this.backoff.failureCount}): ${message}. ` +
            `Retrying in ${Math.round(waitMs / 1000)}s.`,
        );
      }
      this.schedulePoll(waitMs);
    }
  }

  /** Push a fresh reading into the characteristics. */
  private applyState(state: ChargerState): void {
    const { Characteristic } = this.platform;
    const enabled = isChargingEnabled(state);

    if (enabled !== null) {
      // The charger has caught up with our last write, so stop overriding.
      if (this.pendingChargingState !== undefined && this.pendingChargingState === enabled) {
        this.pendingChargingState = undefined;
      }
      if (this.pendingChargingState === undefined) {
        this.syncChargingCharacteristics(enabled);
      }
    }

    this.outlet.updateCharacteristic(
      Characteristic.OutletInUse,
      isDrawingPower(state, this.config.powerThresholdW),
    );

    if (this.config.debug) {
      this.log.debug(
        `Vehicle ${isVehicleConnected(state) ? 'connected' : 'not connected'}; ` +
          `charging ${enabled === null ? 'unknown' : enabled ? 'allowed' : `paused (<${MIN_CHARGE_CURRENT_A}A)`}`,
      );
    }
  }

  private syncChargingCharacteristics(on: boolean): void {
    this.outlet.updateCharacteristic(this.platform.Characteristic.On, on);
  }
}
