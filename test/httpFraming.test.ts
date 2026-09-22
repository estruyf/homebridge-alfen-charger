import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tls from 'node:tls';
import type { AddressInfo } from 'node:net';

import { NodeHttpsTransport } from '../src/charger/http';

/**
 * These run against a real TLS socket rather than a fake transport, because the
 * thing under test is how Node frames the request on the wire.
 *
 * The charger's embedded HTTP server answers a chunked request body with HTTP
 * 400. Node uses chunked encoding whenever Content-Length is absent, so a
 * missing header breaks every POST against real hardware while passing happily
 * against a Node-based stub. Hence a test at this level.
 */
describe('request framing', () => {
  let server: tls.Server;
  let port: number;
  const seen: { line: string; contentLength: string | null; chunked: boolean }[] = [];

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfen-tls-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-nodes', '-subj', '/CN=alfen-test',
    ], { stdio: 'ignore' });

    server = tls.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      (socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) {
            return;
          }
          const head = buffer.slice(0, headerEnd);
          const contentLength = /content-length:\s*(\d+)/i.exec(head);
          seen.push({
            line: head.split('\r\n')[0],
            contentLength: contentLength ? contentLength[1] : null,
            chunked: /transfer-encoding:\s*chunked/i.test(head),
          });
          const body = '{}';
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: alfen/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
          );
          buffer = '';
        });
        socket.on('error', () => undefined);
      },
    );

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function transport() {
    return new NodeHttpsTransport({ host: '127.0.0.1', port, timeoutMs: 5_000 });
  }

  it('sends Content-Length and never chunked encoding for a POST body', async () => {
    const body = JSON.stringify({ username: 'admin', password: 'secret', displayname: 'Homebridge' });
    const t = transport();
    await t.send({
      method: 'POST',
      path: '/api/login',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    t.closeConnections();

    const request = seen.find((r) => r.line.includes('/api/login'))!;
    expect(request.chunked).toBe(false);
    expect(request.contentLength).toBe(String(Buffer.byteLength(body)));
  });

  it('sends Content-Length: 0 for the empty logout body', async () => {
    const t = transport();
    await t.send({
      method: 'POST',
      path: '/api/logout',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    t.closeConnections();

    const request = seen.find((r) => r.line.includes('/api/logout'))!;
    expect(request.chunked).toBe(false);
    expect(request.contentLength).toBe('0');
  });

  it('sends no body framing at all for a GET', async () => {
    const t = transport();
    await t.send({ method: 'GET', path: '/api/prop?ids=2129_0' });
    t.closeConnections();

    const request = seen.find((r) => r.line.includes('/api/prop'))!;
    expect(request.chunked).toBe(false);
    expect(request.contentLength).toBeNull();
  });

  it('pins the certificate on the very first request, not the second', async () => {
    // A fresh TLSSocket reports encrypted === true before the handshake has
    // finished, so checking that instead of the certificate left the first
    // request of every connection unpinned.
    const t = transport();
    await t.send({ method: 'GET', path: '/api/info' });
    expect(t.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    t.closeConnections();
  });

  it('keeps the same pin across a reused keep-alive socket', async () => {
    const t = transport();
    await t.send({ method: 'GET', path: '/api/info' });
    const first = t.fingerprint;
    await t.send({ method: 'GET', path: '/api/info' });
    expect(t.fingerprint).toBe(first);
    t.closeConnections();
  });
});
