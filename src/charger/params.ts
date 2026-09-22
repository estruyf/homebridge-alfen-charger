/**
 * Alfen parameter IDs and enum maps.
 *
 * Verified against:
 *  - leeyuentuen/alfen_wallbox (custom_components/alfen_wallbox/{alfen,const,sensor,number}.py)
 *  - leeyuentuen/alfen_wallbox wiki: API-paramID
 *  - LordGaav/alfen-eve (alfeneve/alfen.py ALFEN_PROPERTY_ID_MAPPING)
 *
 * Parameter names in comments are the official object-dictionary names.
 */

/** Socket 1 parameters. The Eve Single only has socket 1. */
export const PARAM = {
  /** OD_mainNormalMaxCurrent - writable socket current limit in A. The pause/resume lever. */
  NORMAL_MAX_CURRENT: '2129_0',
  /** OD_mainActiveMaxCurrent - the limit the charger is actually applying, in A. Read-only. */
  ACTIVE_MAX_CURRENT: '212C_0',
  /** socket1_StateMain - CSM state machine, see MAIN_STATE. */
  MAIN_STATE: '2501_1',
  /** socket1_StateSocket - CPRO power state, see POWER_STATE. */
  SOCKET_STATE: '2501_3',
  /** socket1_StateMode3 - IEC 61851 Mode 3 pilot state, see MODE3_STATE. */
  MODE3_STATE: '2501_4',
  /** meter1_powerRealSum - total real power in W. */
  REAL_POWER_SUM: '2221_16',
  /** meter1_currentL1/L2/L3 in A. */
  CURRENT_L1: '2221_A',
  CURRENT_L2: '2221_B',
  CURRENT_L3: '2221_C',
  /** meter1_voltageL1N in V. */
  VOLTAGE_L1: '2221_3',
  /** OD_sysNumSockets */
  NUM_SOCKETS: '205E_0',
  /** OD_sysFeatureEnabled - licence bitmask, see LICENSE. */
  LICENSES: '21A2_0',
  /** OD_sysUpTime */
  UPTIME: '2060_0',
} as const;

/** Every parameter the plugin polls on each cycle. Kept deliberately short: the
 *  charger is known to become unstable when hammered with large property reads. */
export const POLLED_PARAMS: readonly string[] = [
  PARAM.NORMAL_MAX_CURRENT,
  PARAM.ACTIVE_MAX_CURRENT,
  PARAM.MAIN_STATE,
  PARAM.SOCKET_STATE,
  PARAM.MODE3_STATE,
  PARAM.REAL_POWER_SUM,
  PARAM.CURRENT_L1,
  PARAM.CURRENT_L2,
  PARAM.CURRENT_L3,
];

/**
 * Lowest current the IEC 61851 pilot can signal. Below this the charger cannot
 * offer a valid duty cycle, so the car stops drawing. Writing 0 A is how you pause.
 */
export const MIN_CHARGE_CURRENT_A = 6;

/** Value written to NORMAL_MAX_CURRENT to pause charging. */
export const PAUSE_CURRENT_A = 0;

/** Absolute bounds accepted by the charger for NORMAL_MAX_CURRENT. */
export const MAX_CHARGE_CURRENT_A = 32;

/** socket1_StateMode3 - IEC 61851 pilot states. C2/D2 mean the car has closed S2 and is charging. */
export const MODE3_STATE: Record<number, string> = {
  160: 'A (no vehicle)',
  161: 'A1',
  162: 'A1',
  177: 'B1 (vehicle connected, not ready)',
  178: 'B2 (vehicle connected, charger ready)',
  193: 'C1 (vehicle ready, power off)',
  194: 'C2 (charging)',
  209: 'D1',
  210: 'D2 (charging, ventilation)',
  224: 'E (error)',
  240: 'F (error)',
};

/** Mode 3 states in which the vehicle has requested power (S2 closed). */
export const MODE3_CHARGING_STATES: readonly number[] = [193, 194, 209, 210];

/** Mode 3 states in which a vehicle is physically plugged in. */
export const MODE3_CONNECTED_STATES: readonly number[] = [177, 178, 193, 194, 209, 210];

/** socket1_StateSocket - CPRO power states. */
export const POWER_STATE: Record<number, string> = {
  0: 'Normal Operation',
  1: 'Inactive',
  2: 'Connected ISO15118',
  3: 'Wait for EV Connect',
  4: 'EV Connected',
  5: 'Active',
  6: 'Wait for S2 Close',
  7: 'Wait for S2 Open',
  8: 'Suspended',
  9: 'Ventilating',
};

