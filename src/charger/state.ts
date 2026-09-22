import {
  MIN_CHARGE_CURRENT_A,
  MODE3_CHARGING_STATES,
  MODE3_CONNECTED_STATES,
  describeMainState,
  describeMode3,
} from './params';
import type { ChargerState } from './types';

/** Power above which we consider the car to actually be drawing, in W. */
export const DEFAULT_POWER_THRESHOLD_W = 100;

/**
 * Is charging currently allowed?
 *
 * The charger has no start/stop command. A socket limit below the IEC 61851
 * minimum of 6 A leaves the charger unable to signal a valid duty cycle, so the
 * car stops; anything at or above 6 A means charging is permitted.
 */
export function isChargingEnabled(state: ChargerState): boolean | null {
  if (state.maxCurrentA === null) {
    return null;
  }
  return state.maxCurrentA >= MIN_CHARGE_CURRENT_A;
}

/**
 * Is the car actually drawing power?
 *
 * Metered power is the ground truth. Not every unit reports meter values, so we
 * fall back to the Mode 3 pilot state, where C2/D2 mean the vehicle has closed
 * S2 and is taking power.
 */
export function isDrawingPower(
  state: ChargerState,
  thresholdW: number = DEFAULT_POWER_THRESHOLD_W,
): boolean {
  if (state.realPowerW !== null) {
    return state.realPowerW > thresholdW;
  }
  if (state.mode3State !== null) {
    return MODE3_CHARGING_STATES.includes(state.mode3State);
  }
  return false;
}

/** Is a vehicle plugged in at all? */
export function isVehicleConnected(state: ChargerState): boolean {
  if (state.mode3State !== null) {
    return MODE3_CONNECTED_STATES.includes(state.mode3State);
  }
  return false;
}

/** A one-line summary for the log. */
export function summariseState(state: ChargerState): string {
  const parts = [
    `limit=${formatNumber(state.maxCurrentA, 'A')}`,
    `active=${formatNumber(state.activeMaxCurrentA, 'A')}`,
    `power=${formatNumber(state.realPowerW, 'W')}`,
    `mode3=${describeMode3(state.mode3State)}`,
    `main=${describeMainState(state.mainState)}`,
  ];
  return parts.join(' ');
}

function formatNumber(value: number | null, unit: string): string {
  if (value === null) {
    return 'n/a';
  }
  return `${Math.round(value * 10) / 10}${unit}`;
}
