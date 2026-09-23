import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { AlfenHttpBackend } from './charger/alfenHttpBackend';
import type { ChargerBackend } from './charger/types';
import { parseConfig, ConfigError, type AlfenPlatformConfig } from './config';
import { AlfenChargerAccessory } from './accessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

/**
 * Dynamic platform for a single Alfen Eve charger.
 *
 * One charger means one accessory, but a dynamic platform is still the right
 * shape: it lets the accessory be cached across restarts and keeps the door
 * open for a second charger later.
 */
export class AlfenChargerPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;

  /** Accessories restored from Homebridge's cache. */
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private config: AlfenPlatformConfig | undefined;
  private backend: ChargerBackend | undefined;
  private accessory: AlfenChargerAccessory | undefined;

  constructor(
    private readonly log: Logging,
    platformConfig: PlatformConfig,
    readonly api: API,
  ) {
    // Take HAP off the API object rather than importing hap-nodejs directly, so
    // the plugin works unchanged on Homebridge 1.8 and 2.x.
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    try {
      this.config = parseConfig(platformConfig as never);
    } catch (err) {
      if (err instanceof ConfigError) {
        this.log.error(`Configuration problem: ${err.message} The platform will not start.`);
      } else {
        this.log.error(`Could not read the configuration: ${(err as Error).message}`);
      }
      return;
    }

    const target = this.config.chargeTarget;
    this.log.debug(
      `Configured for ${this.config.host}, charge rate ` +
        `${target.kind === 'power' ? `${target.kilowatts} kW` : `${target.amps}A`}, ` +
        `polling every ${this.config.pollIntervalMs / 1000}s`,
    );

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });

    this.api.on('shutdown', () => {
      void this.stop();
    });
  }

  /** Homebridge hands back every accessory it had cached for this plugin. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory ${accessory.displayName}`);
    this.cachedAccessories.push(accessory);
  }

  private async start(): Promise<void> {
    const config = this.config;
    if (!config) {
      return;
    }

    const logger = makeLogger(this.log, config.debug);
    this.backend = new AlfenHttpBackend({
      host: config.host,
      password: config.password,
      timeoutMs: config.requestTimeoutMs,
      certificateFingerprint: config.certificateFingerprint,
      displayName: 'Homebridge',
      logger,
    });

    // UUIDs are derived from the host, so pointing the plugin at a different
    // charger produces new accessories rather than reusing these.
    //
    // The charging accessory keeps the UUID the single combined accessory used,
    // so upgrading from an earlier version leaves its room, favourite and
    // automations intact; only the connection tile is new.
    const chargingUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${config.host}`);
    const connectionUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${config.host}:connection`);

    const chargingAccessory = this.adopt(chargingUuid, config.name);
    const connectionAccessory = this.adopt(connectionUuid, `${config.name} Connection`);

    // Drop any cached accessories that no longer correspond to the config, so a
    // changed host does not leave a dead tile in the Home app.
    const stale = this.cachedAccessories.filter(
      (item) => item.UUID !== chargingUuid && item.UUID !== connectionUuid,
    );
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory/accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    this.accessory = new AlfenChargerAccessory(
      this,
      chargingAccessory,
      connectionAccessory,
      this.backend,
      config,
      logger,
    );
    await this.accessory.begin();
  }

  /** Reuse the cached accessory for this UUID, or register a fresh one. */
  private adopt(uuid: string, displayName: string): PlatformAccessory {
    const existing = this.cachedAccessories.find((item) => item.UUID === uuid);
    if (existing) {
      this.log.debug(`Using cached accessory "${existing.displayName}"`);
      existing.displayName = displayName;
      return existing;
    }

    this.log.info(`Adding accessory "${displayName}"`);
    const accessory = new this.api.platformAccessory(displayName, uuid);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    return accessory;
  }

  private async stop(): Promise<void> {
    this.accessory?.stopPolling();
    try {
      await this.backend?.disconnect();
    } catch (err) {
      this.log.debug(`Logout during shutdown failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Wrap Homebridge's logger so debug lines only appear when the plugin's own
 * debug option is on, rather than requiring Homebridge-wide debug mode.
 */
function makeLogger(log: Logging, debugEnabled: boolean) {
  return {
    debug: (message: string, ...params: unknown[]) => {
      if (debugEnabled) {
        // info level so the lines show up without running Homebridge with -D
        log.info(`[debug] ${message}`, ...params);
      } else {
        log.debug(message, ...params);
      }
    },
    info: (message: string, ...params: unknown[]) => log.info(message, ...params),
    warn: (message: string, ...params: unknown[]) => log.warn(message, ...params),
    error: (message: string, ...params: unknown[]) => log.error(message, ...params),
  };
}
