import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleMailer, type MailMessage } from '../src/mailer.js';

const message: MailMessage = {
  kind: 'email-verification',
  to: 'ada@example.com',
  subject: 'Confirm your email for Atrium',
  url: 'http://localhost:3000/api/auth/verify-email?token=abc',
  body: 'Confirm ada@example.com',
};

let dir: string;
let outbox: string;
const originalOutbox = process.env.ATRIUM_MAIL_OUTBOX;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atrium-mailer-'));
  outbox = join(dir, 'outbox.jsonl');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.ATRIUM_MAIL_OUTBOX = originalOutbox;
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

describe('consoleMailer', () => {
  it('prints the link so a developer can finish the flow', async () => {
    delete process.env.ATRIUM_MAIL_OUTBOX;
    await consoleMailer(message);
    const printed = vi.mocked(console.info).mock.calls.flat().join('\n');
    expect(printed).toContain(message.url);
    expect(printed).toContain(message.to);
  });

  it('writes the outbox only when one is configured', async () => {
    delete process.env.ATRIUM_MAIL_OUTBOX;
    await consoleMailer(message);
    expect(existsSync(outbox)).toBe(false);

    process.env.ATRIUM_MAIL_OUTBOX = outbox;
    await consoleMailer(message);
    const lines = readFileSync(outbox, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      kind: 'email-verification',
      to: message.to,
      url: message.url,
    });
  });

  it('refuses to write a plaintext outbox in production, whatever the env says', async () => {
    process.env.ATRIUM_MAIL_OUTBOX = outbox;
    process.env.NODE_ENV = 'production';
    await consoleMailer(message);
    expect(existsSync(outbox)).toBe(false);
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toMatch(/NODE_ENV=production/);
  });

  it('never lets a broken outbox break a signup', async () => {
    process.env.ATRIUM_MAIL_OUTBOX = join(dir, 'no', 'such', 'dir', 'outbox.jsonl');
    await expect(consoleMailer(message)).resolves.toBeUndefined();
  });
});
