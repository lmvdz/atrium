import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer as createHttpProxyRequest, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * TLS TERMINATION FOR THE DESTINATION SCENARIO — the finding, made runnable.
 *
 * Atrium's production posture is TLS-mandatory by design: `assertSecureTransport`
 * (`packages/auth/src/transport.ts`) refuses to start when the DECLARED origins
 * (`APP_URL`, the realtime origin) are `http://` or `ws://`, and there is
 * deliberately no `ATRIUM_ALLOW_INSECURE=1` escape. `next build` also inlines
 * `NODE_ENV=production` into the compiled bundle, and `@atrium/auth` is compiled
 * INTO that bundle, so the gate cannot be softened at runtime. A genuine
 * production build therefore cannot serve its authenticated routes over loopback
 * `http`/`ws` — it needs `https`/`wss` reaching the browser.
 *
 * So this stands the real posture up rather than routing around it: a single
 * TLS terminator on the public port, presenting one self-signed cert (Playwright
 * runs with `ignoreHTTPSErrors`), fronting the production `next start` (plain
 * http, internal) and the realtime server (plain ws, internal). The browser sees
 * `https://localhost:<TLS_PORT>` and `wss://localhost:<TLS_PORT>/ws`, both matching
 * the `APP_URL` the two server processes boot with — so `assertSecureTransport`
 * is ACTIVE and SATISFIED, which is the production behaviour under test, not a
 * bypass of it.
 *
 * Env: TLS_PORT (public), NEXT_PORT (internal http), WS_PORT (internal ws).
 */

const TLS_PORT = Number(process.env.TLS_PORT ?? 3200);
const NEXT_PORT = Number(process.env.NEXT_PORT ?? 3201);
const WS_PORT = Number(process.env.WS_PORT ?? 4201);

const certDir = join(tmpdir(), 'atrium-destination-tls');
const keyPath = join(certDir, 'key.pem');
const certPath = join(certDir, 'cert.pem');

function ensureCert() {
  if (existsSync(keyPath) && existsSync(certPath)) return;
  mkdirSync(certDir, { recursive: true });
  // A throwaway self-signed cert for localhost. Playwright trusts it via
  // `ignoreHTTPSErrors`; nothing here is a real credential.
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
}

ensureCert();

const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };

// Silence the unused-import lint on the http request-server factory: we proxy
// with `httpRequest`, not by mounting an http server here.
void createHttpProxyRequest;

const proxy = createHttpsServer(tls, (req, res) => {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: NEXT_PORT,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    // next not up yet, or a transient — answer 502 so Playwright keeps polling
    // rather than the proxy crashing.
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream unavailable');
  });
  req.pipe(upstream);
});

// WebSocket upgrades (the realtime socket) tunnel to the plain ws server.
proxy.on('upgrade', (req, clientSocket, head) => {
  const upstream = netConnect(WS_PORT, '127.0.0.1', () => {
    // Replay the upgrade request verbatim — method line, every header (Cookie,
    // Origin, Sec-WebSocket-*), then the buffered head — so the ws server sees
    // exactly what the browser sent, cookie and origin included.
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${headerLines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const drop = () => {
    clientSocket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  clientSocket.on('error', drop);
});

proxy.listen(TLS_PORT, () => {
  console.info(`[destination-tls] https/wss on :${TLS_PORT} → next :${NEXT_PORT}, ws :${WS_PORT}`);
});
