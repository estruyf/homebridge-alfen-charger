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

      // The charger's embedded HTTP server rejects chunked request bodies with
      // HTTP 400, and Node falls back to chunked whenever Content-Length is
      // absent. Both reference clients send it, so always set it explicitly -
      // including the zero-length body that logout posts.
      const bodyBuffer =
        request.body === undefined ? undefined : Buffer.from(request.body, 'utf8');

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
            ...(bodyBuffer === undefined
              ? {}
              : { 'Content-Length': String(bodyBuffer.length) }),
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

        // `encrypted` is true from construction, so it cannot tell us whether the
        // handshake has finished. Ask for the certificate instead: a fresh socket
        // has none yet and must wait for 'secureConnect', while a reused
        // keep-alive socket already has one and can be checked immediately.
        // Getting this wrong lets the first request of a connection go out
        // before the certificate has been pinned.
        if (hasPeerCertificate(tlsSocket)) {
          check();
        } else {
          tlsSocket.once('secureConnect', check);
        }
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new HttpTimeoutError(this.timeoutMs));
      });

      req.on('error', (err) => finish(() => reject(err)));

      if (bodyBuffer !== undefined && bodyBuffer.length > 0) {
        req.write(bodyBuffer);
      }
      req.end();
    });
  }

  closeConnections(): void {
    this.agent.destroy();
  }
}

/** True once the TLS handshake has produced a peer certificate. */
function hasPeerCertificate(socket: TLSSocket): boolean {
  if (typeof socket.getPeerCertificate !== 'function') {
    return false;
  }
  try {
    const cert = socket.getPeerCertificate();
    return Boolean(cert && Object.keys(cert).length > 0);
  } catch {
    return false;
  }
}

/** Compare fingerprints ignoring case and colon separators. */
export function fingerprintsMatch(a: string, b: string): boolean {
  const normalise = (value: string) => value.replace(/:/g, '').toLowerCase();
  return normalise(a) === normalise(b);
}
