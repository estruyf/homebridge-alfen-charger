import { extractProperties, parseAlfenJson, toNumber } from './alfenJson';
import type { HttpRequest, HttpResponse, HttpTransport } from './http';
import { NodeHttpsTransport } from './http';
import { Mutex, delay } from './mutex';
import { MAX_CHARGE_CURRENT_A, PARAM, POLLED_PARAMS, describeModel } from './params';
import {
  ChargerAuthError,
  ChargerTransportError,
  ChargerWriteVerifyError,
  type ChargerBackend,
  type ChargerDeviceInfo,
  type ChargerState,
  type Logger,
} from './types';

/** POST bodies must be application/json. Only *responses* use alfen/json. */
const JSON_CONTENT_TYPE = 'application/json';

/** Shown in the charger's session list so it is obvious who holds the session. */
const DEFAULT_DISPLAY_NAME = 'Homebridge';

/** How long to wait after a write before reading the value back. */
const WRITE_SETTLE_MS = 750;

export interface AlfenHttpBackendOptions {
  host: string;
  password: string;
  username?: string;
  port?: number;
  timeoutMs?: number;
  displayName?: string;
  certificateFingerprint?: string;
  /** Pause between a write and the confirming read. Lowered in tests. */
  writeSettleMs?: number;
  logger: Logger;
  /** Injected in tests; defaults to a real HTTPS transport. */
  transport?: HttpTransport;
}

/**
 * Talks to the Alfen local HTTPS API.
 *
 * Contract verified against leeyuentuen/alfen_wallbox and LordGaav/alfen-eve:
 *   POST /api/login   {username, password, displayname}   Content-Type: application/json
 *   POST /api/logout  (no body)
 *   GET  /api/prop?ids=<id>[,<id>...]                     -> {version, properties[], total}
 *   POST /api/prop    {"<id>": {"id": "<id>", "value": v}}
 *   GET  /api/info                                        (no authentication needed)
 *
 * The charger keeps exactly one session, so every call is serialised through a
 * mutex and the session is reused until the charger rejects it.
 */
export class AlfenHttpBackend implements ChargerBackend {
  readonly kind = 'http';
  /** The HTTP API is single-session: while we hold it, Eve Connect cannot log in. */
  readonly isExclusive = true;

  private readonly transport: HttpTransport;
  private readonly mutex = new Mutex();
  private readonly log: Logger;
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  private readonly displayName: string;
  private readonly writeSettleMs: number;

  private loggedIn = false;
  /** Session cookie handed out by the charger, if it uses cookie auth. */
  private sessionCookie: string | undefined;
  /** JWT from the login response on firmware that uses bearer tokens. */
  private accessToken: string | undefined;
  private deviceInfo: ChargerDeviceInfo | undefined;
  /**
   * Some firmware wants the written value as a string, some as a raw number.
   * We learn which on the first successful write and stick with it.
   */
  private writeValueAsString = true;

  constructor(options: AlfenHttpBackendOptions) {
    this.host = options.host;
    this.username = options.username ?? 'admin';
    this.password = options.password;
    this.displayName = (options.displayName ?? DEFAULT_DISPLAY_NAME).slice(0, 32);
    this.writeSettleMs = options.writeSettleMs ?? WRITE_SETTLE_MS;
    this.log = options.logger;
    this.transport =
      options.transport ??
      new NodeHttpsTransport({
        host: options.host,
        port: options.port,
        timeoutMs: options.timeoutMs,
        fingerprint: options.certificateFingerprint,
        onFingerprint: (fingerprint, mismatch) => {
          if (mismatch) {
            this.log.error(`Charger certificate fingerprint changed to ${fingerprint}`);
          } else {
            this.log.debug(`Pinned charger certificate SHA-256 ${fingerprint}`);
          }
        },
      });
  }

  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  async connect(): Promise<void> {
    await this.mutex.runExclusive(() => this.ensureSession());
  }

