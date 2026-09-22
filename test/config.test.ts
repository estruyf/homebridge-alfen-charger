import { ConfigError, parseConfig } from '../src/config';

const valid = { platform: 'AlfenCharger', host: '192.168.1.50', password: 'secret' };

describe('parseConfig', () => {
  it('applies the documented defaults', () => {
    const config = parseConfig(valid);
    expect(config.chargeCurrent).toBe(16);
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
  ])('rejects %p', (raw, expected) => {
    expect(() => parseConfig(raw as never)).toThrow(ConfigError);
    expect(() => parseConfig(raw as never)).toThrow(expected);
  });

  it('clamps the charge current to what the charger accepts', () => {
    expect(parseConfig({ ...valid, chargeCurrent: 2 }).chargeCurrent).toBe(6);
    expect(parseConfig({ ...valid, chargeCurrent: 99 }).chargeCurrent).toBe(32);
    expect(parseConfig({ ...valid, chargeCurrent: 10 }).chargeCurrent).toBe(10);
  });

  it('will not poll faster than the charger can cope with', () => {
    expect(parseConfig({ ...valid, pollInterval: 1 }).pollIntervalMs).toBe(10_000);
    expect(parseConfig({ ...valid, pollInterval: 60 }).pollIntervalMs).toBe(60_000);
  });

  it('accepts numbers written as strings, as the UI sometimes stores them', () => {
    const config = parseConfig({ ...valid, chargeCurrent: '20', pollInterval: '45' } as never);
    expect(config.chargeCurrent).toBe(20);
    expect(config.pollIntervalMs).toBe(45_000);
  });

  it('normalises an empty fingerprint to undefined', () => {
    expect(parseConfig({ ...valid, certificateFingerprint: '   ' }).certificateFingerprint).toBeUndefined();
    expect(parseConfig({ ...valid, certificateFingerprint: 'AB:CD' }).certificateFingerprint).toBe('AB:CD');
  });
});
