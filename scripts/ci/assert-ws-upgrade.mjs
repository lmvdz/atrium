/**
 * An authenticated WebSocket upgrade completes through the shipped proxy — and
 * an unauthenticated one does not.
 *
 * ## Why both halves
 *
 * "The upgrade completes" on its own is satisfied by a server that upgrades
 * everybody, which is the failure the upgrade authenticator exists to prevent.
 * So this opens two sockets against the same URL, differing only in whether the
 * request carries the session cookie a real signup produced, and asserts the
 * pair: 101 with a `welcome` frame naming the account, and a refusal.
 *
 * ## Why a hand-rolled handshake instead of a WebSocket library
 *
 * The same reason `stack-client.mjs` uses `node:https`: the connection has to
 * present this deployment's hostname in SNI and in `Host` while connecting to a
 * published port on this machine, and trust the CA that actually signed the
 * certificate — with verification on. Node's global `WebSocket` exposes none of
 * those. `https.request` with `Connection: Upgrade` is the same handshake a
 * browser sends, and reading the raw socket afterwards lets this assert the
 * `Sec-WebSocket-Accept` value rather than trusting a library to have checked
 * it. Frames are small enough to decode by hand for a `welcome` and a reply.
 *
 * ## What it proves about the whole path
 *
 * The socket goes through Caddy's `handle /ws*` block, so a 101 here also means
 * the proxy forwards an upgrade untouched — which nothing had ever checked, and
 * which is not implied by the app's pages working. `Origin` is set to the
 * deployment's own origin because `createRealtimeServer` checks it (a WebSocket
 * handshake is not same-origin protected and carries cookies); the refusal case
 * sends the same `Origin` and no cookie, so the only difference between the two
 * runs is the session.
 *
 * ## Mutations it catches
 *
 * - `handle /ws*` removed from `deploy/Caddyfile`: the upgrade reaches the Next
 *   app instead of the realtime server and never returns 101.
 * - `BETTER_AUTH_SECRET` differing between `app` and `server` in
 *   `docker-compose.yml`: the cookie the web app minted does not validate on
 *   the realtime side, and the authenticated upgrade is refused. Nothing else
 *   in this repository notices that divergence — the two processes each work.
 * - `createUpgradeAuthenticator` weakened to accept an anonymous socket: the
 *   second half fails.
 * - `ATRIUM_WS_URL` regressing to a build-time constant: the URL asserted here
 *   is the deployment's, so a socket that only works against
 *   `ws://localhost:4000` fails.
 * - the `welcome` frame carrying somebody else's session. The identity asserted
 *   is `welcome.user.id` against the id Postgres holds for the address that
 *   signed up — an answer the realtime server did not produce — plus a display
 *   name that is unique per account rather than the constant `CI ws` round 1
 *   found here.
 *
 * ## Which mutation actually reaches this file
 *
 * Not the shared-secret one. `docker-compose.yml` gives `app` and `server` one
 * `BETTER_AUTH_SECRET`, and `assert-stack-config.mjs` compares them across the
 * two running containers — so a stack where they diverge is red three steps
 * before this file runs, and the mutation ledger records it under the check that
 * genuinely fires. The mutation that gets this far is `handle /ws*` removed from
 * `deploy/Caddyfile` (ledger case `no-ws-route`): every page still serves, the
 * configuration is still production, and the upgrade lands on the Next app.
 */

