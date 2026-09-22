import { MAX_CHARGE_CURRENT_A, MIN_CHARGE_CURRENT_A } from './charger/params';
import { DEFAULT_POWER_THRESHOLD_W } from './charger/state';

/** The platform block as it appears in Homebridge's config.json. */
export interface AlfenPlatformConfigRaw {
  platform: string;
  name?: string;
  host?: string;
  password?: string;
  chargeCurrent?: number;
  pollInterval?: number;
  debug?: boolean;
  certificateFingerprint?: string;
  requestTimeout?: number;
  powerThreshold?: number;
}

/** A validated, fully defaulted configuration. */
export interface AlfenPlatformConfig {
  name: string;
  host: string;
  password: string;
  chargeCurrent: number;
  pollIntervalMs: number;
  debug: boolean;
  certificateFingerprint?: string;
  requestTimeoutMs: number;
  powerThresholdW: number;
}

export const DEFAULT_CHARGE_CURRENT_A = 16;
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

  const chargeCurrent = clamp(
    numberOr(raw.chargeCurrent, DEFAULT_CHARGE_CURRENT_A),
    MIN_CHARGE_CURRENT_A,
    MAX_CHARGE_CURRENT_A,
  );

  const pollInterval = Math.max(
    MIN_POLL_INTERVAL_S,
    numberOr(raw.pollInterval, DEFAULT_POLL_INTERVAL_S),
  );

  const requestTimeout = clamp(numberOr(raw.requestTimeout, DEFAULT_REQUEST_TIMEOUT_S), 5, 60);

  return {
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'Alfen Charger',
    host,
    password,
    chargeCurrent: Math.round(chargeCurrent),
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
