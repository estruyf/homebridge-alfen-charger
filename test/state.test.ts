import { isChargingEnabled, isDrawingPower, isVehicleConnected, summariseState } from '../src/charger/state';
import type { ChargerState } from '../src/charger/types';

function state(partial: Partial<ChargerState> = {}): ChargerState {
  return {
    maxCurrentA: null,
    activeMaxCurrentA: null,
    realPowerW: null,
    currentsA: { l1: null, l2: null, l3: null },
    mode3State: null,
    socketState: null,
    mainState: null,
    readAt: Date.now(),
    ...partial,
  };
}

describe('isChargingEnabled', () => {
  it.each([
    [0, false],
    [1, false],
    [5, false],
    [5.9, false],
    [6, true],
    [16, true],
    [32, true],
  ])('reports a %iA limit as enabled=%p', (amps, expected) => {
    // 6 A is the IEC 61851 minimum; below it the pilot cannot signal a valid duty cycle.
    expect(isChargingEnabled(state({ maxCurrentA: amps }))).toBe(expected);
  });

  it('is unknown when the charger did not report a limit', () => {
    expect(isChargingEnabled(state())).toBeNull();
  });
});

describe('isDrawingPower', () => {
  it('uses metered power when it is available', () => {
    expect(isDrawingPower(state({ realPowerW: 3680 }))).toBe(true);
    expect(isDrawingPower(state({ realPowerW: 0 }))).toBe(false);
  });

  it('honours the configured threshold', () => {
    expect(isDrawingPower(state({ realPowerW: 50 }), 100)).toBe(false);
    expect(isDrawingPower(state({ realPowerW: 150 }), 100)).toBe(true);
    expect(isDrawingPower(state({ realPowerW: 50 }), 10)).toBe(true);
  });

  it('prefers power over the pilot state when both are present', () => {
    // Pilot says C2 but no power is flowing: the car has stopped by itself.
    expect(isDrawingPower(state({ realPowerW: 0, mode3State: 194 }))).toBe(false);
  });

  it('falls back to the Mode 3 pilot state when the meter is silent', () => {
    expect(isDrawingPower(state({ mode3State: 194 }))).toBe(true); // C2
    expect(isDrawingPower(state({ mode3State: 210 }))).toBe(true); // D2
    expect(isDrawingPower(state({ mode3State: 178 }))).toBe(false); // B2, connected only
    expect(isDrawingPower(state({ mode3State: 160 }))).toBe(false); // A, nothing plugged in
  });

  it('reports false when nothing is known', () => {
    expect(isDrawingPower(state())).toBe(false);
  });
});

describe('isVehicleConnected', () => {
  it.each([
    [160, false],
    [177, true],
    [178, true],
    [193, true],
    [194, true],
    [210, true],
  ])('mode 3 state %i means connected=%p', (mode3State, expected) => {
    expect(isVehicleConnected(state({ mode3State }))).toBe(expected);
  });
});

describe('summariseState', () => {
  it('produces a readable one-liner', () => {
    const line = summariseState(
      state({ maxCurrentA: 16, activeMaxCurrentA: 15.75, realPowerW: 3680.4, mode3State: 194, mainState: 14 }),
    );
    expect(line).toContain('limit=16A');
    expect(line).toContain('active=15.8A');
    expect(line).toContain('C2 (charging)');
    expect(line).toContain('Charging Power On');
  });

  it('shows n/a rather than null', () => {
    expect(summariseState(state())).toContain('limit=n/a');
  });
});
