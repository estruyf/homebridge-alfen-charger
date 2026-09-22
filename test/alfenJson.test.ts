import {
  AlfenJsonError,
  extractProperties,
  parseAlfenJson,
  repairAlfenJson,
  toNumber,
} from '../src/charger/alfenJson';

describe('parseAlfenJson', () => {
  it('parses well-formed JSON', () => {
    expect(parseAlfenJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined for an empty body, as sent by logout', () => {
    expect(parseAlfenJson('')).toBeUndefined();
    expect(parseAlfenJson('   \n ')).toBeUndefined();
  });

  it('repairs the trailing comma the firmware emits', () => {
    expect(parseAlfenJson('{"version":2,"properties":[],}')).toEqual({
      version: 2,
      properties: [],
    });
  });

  it('repairs bare nan values in meter readings', () => {
    const raw = '{"version":2,"properties":[{"id":"2221_16","value":nan}]}';
    expect(parseAlfenJson(raw)).toEqual({
      version: 2,
      properties: [{ id: '2221_16', value: null }],
    });
  });

  it('does not rewrite the word nan inside a string', () => {
    const raw = '{"name":"nanny","value":nan}';
    expect(parseAlfenJson(raw)).toEqual({ name: 'nanny', value: null });
  });

  it('throws with a truncated body when the response is not JSON at all', () => {
    expect(() => parseAlfenJson('<html>login required</html>')).toThrow(AlfenJsonError);
  });

  it('leaves valid JSON untouched in the repair pass', () => {
    const valid = '{"a":[1,2,3],"b":"x"}';
    expect(JSON.parse(repairAlfenJson(valid))).toEqual({ a: [1, 2, 3], b: 'x' });
  });
});

describe('extractProperties', () => {
  it('reads the version-2 envelope used by NG9xx firmware', () => {
    const payload = {
      version: 2,
      total: 2,
      properties: [
        { id: '2129_0', access: 3, type: 2, len: 0, cat: 'generic', value: 16 },
        { id: '2221_16', access: 1, type: 8, len: 0, cat: 'meter1', value: 3680.5 },
      ],
    };
    const map = extractProperties(payload);
    expect(map.get('2129_0')).toBe(16);
    expect(map.get('2221_16')).toBe(3680.5);
    expect(map.size).toBe(2);
  });

  it('reads the older version-1 flat object', () => {
    const payload = {
      version: 1,
      count: 1,
      OD_mainNormalMaxCurrent: { id: '2129_0', value: 6 },
    };
    expect(extractProperties(payload).get('2129_0')).toBe(6);
  });

  it('returns an empty map for junk', () => {
    expect(extractProperties(null).size).toBe(0);
    expect(extractProperties('nope').size).toBe(0);
    expect(extractProperties({ version: 2, properties: 'bad' }).size).toBe(0);
  });
});

describe('toNumber', () => {
  it.each([
    [16, 16],
    ['16', 16],
    ['3680.5', 3680.5],
    [0, 0],
    ['0', 0],
  ])('converts %p to %p', (input, expected) => {
    expect(toNumber(input)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['  '], ['abc'], [NaN], [Infinity], [{}]])(
    'returns null for %p',
    (input) => {
      expect(toNumber(input)).toBeNull();
    },
  );
});
