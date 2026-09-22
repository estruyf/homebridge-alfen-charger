import { fingerprintsMatch } from '../src/charger/http';

describe('fingerprintsMatch', () => {
  it('ignores case and colon separators', () => {
    expect(fingerprintsMatch('AB:CD:EF', 'abcdef')).toBe(true);
    expect(fingerprintsMatch('ab:cd:ef', 'AB:CD:EF')).toBe(true);
  });

  it('rejects a different certificate', () => {
    expect(fingerprintsMatch('AB:CD:EF', 'AB:CD:E0')).toBe(false);
  });
});
