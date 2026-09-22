import { AlfenHttpBackend } from '../src/charger/alfenHttpBackend';
import { PARAM } from '../src/charger/params';
import { ChargerAuthError, ChargerTransportError, ChargerWriteVerifyError } from '../src/charger/types';
import { FakeTransport, RecordingLogger, json, propsResponse } from './fakeTransport';

const PASSWORD = 'sup3r-s3cret';

function makeBackend(transport: FakeTransport, logger = new RecordingLogger()) {
  return {
    backend: new AlfenHttpBackend({
      host: '192.168.1.50',
      password: PASSWORD,
      displayName: 'Homebridge',
      // No need to wait for the charger to settle against a fake transport.
      writeSettleMs: 0,
      logger,
      transport,
    }),
    logger,
  };
}

/** A transport that logs in cleanly and answers property reads from a store. */
function workingTransport(store: Record<string, unknown>): FakeTransport {
  const transport = new FakeTransport();
  transport
    .on('POST /api/login', () => json(200, {}, { 'set-cookie': 'session=abc123; Path=/' }))
    .on('POST /api/logout', () => json(200, ''))
    .on('GET /api/info', () =>
      json(200, {
        Identity: 'ACE0123456',
        FWVersion: '6.4.0-4192',
        Model: 'NG910-60023',
        ObjectId: 'obj-1',
        Type: 'NG910',
      }),
    )
    .on('GET /api/prop', (request) => {
      const ids = decodeURIComponent(request.path.split('ids=')[1] ?? '').split(',');
      const values: Record<string, unknown> = {};
      for (const id of ids) {
        if (id in store) {
          values[id] = store[id];
        }
      }
      return propsResponse(values);
    })
    .on('POST /api/prop', (request) => {
      const payload = JSON.parse(request.body ?? '{}') as Record<string, { id: string; value: unknown }>;
      for (const entry of Object.values(payload)) {
        store[entry.id] = Number(entry.value);
      }
      return json(200, '');
    });
  return transport;
}

describe('login', () => {
  it('posts the documented login payload as application/json', async () => {
    const transport = workingTransport({});
    const { backend } = makeBackend(transport);

    await backend.connect();

    const [login] = transport.matching('POST /api/login');
    expect(login.path).toBe('/api/login');
    expect(login.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(login.body!)).toEqual({
      username: 'admin',
      password: PASSWORD,
      displayname: 'Homebridge',
    });
  });

  it('reuses the session instead of logging in for every call', async () => {
    const transport = workingTransport({ [PARAM.NORMAL_MAX_CURRENT]: 16 });
    const { backend } = makeBackend(transport);

    await backend.connect();
    await backend.readState();
    await backend.readState();

    expect(transport.matching('POST /api/login')).toHaveLength(1);
  });

  it('sends the session cookie on later requests', async () => {
    const transport = workingTransport({ [PARAM.NORMAL_MAX_CURRENT]: 16 });
    const { backend } = makeBackend(transport);

    await backend.readState();

    const [read] = transport.matching('GET /api/prop');
    expect(read.headers?.Cookie).toBe('session=abc123');
  });

  it('sends a bearer token when the firmware returns one', async () => {
    const transport = workingTransport({ [PARAM.NORMAL_MAX_CURRENT]: 16 });
    transport.on('POST /api/login', () => json(200, { access: 'jwt-token-value' }));
    const { backend } = makeBackend(transport);

    await backend.readState();

    const [read] = transport.matching('GET /api/prop');
    expect(read.headers?.Authorization).toBe('Bearer jwt-token-value');
  });

  it('raises a clear auth error on a wrong password', async () => {
    const transport = new FakeTransport().on('POST /api/login', () => json(401, ''));
    const { backend } = makeBackend(transport);

    await expect(backend.connect()).rejects.toBeInstanceOf(ChargerAuthError);
    await expect(backend.connect()).rejects.toThrow(/rejected the password/);
  });

  it('explains a 403 on login as the single-session limit, not a bad password', async () => {
    // This is what happens when the Eve Connect app is already connected.
    const transport = new FakeTransport().on('POST /api/login', () => json(403, ''));
    const { backend } = makeBackend(transport);

    await expect(backend.connect()).rejects.toThrow(/only one at a time/);
    await expect(backend.connect()).rejects.toThrow(/Eve Connect/);
  });

  it('never puts the password in an error message or the log', async () => {
    const transport = new FakeTransport().on('POST /api/login', () => json(401, ''));
    const { backend, logger } = makeBackend(transport);

    await expect(backend.connect()).rejects.toThrow(/rejected the password/);
    await expect(backend.connect()).rejects.not.toThrow(new RegExp(PASSWORD));
    expect(logger.text).not.toContain(PASSWORD);
  });
});