/** socket1_StateMain - the charger's main state machine. */
export const MAIN_STATE: Record<number, string> = {
  [-1]: 'Illegal',
  0: 'Unknown',
  1: 'Booting',
  2: 'Available',
  3: 'Cable Connected',
  4: 'Cable Connected Timeout',
  5: 'EV Connected',
  6: 'Button Activated',
  7: 'NFC Available',
  8: 'NFC Authorised',
  9: 'Wait for EV Connect',
  10: 'Charging Test Relays',
  11: 'Charging Power Off',
  12: 'Charging Power Off Low Max Current',
  13: 'Charging Power Starting',
  14: 'Charging Power On',
  15: 'Charging Power On Simplified',
  16: 'Charging Wait for EV Reconnect',
  17: 'Charging Terminating',
  18: 'Charging Wakeup',
  19: 'Wait for Disconnect',
  20: 'Wait for Release Authorisation',
  21: 'Charging Recover from Outage',
  22: 'Error',
  23: 'Error Message',
  24: 'Error Message Cable not Supported',
  25: 'Error Illegal Mode 3',
  26: 'Error Too Many Restarts',
  27: 'Error Charging',
  28: 'Error Charging Overcurrent',
  29: 'Error Charging HF Contactor Switching',
  30: 'Error S2 Not Opened',
  31: 'Error Protective Earth',
  32: 'Error Relays',
  33: 'Error Low Supply Voltage',
  34: 'Error Internal Voltage',
  35: 'Error Powermeter',
  36: 'Error Temperature',
  37: 'Suspended',
  38: 'Inoperative',
  39: 'Reserved',
  40: 'Error Charging RCD Signaled',
  41: 'Charging Power Off Ventilating',
  42: 'Charging Power Off Suspended',
  43: 'Charging Power Off Phase Change',
  44: 'Wait for Start Metervalue',
  45: 'Wait for Stop Metervalue',
  46: 'Error Socket Motor',
  47: 'Cable Connected Type E',
  48: 'Cable Connected Timeout Type E',
  49: 'Charging Type E',
  50: 'Wait for Disconnect Type E',
  51: 'Charging Suspended Type E',
  52: 'Charging Low Max Current Type E',
  53: 'Invalid Card',
  54: 'EV Connected Unauthorized',
  55: 'Wait for Disconnect PP',
};

/** OD_sysFeatureEnabled bitmask values. */
export const LICENSE: Record<string, number> = {
  LoadBalancing_SCN: 1,
  LoadBalancing_Static: 2,
  /** Required for the Modbus TCP slave interface. */
  LoadBalancing_Active: 4,
  HighPowerSockets: 16,
  RFIDReader: 256,
  PersonalizedDisplay: 4096,
  Mobile3G4G: 65536,
  Payment_QRCode: 131072,
  Payment_GiroE: 1048576,
  Expose_SmartMeterData: 16777216,
  ObjectID: 2147483648,
};

/** Decode the licence bitmask into names. */
export function decodeLicenses(mask: number): string[] {
  return Object.entries(LICENSE)
    .filter(([, bit]) => (mask & bit) === bit)
    .map(([name]) => name);
}

export function describeMode3(value: number | null): string {
  if (value === null) {
    return 'unknown';
  }
  return MODE3_STATE[value] ?? `unknown (${value})`;
}

export function describeMainState(value: number | null): string {
  if (value === null) {
    return 'unknown';
  }
  return MAIN_STATE[value] ?? `unknown (${value})`;
}

export function describePowerState(value: number | null): string {
  if (value === null) {
    return 'unknown';
  }
  return POWER_STATE[value] ?? `unknown (${value})`;
}

/**
 * Model id -> marketing name, from the Home Assistant integration's
 * ALFEN_PRODUCT_MAP. Used to show something readable in the Home app.
 */
