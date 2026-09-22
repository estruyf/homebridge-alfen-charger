import * as https from 'node:https';
import type { TLSSocket } from 'node:tls';

/** A single HTTP request, transport-agnostic so tests can inject a fake. */
export interface HttpRequest {
  method: 'GET' | 'POST';
  /** Path including query string, e.g. "/api/prop?ids=2129_0". */
  path: string;
  headers?: Record<string, string>;
  /** Already-serialised request body. */
  body?: string;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Anything that can perform a request against the charger. */
export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
  /** Drop pooled sockets so the charger sees us disconnect. */
  closeConnections(): void;
}

export interface NodeHttpsTransportOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  /**
   * Expected SHA-256 certificate fingerprint. When set, a connection whose
   * certificate does not match is torn down. When omitted the first certificate
   * seen is pinned for the lifetime of the process (trust on first use).
   */
  fingerprint?: string;
  /** Called the first time a certificate is pinned, and on every mismatch. */
  onFingerprint?: (fingerprint: string, pinned: boolean) => void;
}

export class CertificateMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(
      `Charger certificate changed: expected ${expected} but got ${actual}. ` +
        'If the charger was replaced or its firmware reinstalled, clear certificateFingerprint in the config.',
    );
    this.name = 'CertificateMismatchError';
  }
}

export class HttpTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'HttpTimeoutError';
  }
}

/**
 * HTTPS transport for the charger's local API.
 *
 * The charger presents a self-signed certificate, so chain validation is turned
 * off *on this agent only* - never globally via NODE_TLS_REJECT_UNAUTHORIZED.
 * The agent is owned by one backend instance and is only ever used for requests
 * to the configured host. To get some of that safety back we pin the
 * certificate: the first fingerprint we see (or the one configured) must keep
 * matching, so a device swapped in on the same IP is rejected rather than trusted.
 */
export class NodeHttpsTransport implements HttpTransport {
  private readonly agent: https.Agent;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private pinnedFingerprint: string | undefined;
  private readonly onFingerprint: ((fingerprint: string, pinned: boolean) => void) | undefined;

  constructor(options: NodeHttpsTransportOptions) {
    this.host = options.host;
    this.port = options.port ?? 443;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.pinnedFingerprint = options.fingerprint;
    this.onFingerprint = options.onFingerprint;

    this.agent = new https.Agent({
      // Scoped to this agent, which only ever talks to `host`. The certificate
      // pinning below is what actually authenticates the peer.
      rejectUnauthorized: false,
      keepAlive: true,
      // The charger is single-session; one socket is all we ever want.
      maxSockets: 1,
      maxFreeSockets: 1,
      timeout: this.timeoutMs,
    });
  }

  /** The fingerprint currently trusted, once a connection has been made. */
  get fingerprint(): string | undefined {
    return this.pinnedFingerprint;
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const req = https.request(
        {
          host: this.host,
          port: this.port,
          path: request.path,
          method: request.method,
          agent: this.agent,
          headers: {
            Accept: 'application/json, alfen/json, */*',
            ...request.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            finish(() =>
              resolve({
                statusCode: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          });
          res.on('error', (err) => finish(() => reject(err)));
        },
      );

      req.on('socket', (socket) => {
        const tlsSocket = socket as TLSSocket;
        // Only unverified sockets carry a certificate we have not checked yet.
        const check = () => {
          try {
            const cert = tlsSocket.getPeerCertificate();
            const actual = cert?.fingerprint256;
            if (!actual) {
              return;
            }
            if (this.pinnedFingerprint === undefined) {
              this.pinnedFingerprint = actual;
              this.onFingerprint?.(actual, false);
              return;
            }
            if (!fingerprintsMatch(this.pinnedFingerprint, actual)) {
              this.onFingerprint?.(actual, true);
              const err = new CertificateMismatchError(this.pinnedFingerprint, actual);
              tlsSocket.destroy(err);
              finish(() => reject(err));
            }
          } catch {
            // getPeerCertificate can throw on an already-destroyed socket; the
            // request's own error handling covers that case.
          }
        };

        if ((tlsSocket as TLSSocket & { authorized?: boolean }).encrypted) {
          // Reused keep-alive socket: already connected and already checked.
          check();
        } else {
          tlsSocket.once('secureConnect', check);
        }
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new HttpTimeoutError(this.timeoutMs));
      });

      req.on('error', (err) => finish(() => reject(err)));

      if (request.body !== undefined) {
        req.write(request.body);
      }
      req.end();
    });
  }

  closeConnections(): void {
    this.agent.destroy();
  }
}

/** Compare fingerprints ignoring case and colon separators. */
export function fingerprintsMatch(a: string, b: string): boolean {
  const normalise = (value: string) => value.replace(/:/g, '').toLowerCase();
  return normalise(a) === normalise(b);
}
