import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * What the shipped deployment files can be reached on.
 *
 * `transport.ts` refuses to *run* a production process that advertises a
 * cleartext origin. That is the process half of the rule. This is the
 * deployment half, and the round-5 gauntlet found it missing: the dev pair set
 * `NODE_ENV=development`, which switches the process guard off, and then
 * published `0.0.0.0:${WEB_PORT}:80` behind a Caddyfile that answered any Host.
 * `NODE_ENV=development` stops a process refusing to boot; it does not stop an
 * operator putting that pair on the internet.
 *
 * These tests live in `packages/auth` because the rule is the same one
 * `transport.ts` owns, and they read the shipped files rather than a copy —
 * a test that asserted against its own fixture would prove nothing about what
 * gets deployed.
 *
 * ## What they can and cannot settle
 *
 * They read the *files*, so what they catch is an edit that widens a binding.
 * They cannot see a compose override applied elsewhere, and they are not a
 * substitute for rendering: the round-6 receipt records
 * `docker compose config` and `caddy adapt` runs against these same files, and
 * those are what prove the tools agree with this reading. The pairing is
 * deliberate — the render is the measurement, these are the ratchet.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Compose files carry merge tags (`!override`, `!reset`) that are compose's
 * own, not YAML's, so a plain parser rejects them. Stripped rather than
 * declared as custom tags because the tag changes how compose *merges* two
 * files and changes nothing about the value being asserted here.
 */
function compose(name: string): {
  services: Record<string, { ports?: string[] }>;
} {
  const source = readFileSync(`${repoRoot}/${name}`, 'utf8').replace(
    /:\s*!(override|reset)\b/g,
    ':',
  );
  return parse(source);
}

/** Every published port of a service, as written. */
function publishedPorts(file: string, service: string): string[] {
  const parsed = compose(file);
  const ports = parsed.services[service]?.ports;
  if (!ports) throw new Error(`${file} has no published ports for \`${service}\``);
  return ports;
}

describe('the dev compose pair cannot be put on a network', () => {
  it('publishes the dev proxy on loopback only', () => {
    /**
     * Catches: reverting `127.0.0.1:${WEB_PORT:-3000}:80` to
     * `${WEB_PORT:-3000}:80`, which docker expands to `0.0.0.0`. Verified by
     * doing exactly that and rendering the merged file: the `proxy` service's
     * port loses its `host_ip: 127.0.0.1` and is published on every interface.
     */
    for (const port of publishedPorts('docker-compose.dev.yml', 'proxy')) {
      expect(port, 'a dev port published off loopback').toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('proxies the app to loopback Hosts only, and refuses every other name', () => {
    /**
     * Catches, separately: reverting the site address to `:80`, which would put
     * `reverse_proxy` under a block that answers any Host; and deleting the
     * keyless refusal block, which would leave a foreign Host getting Caddy's
     * default for an unmatched request.
     *
     * That default is the reason this test is shaped around `reverse_proxy`
     * rather than around addresses. The first draft asserted that every site
     * address was loopback, with a comment claiming a foreign Host "gets a 404".
     * Probed against a running container it does not: Caddy answers an
     * unmatched Host with an empty **200 OK**, which a scanner or an upstream
     * proxy reads as a healthy service. So the file now carries an explicit
     * `:80` fallback that responds 421, and this asserts the shape that
     * combination has — one host-matched block that proxies, one keyless block
     * that refuses. Measured after the change: localhost and 127.0.0.1 → 502
     * (the proxy block, upstream absent), evil.example.com and atrium.example →
     * 421 with the refusal body.
     */
    const caddyfile = readFileSync(`${repoRoot}/deploy/Caddyfile.dev`, 'utf8');

    // Split into top-level blocks: an unindented `<address...> {` line, then
    // everything up to the unindented `}`. Comments and the global-options
    // block (whose key is empty) are excluded by the address filter below.
    const blocks: { addresses: string[]; body: string }[] = [];
    let current: { addresses: string[]; body: string } | null = null;
    for (const line of caddyfile.split('\n')) {
      if (current === null) {
        const opening = /^([^\s#{][^{]*)\{\s*$/.exec(line);
        if (opening?.[1] !== undefined) {
          current = {
            addresses: opening[1]
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part.length > 0),
            body: '',
          };
        }
      } else if (/^\}\s*$/.test(line)) {
        blocks.push(current);
        current = null;
      } else {
        current.body += `${line}\n`;
      }
    }

    // The premise, measured. A parser that found nothing would make every
    // assertion below vacuously true — which is how this kind of guard usually
    // dies quietly.
    expect(blocks.length, 'no site blocks parsed out of Caddyfile.dev').toBe(2);

    const proxying = blocks.filter((block) => block.body.includes('reverse_proxy'));
    expect(proxying, 'exactly one block should reach the app').toHaveLength(1);
    for (const address of proxying[0]?.addresses ?? []) {
      expect(address, 'the app is proxied under a non-loopback Host').toMatch(
        /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/,
      );
    }

    const fallback = blocks.find((block) => !block.body.includes('reverse_proxy'));
    expect(fallback?.addresses, 'the refusal must be the keyless fallback').toEqual([':80']);
    expect(fallback?.body, 'an unmatched Host must be refused, not answered').toMatch(
      /respond\s+".*"\s+421/,
    );
  });

  it('still binds a real port, so this is a restriction and not a deletion', () => {
    // The control. Deleting the `ports:` block entirely would satisfy both
    // assertions above by making the dev stack unreachable from the laptop it
    // exists for.
    expect(publishedPorts('docker-compose.dev.yml', 'proxy')).toHaveLength(1);
    expect(readFileSync(`${repoRoot}/deploy/Caddyfile.dev`, 'utf8')).toContain(
      'reverse_proxy app:3000',
    );
  });
});

describe('the production compose publishes only the proxy to a network', () => {
  it('keeps postgres and minio on loopback', () => {
    /**
     * Round 5's base file published `${POSTGRES_PORT:-5432}:5432` and both
     * MinIO ports with a header paragraph asking the operator not to expose
     * them — the same "a comment is not a control" shape rounds 4 and 5 removed
     * from the Caddyfile, left in place one file over.
     *
     * Catches: dropping the `127.0.0.1:` prefix from any of the three.
     */
    for (const service of ['postgres', 'minio']) {
      for (const port of publishedPorts('docker-compose.yml', service)) {
        expect(port, `${service} published off loopback`).toMatch(/^127\.0\.0\.1:/);
      }
    }
  });

  it('publishes 80 and 443 on the proxy, and nothing on app or server', () => {
    /**
     * The other half, and the control: the proxy is the single entrypoint, so
     * it *must* answer on a network — a test that demanded loopback everywhere
     * would be asserting that the product cannot be deployed.
     */
    const ports = publishedPorts('docker-compose.yml', 'proxy');
    expect(ports.some((port) => port.endsWith(':80'))).toBe(true);
    expect(ports.some((port) => port.endsWith(':443'))).toBe(true);
    for (const port of ports) {
      expect(port, 'the proxy must reach a network').not.toMatch(/^127\.0\.0\.1:/);
    }

    const services = compose('docker-compose.yml').services;
    expect(services.app?.ports).toBeUndefined();
    expect(services.server?.ports).toBeUndefined();
  });
});