import { createHash, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { queryDatabase, sqlLiteral } from './compose.mjs';
import { check, establishSession, mailpit, report, stackTarget } from './stack-client.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The value RFC 6455 says the server must echo back, computed independently. */
function expectedAccept(key) {
  return createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

/**
 * Open `/ws` and return the handshake plus whatever the server said first.
 *
 * Resolves rather than rejects on a refusal: a refused upgrade is an outcome
 * this file asserts on, not an error.
 */
function upgrade(target, { cookie, timeoutMs = 15_000 } = {}) {
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: target.address,
      port: target.httpsPort,
      servername: target.domain,
      ...(target.ca ? { ca: target.ca } : {}),
      path: '/ws',
      method: 'GET',
      headers: {
        Host: target.domain,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Origin: target.origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

    const timer = setTimeout(() => {
      request.destroy();
      reject(
        new Error(`the upgrade to wss://${target.domain}/ws answered nothing in ${timeoutMs}ms`),
      );
    }, timeoutMs);

    request.on('upgrade', (response, socket, head) => {
      const frames = [];
      let buffer = head ?? Buffer.alloc(0);
      const drain = () => {
        for (;;) {
          const frame = decodeFrame(buffer);
          if (!frame) return;
          buffer = frame.rest;
          if (frame.opcode === 1) frames.push(frame.payload.toString('utf8'));
        }
      };
      drain();
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        drain();
      });
      // Give the server its `welcome` frame, then stop.
      setTimeout(() => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          upgraded: true,
          status: response.statusCode ?? 101,
          accept: response.headers['sec-websocket-accept'],
          key,
          frames,
        });
      }, 1_500);
    });

    request.on('response', (response) => {
      clearTimeout(timer);
      response.resume();
      response.on('end', () =>
        resolve({ upgraded: false, status: response.statusCode ?? 0, key, frames: [] }),
      );
    });

    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/** One unmasked server→client frame, or null when more bytes are needed. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  // A server never masks, but decoding it costs four lines and a wrong
  // assumption here would look like a corrupt payload.
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask)
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

const target = stackTarget();
const session = await establishSession(target, mailpit(), 'ws');
check(
  session.jar.has((name) => name.includes('session')),
  'could not establish a verified session to open a socket with; the signup assertion has the detail',
);

const authenticated = await upgrade(target, { cookie: session.jar.header() });
check(
  authenticated.upgraded && authenticated.status === 101,
  `the authenticated upgrade returned ${authenticated.status}, not 101 — the socket never opened`,
);
check(
  authenticated.accept === expectedAccept(authenticated.key),
  `Sec-WebSocket-Accept was ${authenticated.accept}, not the value RFC 6455 requires for the key sent`,
);

const welcome = authenticated.frames
  .map((frame) => {
    try {
      return JSON.parse(frame);
    } catch {
      return null;
    }
  })
  .find((frame) => frame?.type === 'welcome');
check(
  welcome !== undefined,
  `the open socket sent no \`welcome\` frame (got: ${authenticated.frames.join(' | ') || 'nothing'})`,
);
/**
 * Who the account actually is, asked of the database rather than of the socket.
 *
 * Round 1's gauntlet: the identity check compared `welcome.user.displayName`
 * against `CI ws`, a constant. Two things fix that, and both are here because
 * they answer different questions. The display name is now unique per account
 * (`stack-client.mjs`), which makes the string worth comparing at all; and the
 * **user id** is obtained straight from Postgres by the address that signed up,
 * which is an identity the realtime server had no part in producing. A server
 * that welcomed some other session — the two-sessions-crossed failure a shared
 * secret makes possible — now has to agree with a row nobody asked it about.
 */
const expectedUserId = queryDatabase(
  `select id from users where email = ${sqlLiteral(session.email)} limit 1`,
);
check(
  expectedUserId !== null,
  `no \`users\` row for ${session.email}; the signup that this socket's session came from did not land in the database`,
);
check(
  welcome?.user?.id === expectedUserId,
  `the socket welcomed user id ${welcome?.user?.id}, not the id Postgres has for the account that opened it (${expectedUserId})`,
);
check(
  welcome?.user?.displayName === session.displayName,
  `the socket welcomed ${welcome?.user?.displayName}, not the account that opened it (${session.displayName})`,
);

// And the same request without the cookie. If this one also upgrades, the one
// above proved nothing about authentication.
const anonymous = await upgrade(target);
check(
  !anonymous.upgraded,
  `an upgrade with no session cookie also completed (status ${anonymous.status}) — the realtime server is upgrading anybody`,
);
check(
  anonymous.status === 401 || anonymous.status === 403,
  `the unauthenticated upgrade was refused with ${anonymous.status}; expected 401 or 403`,
);

report('assert-ws-upgrade');