export const PRODUCT_MAP: Record<string, string> = {
  'NG900-60503': 'Eve Single S-line, 1 phase, LED, type 2 socket',
  'NG900-60505': 'Eve Single S-line, 1 phase, LED, type 2 socket shutters',
  'NG900-60507': 'Eve Single S-line, 1 phase, LED, tethered cable',
  'NG910-60003': 'Eve Single Pro-line, 1 phase, display, type 2 socket',
  'NG910-60005': 'Eve Single Pro-line FR, 1 phase, display, type 2 shutters',
  'NG910-60007': 'Eve Single Pro-line, 1 phase, display, tethered cable',
  'NG910-60023': 'Eve Single Pro-line, 3 phase, display, type 2 socket',
  'NG910-60025': 'Eve Single Pro-line FR, 3 phase, display, type 2 shutters',
  'NG910-60027': 'Eve Single Pro-line, 3 phase, display, tethered cable',
  'NG910-60123': 'Eve Single Pro-Line DE, 3 phase, display, type 2 socket',
  'NG910-60127': 'Eve Single Pro-Line DE, 3 phase, display, tethered cable',
  'NG910-60503': 'Eve Single S-line, 1 phase, LED, type 2 socket',
  'NG910-60505': 'Eve Single S-line, 1 phase, LED, type 2 shutters',
  'NG910-60507': 'Eve Single S-line, 1 phase, LED, tethered cable',
  'NG910-60523': 'Eve Single S-line, 3 phase, LED, type 2 socket',
  'NG910-60525': 'Eve Single S-line, 3 phase, LED, type 2 shutters',
  'NG910-60527': 'Eve Single S-line, 3 phase, LED, tethered cable',
  'NG910-60553': 'Eve Single S-line, 1 phase, LED, RFID, type 2 socket',
  'NG910-60555': 'Eve Single S-line, 3 phase, LED, RFID, type 2 shutters',
  'NG910-60557': 'Eve Single S-line, 3 phase, LED, RFID, tethered cable',
  'NG910-60573': 'Eve Single S-line, 3 phase, LED, GPRS, type 2 socket',
  'NG910-60575': 'Eve Single S-line, 3 phase, LED, GPRS, type 2 shutters',
  'NG910-60577': 'Eve Single S-line, 3 phase, LED, GPRS, tethered cable',
  'NG910-60583': 'Eve Single S-line, 3 phase, LED, RFID, type 2 socket',
  'NG910-60585': 'Eve Single S-line, 3 phase, LED, RFID, type 2 shutters',
  'NG910-60587': 'Eve Single S-line, 3 phase, LED, RFID, type 2 tethered cable',
  'NG910-60593': 'Eve Single S-line, 3 phase, LED, GPRS, type 2 socket',
  'NG910-60595': 'Eve Single S-line, 3 phase, LED, GPRS, type 2 shutters',
  'NG910-60597': 'Eve Single S-line, 3 phase, LED, GPRS, type 2 tethered cable',
  'NG920-61031': 'Eve Double Pro-line, 2 x type 2 socket, 1 phase, max. 1x32A input current',
  'NG920-61032': 'Eve Double Pro-line, 2 x type 2 socket, 2 phase, max. 1x32A input current',
  'NG920-61021': 'Eve Double Pro-line, 2 x type 2 socket, 3 phase, max. 1x32A input current',
  'NG920-61022': 'Eve Double Pro-line, 2 x type 2 socket, 3 phase, max. 2x32A input current',
  'NG920-61001': 'Eve Double Pro-line, 3 phase, 2x socket Type 2, single feeder, RCD Type A',
  'NG920-61002': 'Eve Double Pro-line, 3 phase, 2x socket Type 2, dual feeder, RCD Type A',
  'NG920-61011': 'Eve Double Pro-line, 2 x type 2 socket, 1-phase, max. 1x32A input current, RCD B 3F 1C T2, Display',
  'NG920-61012': 'Eve Double Pro-line, 2 x type 2 socket, 1-phase, max. 2x32A input current, RCD B 3F 1C T2, Display',
  'NG920-61101': 'Eve Double Pro-line DE, 2 x type 2 socket, 3-phase, max. 1x32A input current, RCD B 3F 1C T2, Display',
  'NG920-61102': 'Eve Double Pro-line DE, 2 x type 2 socket, 3-phase, max. 2x32A input current, RCD B 3F 1C T2, Display',
  'NG920-61205': 'Eve Double Pro-line FR, 3 phase, Display, 2x socket Type 2S (shutters), max. 1x32A input current',
  'NG920-61206': 'Eve Double Pro-line FR, 3 phase, Display, 2x socket Type 2S (shutters), max. 2x32A input current',
  'NG920-61215': 'Eve Double Pro-line FR, 1 phase, Display, 2x socket Type 2S (shutters), max. 1x32A input current',
  'NG920-61216': 'Eve Double Pro-line FR, 1 phase, Display, 2x socket Type 2S (shutters), max. 2x32A input current',
};

/** Friendly product name for a model id, falling back to the id itself. */
export function describeModel(modelId: string): string {
  return PRODUCT_MAP[modelId] ?? modelId;
}
