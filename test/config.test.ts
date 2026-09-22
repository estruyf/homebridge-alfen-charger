import { ConfigError, parseConfig, resolveTargetAmps } from '../src/config';

const valid = { platform: 'AlfenCharger', host: '192.168.1.50', password: 'secret' };

describe('parseConfig', () => {
  it('applies the documented defaults', () => {
    const config = parseConfig(valid);
    expect(config.chargeTarget).toEqual({ kind: 'power', kilowatts: 3.7 });
    expect(config.nominalVoltage).toBe(230);
    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.debug).toBe(false);
    expect(config.name).toBe('Alfen Charger');
  });

  it.each([
    [{ ...valid, host: undefined }, /host/],
    [{ ...valid, host: '  ' }, /host/],
    [{ ...valid, host: 'https://192.168.1.50' }, /without a scheme/],
    [{ ...valid, password: undefined }, /password/],
    [{ ...valid, password: '' }, /password/],
    [{ ...valid, chargePower: 0 }, /greater than 0/],
    [{ ...valid, chargePower: -5 }, /greater than 0/],
  ])('rejects %p', (raw, expected) => {
    expect(() => parseConfig(raw as never)).toThrow(ConfigError);
    expect(() => parseConfig(raw as never)).toThrow(expected);
  });

  it('takes the charge rate in kW', () => {
    expect(parseConfig({ ...valid, chargePower: 5 }).chargeTarget).toEqual({
      kind: 'power',
      kilowatts: 5,
    });
  });

  it('still honours a legacy chargeCurrent in amps', () => {
    expect(parseConfig({ ...valid, chargeCurrent: 20 }).chargeTarget).toEqual({
      kind: 'current',
      amps: 20,
    });
  });

  it('prefers kW when a config somehow has both', () => {
    expect(parseConfig({ ...valid, chargePower: 7.4, chargeCurrent: 10 }).chargeTarget).toEqual({
      kind: 'power',
      kilowatts: 7.4,
    });
  });

  it('clamps a legacy chargeCurrent to what the charger accepts', () => {
    expect(parseConfig({ ...valid, chargeCurrent: 2 }).chargeTarget).toEqual({ kind: 'current', amps: 6 });
    expect(parseConfig({ ...valid, chargeCurrent: 99 }).chargeTarget).toEqual({ kind: 'current', amps: 32 });
  });

  it('will not poll faster than the charger can cope with', () => {
    expect(parseConfig({ ...valid, pollInterval: 1 }).pollIntervalMs).toBe(10_000);
    expect(parseConfig({ ...valid, pollInterval: 60 }).pollIntervalMs).toBe(60_000);
  });

  it('accepts numbers written as strings, as the UI sometimes stores them', () => {
    const config = parseConfig({ ...valid, chargePower: '5.0', pollInterval: '45' } as never);
    expect(config.chargeTarget).toEqual({ kind: 'power', kilowatts: 5 });
    expect(config.pollIntervalMs).toBe(45_000);
  });

  it('clamps an implausible nominal voltage', () => {
    expect(parseConfig({ ...valid, nominalVoltage: 400 }).nominalVoltage).toBe(400);
    expect(parseConfig({ ...valid, nominalVoltage: 5 }).nominalVoltage).toBe(100);
  });

  it('normalises an empty fingerprint to undefined', () => {
    expect(parseConfig({ ...valid, certificateFingerprint: '   ' }).certificateFingerprint).toBeUndefined();
    expect(parseConfig({ ...valid, certificateFingerprint: 'AB:CD' }).certificateFingerprint).toBe('AB:CD');
  });
});

describe('resolveTargetAmps', () => {
  const kw = (kilowatts: number) => ({ kind: 'power' as const, kilowatts });

  it.each([
    [1.4, 6],
    [3.7, 16],
    [5.0, 22],
    [7.4, 32],
  ])('converts %p kW on one phase to %i A', (kilowatts, expected) => {
    // Matches the Eve Connect Maximum Power slider: 1.4-7.4 kW is 6-32 A at 230 V.
    expect(resolveTargetAmps(kw(kilowatts), 1, 230).amps).toBe(expected);
  });

  it.each([
    [11, 16],
    [22, 32],
    [4.1, 6],
  ])('converts %p kW on three phases to %i A', (kilowatts, expected) => {
    expect(resolveTargetAmps(kw(kilowatts), 3, 230).amps).toBe(expected);
  });

  it('clamps above the charger maximum and says so', () => {
    const result = resolveTargetAmps(kw(11), 1, 230);
    expect(result.requestedAmps).toBe(48);
    expect(result.amps).toBe(32);
    expect(result.clamped).toBe(true);
  });

  it('clamps below the charging minimum and says so', () => {
    const result = resolveTargetAmps(kw(0.5), 1, 230);
    expect(result.requestedAmps).toBe(2);
    expect(result.amps).toBe(6);
    expect(result.clamped).toBe(true);
  });

  it('reports no clamping for a rate the socket can deliver', () => {
    expect(resolveTargetAmps(kw(3.7), 1, 230).clamped).toBe(false);
  });

  it('passes a legacy amp target straight through', () => {
    const result = resolveTargetAmps({ kind: 'current', amps: 20 }, 3, 230);
    expect(result.amps).toBe(20);
    expect(result.clamped).toBe(false);
  });

  it('honours a different nominal voltage', () => {
    expect(resolveTargetAmps(kw(3.7), 1, 240).amps).toBe(15);
  });
});
