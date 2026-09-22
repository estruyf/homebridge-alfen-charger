/**
 * The boundary between the HomeKit side of the plugin and whatever is talking
 * to the charger. The HTTP backend is the only implementation today; a Modbus
 * TCP backend can be dropped in later without the accessory code changing.
 */

/** A snapshot of everything the plugin needs from the charger. */
export interface ChargerState {
  /** 2129_0 - the configured socket current limit in A. This is what we write. */
  maxCurrentA: number | null;
  /** 212C_0 - the limit the charger is actually applying in A. */
  activeMaxCurrentA: number | null;
  /** 2221_16 - total real power in W. */
  realPowerW: number | null;
  /** Per-phase currents in A. */
  currentsA: { l1: number | null; l2: number | null; l3: number | null };
  /** 2501_4 - raw Mode 3 pilot state. */
  mode3State: number | null;
  /** 2501_3 - raw CPRO power state. */
  socketState: number | null;
  /** 2501_1 - raw main state. */
  mainState: number | null;
  /** 312E_0 - phases wired to the socket, 1 or 3. Used to convert kW to amps. */
  maxPhases: number | null;
  /** When this snapshot was taken (epoch ms). */
  readAt: number;
}

export interface ChargerDeviceInfo {
  /** Charger identity, e.g. "ACE0123456". */
  identity: string;
  model: string;
  modelId: string;
  firmwareVersion: string;
  objectId: string;
  type: string;
}

/**
 * A transport that can read and control the charger.
 *
 * Implementations must serialise their own traffic: the Alfen HTTP API allows a
 * single session and is known to misbehave under concurrent requests.
 */
export interface ChargerBackend {
  /** Short name used in logs, e.g. "http" or "modbus". */
  readonly kind: string;

  /**
   * True when holding this backend open locks other clients out. The HTTP API
   * allows only one session, so it blocks the Eve Connect app; Modbus does not.
   * The accessory only offers the "Connected" switch when this is true.
   */
  readonly isExclusive: boolean;

  /** Establish whatever session the transport needs. Safe to call repeatedly. */
  connect(): Promise<void>;

  /** Release the session so another client can connect. Safe to call repeatedly. */
  disconnect(): Promise<void>;

  /** Read device identity. May be cached by the implementation. */
  getDeviceInfo(): Promise<ChargerDeviceInfo>;

  /** Read a full state snapshot. */
  readState(): Promise<ChargerState>;

  /**
   * Set the socket current limit in A.
   *
   * Implementations must read the value back and confirm it stuck, retrying
   * once before throwing.
   */
  setMaxCurrent(amps: number): Promise<void>;
}

/** Thrown when the charger rejects our credentials or the session expired. */
export class ChargerAuthError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'ChargerAuthError';
  }
}

/** Thrown when a write could not be confirmed by reading it back. */
export class ChargerWriteVerifyError extends Error {
  constructor(message: string, readonly expected: number, readonly actual: number | null) {
    super(message);
    this.name = 'ChargerWriteVerifyError';
  }
}

/** Thrown for transport-level failures (timeout, socket error, 5xx). */
export class ChargerTransportError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'ChargerTransportError';
  }
}

/** Minimal logger shape, satisfied by Homebridge's Logger and by the probe CLI. */
export interface Logger {
  debug(message: string, ...params: unknown[]): void;
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}
