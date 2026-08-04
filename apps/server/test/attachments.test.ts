import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAttachmentSigner, MAX_ATTACHMENT_BYTES, UploadRequest } from '../src/attachments.js';
import { Command } from '../src/commands.js';

const ROOM = '00000000-0000-4000-8000-000000000001';

function signer() {
  return createAttachmentSigner({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    bucket: 'atrium-attachments',
    forcePathStyle: true,
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
  });
}

describe('direct attachment capabilities', () => {
  /**
   * Mutation: omit ContentLength or ContentType from the signed request. A
   * caller can then use a capability approved for five text bytes to upload a
   * different representation or an unbounded body.
   */
  it('binds an upload capability to room, size and media type', async () => {
    const signed = await signer().upload({
      roomId: ROOM,
      name: 'proof.txt',
      contentType: 'text/plain',
      size: 5,
    });
    const url = new URL(signed.url);
    expect(signed.key).toMatch(new RegExp(`^${ROOM}/[0-9a-f-]{36}$`));
    expect(url.pathname).toContain(`/atrium-attachments/${ROOM}/`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(signed.headers).toEqual({ 'content-type': 'text/plain' });
    expect(
      signer().verify({
        roomId: ROOM,
        id: signed.id,
        key: signed.key,
        name: 'proof.txt',
        contentType: 'text/plain',
        size: 5,
        capability: signed.capability,
      }),
    ).toBe(true);
  });

  /** Mutation: verify only the key prefix and trust rewritten message metadata. */
  it('rejects any metadata tuple other than the one the upload grant signed', async () => {
    const authority = signer();
    const signed = await authority.upload({
      roomId: ROOM,
      name: 'proof.txt',
      contentType: 'text/plain',
      size: 5,
    });
    const granted = {
      roomId: ROOM,
      id: signed.id,
      key: signed.key,
      name: 'proof.txt',
      contentType: 'text/plain',
      size: 5,
      capability: signed.capability,
    };
    expect(authority.verify({ ...granted, name: 'invoice.exe' })).toBe(false);
    expect(authority.verify({ ...granted, contentType: 'application/octet-stream' })).toBe(false);
    expect(authority.verify({ ...granted, size: 6 })).toBe(false);
    expect(authority.verify({ ...granted, key: `${ROOM}/another-object` })).toBe(false);
    // Mutation: omit attachment id from the capability payload, allowing one
    // upload grant to be claimed under a different durable identity.
    expect(authority.verify({ ...granted, id: randomUUID() })).toBe(false);
  });

  /** Mutation: remove the 25 MB bound from either presigning or the command. */
  it('refuses oversized metadata before signing and before ledger append', () => {
    expect(() =>
      UploadRequest.parse({
        roomId: ROOM,
        name: 'too-large.bin',
        contentType: 'application/octet-stream',
        size: MAX_ATTACHMENT_BYTES + 1,
      }),
    ).toThrow();
    expect(
      Command.safeParse({
        name: 'send_message',
        roomId: ROOM,
        body: 'oversized',
        attachments: [
          {
            key: `${ROOM}/file`,
            name: 'too-large.bin',
            contentType: 'application/octet-stream',
            size: MAX_ATTACHMENT_BYTES + 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  /** Mutation: sign a key without checking that its prefix names this room. */
  it('refuses a download capability for another room’s key', async () => {
    await expect(
      signer().download({
        roomId: ROOM,
        key: '00000000-0000-4000-8000-000000000002/file',
        name: 'stolen.txt',
      }),
    ).rejects.toThrow(/another room/);
  });
});