describe('readState', () => {
  it('requests exactly the polled parameters via ids=', async () => {
    const transport = workingTransport({});
    const { backend } = makeBackend(transport);

    await backend.readState();

    const [read] = transport.matching('GET /api/prop');
    const ids = decodeURIComponent(read.path.split('ids=')[1]).split(',');
    expect(ids).toContain(PARAM.NORMAL_MAX_CURRENT);
    expect(ids).toContain(PARAM.MODE3_STATE);
    expect(ids).toContain(PARAM.REAL_POWER_SUM);
    expect(read.method).toBe('GET');
  });

  it('maps the response onto the state shape', async () => {
    const transport = workingTransport({
      [PARAM.NORMAL_MAX_CURRENT]: 16,
      [PARAM.ACTIVE_MAX_CURRENT]: 15.8,
      [PARAM.REAL_POWER_SUM]: 3680.25,
      [PARAM.MODE3_STATE]: 194,
      [PARAM.SOCKET_STATE]: 5,
      [PARAM.MAIN_STATE]: 14,
      [PARAM.CURRENT_L1]: 16.1,
      [PARAM.CURRENT_L2]: 0,
      [PARAM.CURRENT_L3]: 0,
    });
    const { backend } = makeBackend(transport);

    const state = await backend.readState();

    expect(state.maxCurrentA).toBe(16);
    expect(state.activeMaxCurrentA).toBe(15.8);
    expect(state.realPowerW).toBe(3680.25);
    expect(state.mode3State).toBe(194);
    expect(state.socketState).toBe(5);
    expect(state.mainState).toBe(14);
    expect(state.currentsA).toEqual({ l1: 16.1, l2: 0, l3: 0 });
    expect(state.readAt).toBeGreaterThan(0);
  });

  it('reports null for parameters the charger omits', async () => {
    const transport = workingTransport({ [PARAM.NORMAL_MAX_CURRENT]: 16 });
    const { backend } = makeBackend(transport);

    const state = await backend.readState();

    expect(state.maxCurrentA).toBe(16);
    expect(state.realPowerW).toBeNull();
    expect(state.mode3State).toBeNull();
  });

  it('copes with a malformed body containing nan and a trailing comma', async () => {
    const transport = workingTransport({});
    transport.on('GET /api/prop', () =>
      json(
        200,
        `{"version":2,"properties":[{"id":"${PARAM.REAL_POWER_SUM}","value":nan},{"id":"${PARAM.NORMAL_MAX_CURRENT}","value":6},],"total":2}`,
      ),
    );
    const { backend } = makeBackend(transport);

    const state = await backend.readState();

    expect(state.realPowerW).toBeNull();
    expect(state.maxCurrentA).toBe(6);
  });

  it('surfaces a 500 as a transport error', async () => {
    const transport = workingTransport({});
    transport.on('GET /api/prop', () => json(500, 'boom'));
    const { backend } = makeBackend(transport);

    await expect(backend.readState()).rejects.toBeInstanceOf(ChargerTransportError);
  });
});

