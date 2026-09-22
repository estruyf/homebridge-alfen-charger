import {
  MAX_CHARGE_CURRENT_A,
  MIN_CHARGE_CURRENT_A,
  NOMINAL_VOLTAGE,
  powerToAmps,
} from './charger/params';
import { DEFAULT_POWER_THRESHOLD_W } from './charger/state';

/** The platform block as it appears in Homebridge's config.json. */
export interface AlfenPlatformConfigRaw {
  platform: string;
  name?: string;
  host?: string;
  password?: string;
  /** Charge rate in kW. Preferred: this is what the Eve Connect app shows. */
  chargePower?: number;
  /** Legacy charge rate in amps, still honoured when chargePower is absent. */
  chargeCurrent?: number;
  pollInterval?: number;
  debug?: boolean;
  certificateFingerprint?: string;
  requestTimeout?: number;
  powerThreshold?: number;
  nominalVoltage?: number;
}

/**
 * What the user asked for when the Charging switch goes on.
 *
 * kW has to stay unresolved until we know how many phases the socket has, so
 * the config keeps the request as given and the accessory converts it once the
 * charger has told us.
 */
export type ChargeTarget =
  | { kind: 'power'; kilowatts: number }
  | { kind: 'current'; amps: number };

/** A validated, fully defaulted configuration. */
export interface AlfenPlatformConfig {
  name: string;
  host: string;
  password: string;
  chargeTarget: ChargeTarget;
  nominalVoltage: number;
  pollIntervalMs: number;
  debug: boolean;
  certificateFingerprint?: string;
  requestTimeoutMs: number;
  powerThresholdW: number;
}

/** 3.7 kW, which is 16 A on a single phase - the usual home default. */
export const DEFAULT_CHARGE_POWER_KW = 3.7;
export const DEFAULT_POLL_INTERVAL_S = 30;
/** Below this the charger gets more traffic than it is comfortable with. */
export const MIN_POLL_INTERVAL_S = 10;
export const DEFAULT_REQUEST_TIMEOUT_S = 15;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validate the platform config, filling in defaults and clamping values the
 * Homebridge UI cannot enforce (a hand-edited config.json can contain anything).
 */
export function parseConfig(raw: AlfenPlatformConfigRaw): AlfenPlatformConfig {
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  if (host === '') {
    throw new ConfigError('"host" is required: set it to the charger\'s IP address or hostname.');
  }
  if (/^https?:\/\//i.test(host)) {
    throw new ConfigError('"host" must be a bare IP address or hostname, without a scheme.');
  }

  const password = typeof raw.password === 'string' ? raw.password : '';
  if (password === '') {
    throw new ConfigError('"password" is required: use the charger\'s admin password.');
  }

  const nominalVoltage = clamp(numberOr(raw.nominalVoltage, NOMINAL_VOLTAGE), 100, 500);
  const chargeTarget = parseChargeTarget(raw);

  const pollInterval = Math.max(
    MIN_POLL_INTERVAL_S,
    numberOr(raw.pollInterval, DEFAULT_POLL_INTERVAL_S),
  );

  const requestTimeout = clamp(numberOr(raw.requestTimeout, DEFAULT_REQUEST_TIMEOUT_S), 5, 60);

  return {
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'Alfen Charger',
    host,
    password,
    chargeTarget,
    nominalVoltage,
    pollIntervalMs: Math.round(pollInterval) * 1000,
    debug: raw.debug === true,
    certificateFingerprint:
      typeof raw.certificateFingerprint === 'string' && raw.certificateFingerprint.trim() !== ''
        ? raw.certificateFingerprint.trim()
        : undefined,
    requestTimeoutMs: Math.round(requestTimeout) * 1000,
    powerThresholdW: Math.max(0, numberOr(raw.powerThreshold, DEFAULT_POWER_THRESHOLD_W)),
  };
}

/**
 * Decide what the Charging switch should ask for.
 *
 * kW wins when both are present, since it is the option the UI offers; amps
 * remain supported so a config written against an earlier version keeps working.
 */
function parseChargeTarget(raw: AlfenPlatformConfigRaw): ChargeTarget {
  const power = optionalNumber(raw.chargePower);
  if (power !== undefined) {
    if (power <= 0) {
      throw new ConfigError('"chargePower" must be greater than 0 kW.');
    }
    return { kind: 'power', kilowatts: power };
  }

  const current = optionalNumber(raw.chargeCurrent);
  if (current !== undefined) {
    return {
      kind: 'current',
      amps: Math.round(clamp(current, MIN_CHARGE_CURRENT_A, MAX_CHARGE_CURRENT_A)),
    };
  }

  return { kind: 'power', kilowatts: DEFAULT_CHARGE_POWER_KW };
}

/**
 * Resolve a target to whole amps for a socket with `phases` phases, clamped to
 * what the charger accepts.
 *
 * Returns the clamp reason too, so the caller can say plainly that it could not
 * deliver what was asked rather than silently charging at a different rate.
 */
export function resolveTargetAmps(
  target: ChargeTarget,
  phases: number,
  voltage: number,
): { amps: number; requestedAmps: number; clamped: boolean } {
  const requestedAmps =
    target.kind === 'power' ? powerToAmps(target.kilowatts, phases, voltage) : target.amps;
  const amps = clamp(requestedAmps, MIN_CHARGE_CURRENT_A, MAX_CHARGE_CURRENT_A);
  return { amps, requestedAmps, clamped: amps !== requestedAmps };
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
