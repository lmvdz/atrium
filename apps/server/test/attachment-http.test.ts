import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentSigner } from '../src/attachments.js';
import type { CommandService } from '../src/commands.js';
import type { Ledger } from '../src/ledger.js';
import { createLogger } from '../src/logger.js';
import { createRealtimeServer, type RealtimeServer } from '../src/ws-server.js';

const ORIGIN = 'http://atrium.test';
const ROOM = '33333333-3333-4333-8333-333333333333';
const logger = createLogger('error');
const servers: RealtimeServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(options: { authenticated?: boolean; member?: boolean } = {}) {
  const upload = vi.fn(async () => ({
    id: '44444444-4444-4444-8444-444444444444',
    url: 'http://object.test/upload',
    key: `${ROOM}/object`,
    headers: { 'content-type': 'text/plain' },
    expiresIn: 900,
    capability: 'signed-capability',
  }));
  const attachments: AttachmentSigner = {
    upload,
    download: vi.fn(async () => ({ url: 'http://object.test/download', expiresIn: 900 })),
    verify: vi.fn(() => true),
  };
  const commands = {
    execute: vi.fn(),
    requireMembership: vi.fn(async () => {
      if (options.member === false) throw new Error('not a member');
      return { seenSeq: 0 };
    }),
    stillMembers: vi.fn(async () => new Set<string>()),
  } as unknown as CommandService;
  const server = createRealtimeServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 60_000,
    logger,
    isReady: () => true,
    commands,
    ledger: { head: async () => 0 } as unknown as Ledger,
    session: {
      authenticateUpgrade: async () =>
        options.authenticated === false ? null : { userId: 'user-1', method: 'test' },
    },
    allowedOrigins: [ORIGIN],
    attachments,
  });
  servers.push(server);
  await server.listen();
  const { port } = server.httpServer.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, upload, commands };
}

function uploadRequest(base: string, origin = ORIGIN) {
  return fetch(`${base}/attachments/presign-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie: 'session=test' },
    body: JSON.stringify({ roomId: ROOM, name: 'proof.txt', contentType: 'text/plain', size: 5 }),
  });
}

describe('the attachment capability HTTP boundary', () => {
  /** CATCHES: authenticating before checking Origin lets a hostile page use the victim's cookie. */
  it('refuses a hostile browser origin before minting a capability', async () => {
    const { base, upload } = await start();
    const response = await uploadRequest(base, 'https://hostile.test');
    expect(response.status).toBe(403);
    expect(upload).not.toHaveBeenCalled();
  });

  /** CATCHES: an absent session falling through to attachment signing. */
  it('refuses an anonymous request before minting a capability', async () => {
    const { base, upload } = await start({ authenticated: false });
    const response = await uploadRequest(base);
    expect(response.status).toBe(401);
    expect(upload).not.toHaveBeenCalled();
  });

  /** CATCHES: authorizing attachment access by identity without room membership. */
  it('uses the same generic refusal for a nonmember and mints nothing', async () => {
    const { base, upload } = await start({ member: false });
    const response = await uploadRequest(base);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'attachment request refused' });
    expect(upload).not.toHaveBeenCalled();
  });

  /** CATCHES: validating the request but failing to pass the authorized room-bound input to S3. */
  it('mints a capability only after membership succeeds', async () => {
    const { base, upload, commands } = await start();
    const response = await uploadRequest(base);
    expect(response.status).toBe(200);
    expect(commands.requireMembership).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      ROOM,
    );
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, name: 'proof.txt', size: 5 }),
    );
  });
});