describe('session recovery', () => {
  it.each([401, 403])('logs in again and replays the request after HTTP %i', async (status) => {
    const transport = workingTransport({ [PARAM.NORMAL_MAX_CURRENT]: 16 });
    let served = 0;
    const store = { [PARAM.NORMAL_MAX_CURRENT]: 16 };
    transport.on('GET /api/prop', () => {
      served++;
      // First read after connecting hits an expired session.
      return served === 1 ? json(status, '') : propsResponse(store);
    });
    const { backend } = makeBackend(transport);

    const state = await backend.readState();

    expect(state.maxCurrentA).toBe(16);
    expect(transport.matching('POST /api/login')).toHaveLength(2);
    expect(transport.matching('GET /api/prop')).toHaveLength(2);
  });

  it('gives up if the charger still refuses after re-authenticating', async () => {
    const transport = workingTransport({});
    transport.on('GET /api/prop', () => json(401, ''));
    const { backend } = makeBackend(transport);

    await expect(backend.readState()).rejects.toBeInstanceOf(ChargerAuthError);
    // One initial login plus one retry login, then it stops.
    expect(transport.matching('POST /api/login')).toHaveLength(2);
  });

  it('logs in again on the next call after a socket error', async () => {
    const store = { [PARAM.NORMAL_MAX_CURRENT]: 16 };
    const transport = workingTransport(store);
    let calls = 0;
    transport.on('GET /api/prop', () => {
      calls++;
      if (calls === 1) {
        throw new Error('ECONNRESET');
      }
      return propsResponse(store);
    });
    const { backend } = makeBackend(transport);

    await expect(backend.readState()).rejects.toBeInstanceOf(ChargerTransportError);
    await backend.readState();

    expect(transport.matching('POST /api/login')).toHaveLength(2);
  });
});

describe('setMaxCurrent', () => {
  it('writes 2129_0 in the documented payload shape and confirms it', async () => {
    const store: Record<string, unknown> = { [PARAM.NORMAL_MAX_CURRENT]: 0 };
    const transport = workingTransport(store);
    const { backend } = makeBackend(transport);

    await backend.setMaxCurrent(16);

    const [write] = transport.matching('POST /api/prop');
    expect(write.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(write.body!)).toEqual({
      [PARAM.NORMAL_MAX_CURRENT]: { id: PARAM.NORMAL_MAX_CURRENT, value: '16' },
    });
    // Read back to verify.
    expect(transport.matching('GET /api/prop')).toHaveLength(1);
    expect(store[PARAM.NORMAL_MAX_CURRENT]).toBe(16);
  });

  it('writes 0 A to pause charging', async () => {
    const store: Record<string, unknown> = { [PARAM.NORMAL_MAX_CURRENT]: 16 };
    const transport = workingTransport(store);
    const { backend } = makeBackend(transport);

    await backend.setMaxCurrent(0);

    expect(store[PARAM.NORMAL_MAX_CURRENT]).toBe(0);
  });

  it('retries once with a numeric value when the string form does not stick', async () => {
    const store: Record<string, unknown> = { [PARAM.NORMAL_MAX_CURRENT]: 0 };
    const transport = workingTransport(store);
    // Firmware that only accepts a raw number, ignoring the string form.
    transport.on('POST /api/prop', (request) => {
      const payload = JSON.parse(request.body ?? '{}') as Record<string, { id: string; value: unknown }>;
      for (const entry of Object.values(payload)) {
        if (typeof entry.value === 'number') {
          store[entry.id] = entry.value;
        }
      }
      return json(200, '');
    });
    const { backend } = makeBackend(transport);

    await backend.setMaxCurrent(16);

    const writes = transport.matching('POST /api/prop');
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0].body!)[PARAM.NORMAL_MAX_CURRENT].value).toBe('16');
    expect(JSON.parse(writes[1].body!)[PARAM.NORMAL_MAX_CURRENT].value).toBe(16);
    expect(store[PARAM.NORMAL_MAX_CURRENT]).toBe(16);
  });

  it('remembers the encoding that worked, so the next write succeeds first time', async () => {
    const store: Record<string, unknown> = { [PARAM.NORMAL_MAX_CURRENT]: 0 };
    const transport = workingTransport(store);
    transport.on('POST /api/prop', (request) => {
      const payload = JSON.parse(request.body ?? '{}') as Record<string, { id: string; value: unknown }>;
      for (const entry of Object.values(payload)) {
        if (typeof entry.value === 'number') {
          store[entry.id] = entry.value;
        }
      }
      return json(200, '');
    });
    const { backend } = makeBackend(transport);

    await backend.setMaxCurrent(16);
    const afterFirst = transport.matching('POST /api/prop').length;
    await backend.setMaxCurrent(6);

    expect(transport.matching('POST /api/prop').length - afterFirst).toBe(1);
    expect(store[PARAM.NORMAL_MAX_CURRENT]).toBe(6);
  });

  it('throws after the retry also fails to stick', async () => {
    const store: Record<string, unknown> = { [PARAM.NORMAL_MAX_CURRENT]: 0 };
    const transport = workingTransport(store);
    // A charger that accepts the POST but never applies it, e.g. because load
    // balancing is overriding the socket limit.
    transport.on('POST /api/prop', () => json(200, ''));
    const { backend } = makeBackend(transport);

    await expect(backend.setMaxCurrent(16)).rejects.toBeInstanceOf(ChargerWriteVerifyError);
    expect(transport.matching('POST /api/prop')).toHaveLength(2);
  });

  it('rejects a current outside the charger\'s range without touching the network', async () => {
    const transport = workingTransport({});
    const { backend } = makeBackend(transport);

    await expect(backend.setMaxCurrent(40)).rejects.toBeInstanceOf(RangeError);
    await expect(backend.setMaxCurrent(-1)).rejects.toBeInstanceOf(RangeError);
    expect(transport.requests).toHaveLength(0);
  });
});