  async disconnect(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (!this.loggedIn) {
        return;
      }
      try {
        await this.request({
          method: 'POST',
          path: '/api/logout',
          headers: { 'Content-Type': JSON_CONTENT_TYPE },
          body: '',
        });
        this.log.debug('Logged out of the charger');
      } catch (err) {
        // A failed logout still means we are giving up the session locally.
        this.log.warn(`Logout failed, dropping the session anyway: ${describeError(err)}`);
      } finally {
        this.clearSession();
        // Close the TCP connection so the charger frees the session slot; the
        // Home Assistant integration does the same after logging out.
        this.transport.closeConnections();
      }
    });
  }

  async getDeviceInfo(): Promise<ChargerDeviceInfo> {
    if (this.deviceInfo) {
      return this.deviceInfo;
    }
    return this.mutex.runExclusive(async () => {
      if (this.deviceInfo) {
        return this.deviceInfo;
      }
      // /api/info needs no authentication, so it is safe even before login.
      const response = await this.request({ method: 'GET', path: '/api/info' });
      const payload = parseAlfenJson<Record<string, unknown>>(response.body) ?? {};
      this.deviceInfo = {
        identity: asString(payload.Identity) ?? this.host,
        model: describeModel(asString(payload.Model) ?? 'Alfen Wallbox'),
        modelId: asString(payload.Model) ?? 'unknown',
        firmwareVersion: asString(payload.FWVersion) ?? 'unknown',
        objectId: asString(payload.ObjectId) ?? 'unknown',
        type: asString(payload.Type) ?? 'unknown',
      };
      return this.deviceInfo;
    });
  }

  async readState(): Promise<ChargerState> {
    return this.mutex.runExclusive(async () => {
      const properties = await this.readProperties(POLLED_PARAMS);
      return {
        maxCurrentA: toNumber(properties.get(PARAM.NORMAL_MAX_CURRENT)),
        activeMaxCurrentA: toNumber(properties.get(PARAM.ACTIVE_MAX_CURRENT)),
        realPowerW: toNumber(properties.get(PARAM.REAL_POWER_SUM)),
        currentsA: {
          l1: toNumber(properties.get(PARAM.CURRENT_L1)),
          l2: toNumber(properties.get(PARAM.CURRENT_L2)),
          l3: toNumber(properties.get(PARAM.CURRENT_L3)),
        },
        mode3State: toNumber(properties.get(PARAM.MODE3_STATE)),
        socketState: toNumber(properties.get(PARAM.SOCKET_STATE)),
        mainState: toNumber(properties.get(PARAM.MAIN_STATE)),
        maxPhases: toNumber(properties.get(PARAM.MAX_PHASES)),
        readAt: Date.now(),
      };
    });
  }

  /**
   * Write the socket current limit and confirm it by reading it back.
   *
   * If the read-back disagrees we retry once, flipping the value encoding:
   * the Home Assistant integration sends the value as a string while Alfen's
   * own API notes show a bare number, and firmware differs on which it accepts.
   */
  async setMaxCurrent(amps: number): Promise<void> {
    const target = Math.round(amps);
    if (target < 0 || target > MAX_CHARGE_CURRENT_A) {
      throw new RangeError(`Current limit ${target}A is outside 0-${MAX_CHARGE_CURRENT_A}A`);
    }

    return this.mutex.runExclusive(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await this.writeProperty(PARAM.NORMAL_MAX_CURRENT, target, this.writeValueAsString);
        await delay(this.writeSettleMs);

        const properties = await this.readProperties([PARAM.NORMAL_MAX_CURRENT]);
        const actual = toNumber(properties.get(PARAM.NORMAL_MAX_CURRENT));
        if (actual !== null && Math.round(actual) === target) {
          this.log.debug(`Confirmed ${PARAM.NORMAL_MAX_CURRENT} = ${target}A`);
          return;
        }

        if (attempt === 1) {
          this.log.warn(
            `Charger reported ${actual ?? 'no value'}A after writing ${target}A, retrying ` +
              `with the value as a ${this.writeValueAsString ? 'number' : 'string'}`,
          );
          // Flip the encoding for the retry and remember it if the retry works.
          this.writeValueAsString = !this.writeValueAsString;
        } else {
          throw new ChargerWriteVerifyError(
            `Charger did not accept a current limit of ${target}A (reads back as ${actual ?? 'null'}A)`,
            target,
            actual,
          );
        }
      }
    });
  }

  // ---------------------------------------------------------------- internals

  /** Read a set of parameters. Caller must hold the mutex. */
  private async readProperties(ids: readonly string[]): Promise<Map<string, unknown>> {
    await this.ensureSession();
    const query = encodeURIComponent(ids.join(','));
    const response = await this.requestWithReauth({
      method: 'GET',
      path: `/api/prop?ids=${query}`,
    });
    return extractProperties(parseAlfenJson(response.body));
  }

  /** Write a single parameter. Caller must hold the mutex. */
  private async writeProperty(id: string, value: number, asString: boolean): Promise<void> {
    await this.ensureSession();
    const body = JSON.stringify({ [id]: { id, value: asString ? String(value) : value } });
    this.log.debug(`POST /api/prop ${body}`);
    await this.requestWithReauth({
      method: 'POST',
      path: '/api/prop',
      headers: { 'Content-Type': JSON_CONTENT_TYPE },
      body,
    });
  }

  /** Log in if we are not holding a session. Caller must hold the mutex. */
  private async ensureSession(): Promise<void> {
    if (this.loggedIn) {
      return;
    }
    await this.login();
  }

  private async login(): Promise<void> {
    this.log.debug(`Logging in to ${this.host} as ${this.username}`);
    const response = await this.request({
      method: 'POST',
      path: '/api/login',
      headers: { 'Content-Type': JSON_CONTENT_TYPE },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
        displayname: this.displayName,
      }),
    });

    if (response.statusCode === 401) {
      throw new ChargerAuthError(
        'The charger rejected the password. Use the charger\'s admin password, the same one the Eve Connect app uses.',
        response.statusCode,
      );
    }
    if (response.statusCode === 403) {
      // The charger keeps one session. A 403 on login almost always means
      // something else is holding it - usually the Eve Connect app.
      throw new ChargerAuthError(
        'The charger refused a new session. It allows only one at a time, so another client is probably ' +
          'connected - close the Eve Connect app and try again.',
        response.statusCode,
      );
    }
    assertOk(response, 'login');

    this.captureSessionCookie(response);
    const payload = parseAlfenJson<Record<string, unknown>>(response.body);
    const token = payload && asString(payload.access);
    if (token) {
      this.accessToken = token;
      this.log.debug('Charger issued a bearer token for this session');
    }

    this.loggedIn = true;
    this.log.debug('Logged in to the charger');
  }

  /**
   * Perform a request, and if the charger says the session is gone, log in once
   * and replay it. Caller must hold the mutex.
   */
  private async requestWithReauth(request: HttpRequest): Promise<HttpResponse> {
    const response = await this.request(request);
    if (!isAuthFailure(response.statusCode)) {
      assertOk(response, `${request.method} ${request.path}`);
      return response;
    }

    this.log.debug(`Session expired (HTTP ${response.statusCode}), logging in again`);
    this.clearSession();
    await this.login();

    const retry = await this.request(request);
    if (isAuthFailure(retry.statusCode)) {
      this.clearSession();
      throw new ChargerAuthError(
        `Charger still refused the request after re-authenticating (HTTP ${retry.statusCode})`,
        retry.statusCode,
      );
    }
    assertOk(retry, `${request.method} ${request.path}`);
    return retry;
  }

  /** Send a request with the current session credentials attached. */
  private async request(request: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...request.headers };
    if (this.sessionCookie) {
      headers.Cookie = this.sessionCookie;
    }
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    try {
      return await this.transport.send({ ...request, headers });
    } catch (err) {
      // A dead socket means the session is gone too.
      this.loggedIn = false;
      throw new ChargerTransportError(
        `${request.method} ${request.path} failed: ${describeError(err)}`,
      );
    }
  }

  private captureSessionCookie(response: HttpResponse): void {
    const raw = response.headers['set-cookie'];
    if (!raw) {
      return;
    }
    const cookies = Array.isArray(raw) ? raw : [raw];
    for (const cookie of cookies) {
      const [pair] = cookie.split(';');
      if (pair && pair.trim().startsWith('session=')) {
        this.sessionCookie = pair.trim();
        this.log.debug('Stored the charger session cookie');
        return;
      }
    }
  }

  private clearSession(): void {
    this.loggedIn = false;
    this.sessionCookie = undefined;
    this.accessToken = undefined;
  }
}

function isAuthFailure(statusCode: number): boolean {
  // The Home Assistant integration keys off 401; LordGaav's client sees 403 on
  // some firmware. Treat both as "log in again".
  return statusCode === 401 || statusCode === 403;
}

function assertOk(response: HttpResponse, what: string): void {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    // Include whatever the charger said; it often explains the refusal, and a
    // bare status code leaves nothing to go on.
    const detail = response.body.trim().replace(/\s+/g, ' ').slice(0, 200);
    throw new ChargerTransportError(
      `${what} returned HTTP ${response.statusCode}${detail ? `: ${detail}` : ''}`,
      response.statusCode,
    );
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Error text that can never contain the password. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
