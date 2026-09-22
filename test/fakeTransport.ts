import type { HttpRequest, HttpResponse, HttpTransport } from '../src/charger/http';
import type { Logger } from '../src/charger/types';

export interface RecordedRequest extends HttpRequest {
  /** Order in which the request was started, to prove calls are serialised. */
  startedAt: number;
}

type Handler = (request: HttpRequest, callIndex: number) => HttpResponse | Promise<HttpResponse>;

/** A scriptable stand-in for the HTTPS transport. */
export class FakeTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  closeCount = 0;
  /** Number of requests currently in flight; must never exceed 1. */
  inFlight = 0;
  maxInFlight = 0;

  private handlers = new Map<string, Handler>();
  private fallback: Handler = () => json(200, {});
  private counter = 0;

  /** Register a handler for "METHOD /path" (query string ignored). */
  on(route: string, handler: Handler): this {
    this.handlers.set(route, handler);
    return this;
  }

  onAny(handler: Handler): this {
    this.fallback = handler;
    return this;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push({ ...request, startedAt: this.counter++ });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      // Yield to the event loop so overlapping calls would be visible.
      await Promise.resolve();
      const route = `${request.method} ${request.path.split('?')[0]}`;
      const handler = this.handlers.get(route) ?? this.fallback;
      const index = this.requests.filter(
        (r) => `${r.method} ${r.path.split('?')[0]}` === route,
      ).length - 1;
      return await handler(request, index);
    } finally {
      this.inFlight--;
    }
  }

  closeConnections(): void {
    this.closeCount++;
  }

  /** All requests matching "METHOD /path". */
  matching(route: string): RecordedRequest[] {
    return this.requests.filter((r) => `${r.method} ${r.path.split('?')[0]}` === route);
  }
}

export function json(statusCode: number, body: unknown, headers: Record<string, string | string[]> = {}): HttpResponse {
  return {
    statusCode,
    headers: { 'content-type': 'alfen/json; charset=utf-8', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** Build a /api/prop response in the firmware's version-2 envelope. */
export function propsResponse(values: Record<string, unknown>): ReturnType<typeof json> {
  const properties = Object.entries(values).map(([id, value]) => ({
    id,
    access: 1,
    type: 8,
    len: 0,
    cat: 'generic',
    value,
  }));
  return json(200, { version: 2, properties, total: properties.length });
}

/** Collects log lines so tests can assert on them. */
export class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  debug(message: string): void {
    this.lines.push(`debug ${message}`);
  }
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  get text(): string {
    return this.lines.join('\n');
  }
}