describe('serialisation', () => {
  it('never has two requests in flight at once', async () => {
    const store = { [PARAM.NORMAL_MAX_CURRENT]: 16 };
    const transport = workingTransport(store);
    const { backend } = makeBackend(transport);

    await Promise.all([
      backend.readState(),
      backend.readState(),
      backend.getDeviceInfo(),
      backend.readState(),
    ]);

    expect(transport.maxInFlight).toBe(1);
  });

  it('keeps working after a queued call rejects', async () => {
    const store = { [PARAM.NORMAL_MAX_CURRENT]: 16 };
    const transport = workingTransport(store);
    let calls = 0;
    transport.on('GET /api/prop', () => {
      calls++;
      return calls === 1 ? json(500, 'boom') : propsResponse(store);
    });
    const { backend } = makeBackend(transport);

    const results = await Promise.allSettled([backend.readState(), backend.readState()]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(transport.maxInFlight).toBe(1);
  });
});

describe('logout', () => {
  it('posts to /api/logout and drops the pooled connection', async () => {
    const transport = workingTransport({});
    const { backend } = makeBackend(transport);

    await backend.connect();
    await backend.disconnect();

    expect(transport.matching('POST /api/logout')).toHaveLength(1);
    expect(transport.closeCount).toBe(1);
    expect(backend.isLoggedIn).toBe(false);
  });

  it('does nothing when there is no session to release', async () => {
    const transport = workingTransport({});
    const { backend } = makeBackend(transport);

    await backend.disconnect();

    expect(transport.requests).toHaveLength(0);
  });

  it('still drops the session locally if the logout call fails', async () => {
    const transport = workingTransport({});
    transport.on('POST /api/logout', () => {
      throw new Error('ECONNRESET');
    });
    const { backend } = makeBackend(transport);

    await backend.connect();
    await expect(backend.disconnect()).resolves.toBeUndefined();

    expect(backend.isLoggedIn).toBe(false);
  });

  it('logs in again on the next call after a logout', async () => {
    const transport = workingTransport({ [PARAM.NORMAL_MAX_CURRENT]: 16 });
    const { backend } = makeBackend(transport);

    await backend.connect();
    await backend.disconnect();
    await backend.readState();

    expect(transport.matching('POST /api/login')).toHaveLength(2);
  });
});

describe('getDeviceInfo', () => {
  it('reads /api/info without logging in first', async () => {
    const transport = workingTransport({});
    const { backend } = makeBackend(transport);

    const info = await backend.getDeviceInfo();

    expect(info.identity).toBe('ACE0123456');
    expect(info.firmwareVersion).toBe('6.4.0-4192');
    expect(transport.matching('POST /api/login')).toHaveLength(0);
  });

  it('caches the result', async () => {
    const transport = workingTransport({});
    const { backend } = makeBackend(transport);

    await backend.getDeviceInfo();
    await backend.getDeviceInfo();

    expect(transport.matching('GET /api/info')).toHaveLength(1);
  });
});

describe('backend contract', () => {
  it('declares itself exclusive, because the API is single-session', () => {
    const { backend } = makeBackend(workingTransport({}));
    expect(backend.kind).toBe('http');
    expect(backend.isExclusive).toBe(true);
  });
});
