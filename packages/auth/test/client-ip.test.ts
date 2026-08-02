import { getIp } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import { ipHeadersFor, trustedProxiesFor } from '../src/auth.js';
import {
  clientIp,
  hasProxyStrategy,
  type ProxyStrategy,
  parseTrustedProxies,
  trustedProxyStrategy,
  unresolvedIpKey,
} from '../src/client-ip.js';

const headers = (values: Record<string, string>) => new Headers(values);

const unconfigured: ProxyStrategy = { kind: 'unconfigured' };
const socketOnly: ProxyStrategy = { kind: 'socket' };
const behind = (hops: number): ProxyStrategy => ({ kind: 'forwarded', hops });

/**
 * Three states, not two. Round 2 had `hops` as a number with 0 meaning both
 * "nobody configured this" and "there is nothing in front of me" — so the
 * compose deployment, which genuinely has nothing in front of it, got the
 * treatment meant for an undescribed one and counted nothing.
 */
describe('an unconfigured process believes nothing', () => {
  it('returns null even when it has a socket address', () => {
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {
        strategy: unconfigured,
        socketAddress: '203.0.113.5',
      }),
    ).toBeNull();
  });

  it('is the default, so a caller that forgets to say gets no address', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {})).toBeNull();
  });
});

describe('clientIp with nothing in front of it (hops=0)', () => {
  it('uses the socket address — which is the caller, on a bare host', () => {
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {
        strategy: socketOnly,
        socketAddress: '203.0.113.5',
      }),
    ).toBe('203.0.113.5');
  });

  it('ignores the forwarded headers entirely rather than half-believing them', () => {
    // The headers are a lie until something in front of us rewrites them.
    // Believing them here would let one attacker look like a million callers,
    // which is worse for a rate limiter than having no IP dimension at all.
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' }), {
        strategy: socketOnly,
      }),
    ).toBeNull();
  });
});

describe('clientIp behind trusted proxies', () => {
  it('counts from the right, so a spoofed prefix is skipped', () => {
    // The caller sent "1.1.1.1"; our own proxy appended the real address.
    expect(
      clientIp(headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.5' }), { strategy: behind(1) }),
    ).toBe('203.0.113.5');
  });

  it('walks back one entry per trusted hop', () => {
    const chain = headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.5, 10.0.0.1' });
    expect(clientIp(chain, { strategy: behind(1) })).toBe('10.0.0.1');
    expect(clientIp(chain, { strategy: behind(2) })).toBe('203.0.113.5');
  });

  it('refuses a chain shorter than the configured hop count', () => {
    /**
     * Round 2 clamped the index to 0 here and returned the leftmost entry —
     * which is the *caller's* entry. A client sending `X-Forwarded-For: 9.9.9.9`
     * to a `hops=1` deployment whose proxy did not in fact append got to name
     * its own address, which is the forged dimension the whole file exists to
     * refuse. Short chain now means "unreadable", and unreadable falls back to
     * the socket, or to nothing.
     */
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), {
        strategy: behind(3),
        socketAddress: '203.0.113.5',
      }),
    ).toBe('203.0.113.5');
    expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), { strategy: behind(3) })).toBeNull();
    expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), { strategy: behind(2) })).toBeNull();
  });

  it('falls back to x-real-ip, then to the socket', () => {
    expect(clientIp(headers({ 'x-real-ip': '198.51.100.7' }), { strategy: behind(1) })).toBe(
      '198.51.100.7',
    );
    expect(clientIp(headers({}), { strategy: behind(1), socketAddress: '203.0.113.5' })).toBe(
      '203.0.113.5',
    );
  });
});

describe('normalisation', () => {
  it('collapses the IPv4-mapped form so one caller is one bucket', () => {
    expect(
      clientIp(headers({}), { strategy: socketOnly, socketAddress: '::ffff:203.0.113.5' }),
    ).toBe('203.0.113.5');
  });

  it('strips a port without mangling a bare IPv6 address', () => {
    const at = (socketAddress: string) =>
      clientIp(headers({}), { strategy: socketOnly, socketAddress });
    expect(at('203.0.113.5:51234')).toBe('203.0.113.5');
    expect(at('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(at('2001:db8::1')).toBe('2001:db8::1');
  });

  it('treats blank entries as absent', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '  ,  ' }), { strategy: behind(1) })).toBeNull();
    expect(clientIp(headers({}), { strategy: socketOnly, socketAddress: '   ' })).toBeNull();
  });
});

describe('trustedProxyStrategy', () => {
  it('treats "nobody said" as unconfigured, not as zero', () => {
    for (const value of [undefined, '', '   ', 'lots', '-3', '1.5', '0x0']) {
      const env = value === undefined ? {} : { ATRIUM_TRUSTED_PROXY_HOPS: value };
      expect(trustedProxyStrategy(env), String(value)).toEqual({ kind: 'unconfigured' });
      expect(hasProxyStrategy(env)).toBe(false);
    }
  });

  it('reads an explicit zero as "trust the socket", which is a real configuration', () => {
    expect(trustedProxyStrategy({ ATRIUM_TRUSTED_PROXY_HOPS: '0' })).toEqual({ kind: 'socket' });
    expect(hasProxyStrategy({ ATRIUM_TRUSTED_PROXY_HOPS: '0' })).toBe(true);
  });

  it('reads a real hop count and clamps an absurd one', () => {
    expect(trustedProxyStrategy({ ATRIUM_TRUSTED_PROXY_HOPS: '1' })).toEqual({
      kind: 'forwarded',
      hops: 1,
    });
    expect(trustedProxyStrategy({ ATRIUM_TRUSTED_PROXY_HOPS: '500' })).toEqual({
      kind: 'forwarded',
      hops: 8,
    });
  });

  /**
   * Catches: dropping `ATRIUM_TRUSTED_PROXY_CIDRS` from `trustedProxyStrategy`,
   * or keeping unparseable entries. An entry that is not an address or a CIDR
   * would otherwise sit in the list matching nothing while making the list
   * non-empty — which switches the whole read to the trusted-proxy algorithm on
   * the strength of a typo.
   */
  it('reads the proxy addresses and drops the ones that are not addresses', () => {
    expect(
      trustedProxyStrategy({
        ATRIUM_TRUSTED_PROXY_HOPS: '1',
        ATRIUM_TRUSTED_PROXY_CIDRS: ' 172.28.0.10/32 , not-an-ip, 10.0.0.0/8 ,, fd00::/8 ',
      }),
    ).toEqual({
      kind: 'forwarded',
      hops: 1,
      trustedProxies: ['172.28.0.10/32', '10.0.0.0/8', 'fd00::/8'],
    });

    // Every entry unparseable is the same as none: the hop count still holds,
    // and the key is absent rather than an empty array pretending to be a list.
    expect(
      trustedProxyStrategy({
        ATRIUM_TRUSTED_PROXY_HOPS: '1',
        ATRIUM_TRUSTED_PROXY_CIDRS: 'nonsense, 300.1.2.3, 10.0.0.0/64',
      }),
    ).toEqual({ kind: 'forwarded', hops: 1 });

    // …and it is only read behind a proxy. `hops=0` has no chain to walk.
    expect(
      trustedProxyStrategy({
        ATRIUM_TRUSTED_PROXY_HOPS: '0',
        ATRIUM_TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      }),
    ).toEqual({ kind: 'socket' });
  });

  it('parses addresses, CIDRs and IPv6 the way Better Auth does', () => {
    expect(parseTrustedProxies('10.0.0.1')).toEqual(['10.0.0.1']);
    expect(parseTrustedProxies('10.0.0.0/8,192.168.0.0/16')).toEqual([
      '10.0.0.0/8',
      '192.168.0.0/16',
    ]);
    expect(parseTrustedProxies('::1,2001:db8::/32')).toEqual(['::1', '2001:db8::/32']);
    expect(parseTrustedProxies('10.0.0.0/33')).toEqual([]);
    expect(parseTrustedProxies('10.0.0.0/x')).toEqual([]);
    expect(parseTrustedProxies(undefined)).toEqual([]);
  });
});

/**
 * The trusted-proxy read, which is Better Auth's rule run on our side.
 *
 * Catches: deleting the `trustedProxies` branch from `clientIp` (it would fall
 * back to hop counting, which gives a different answer the moment a chain is
 * longer or shorter than the count says).
 */
describe('clientIp with the proxies named rather than counted', () => {
  const named = (...trustedProxies: string[]): ProxyStrategy => ({
    kind: 'forwarded',
    hops: 1,
    trustedProxies,
  });

  it('takes the first hop from the right that is not one of ours', () => {
    expect(
      clientIp(headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.7, 10.0.0.8' }), {
        strategy: named('10.0.0.0/8'),
      }),
    ).toBe('203.0.113.5');
  });

  it('is not fooled by a caller prefixing an address of its own', () => {
    // The right-hand entry is the one our own edge wrote, whatever the caller
    // put in front of it.
    expect(
      clientIp(headers({ 'x-forwarded-for': '9.9.9.9, 203.0.113.5' }), {
        strategy: named('10.0.0.0/8'),
      }),
    ).toBe('203.0.113.5');
  });

  it('reads nothing from a chain that is all ours, or one it cannot parse', () => {
    // Every hop trusted means the caller never appears in the chain at all.
    expect(
      clientIp(headers({ 'x-forwarded-for': '10.0.0.7, 10.0.0.8' }), {
        strategy: named('10.0.0.0/8'),
      }),
    ).toBeNull();
    // An unreadable entry aborts the header — but only once the walk reaches
    // it. The rightmost entry is the one our edge wrote, so a caller cannot
    // blind the read by prefixing junk; it has to be junk we would have had to
    // look at. Better Auth stops at exactly the same point (see the agreement
    // suite below), which is why this is spelled out rather than rounded off.
    expect(
      clientIp(headers({ 'x-forwarded-for': 'not-an-address, 203.0.113.5' }), {
        strategy: named('192.0.2.0/24'),
      }),
    ).toBe('203.0.113.5');
    expect(
      clientIp(headers({ 'x-forwarded-for': '203.0.113.5, not-an-address' }), {
        strategy: named('192.0.2.0/24'),
      }),
    ).toBeNull();
  });

  it('matches IPv6 proxies by prefix, and collapses the mapped form', () => {
    expect(
      clientIp(headers({ 'x-forwarded-for': '2001:db8::9, fd00::1' }), {
        strategy: named('fd00::/8'),
      }),
    ).toBe('2001:db8::9');
    expect(
      clientIp(headers({ 'x-forwarded-for': '::ffff:203.0.113.5, 10.0.0.7' }), {
        strategy: named('10.0.0.0/8'),
      }),
    ).toBe('203.0.113.5');
  });
});

/**
 * The claim that the two limiters bucket a caller the same way, asserted
 * against the library rather than against a comment.
 *
 * Round 3 handed Better Auth the header *names* and stopped there, so the two
 * agreed about where to look and not about what to believe. This calls the
 * library's own `getIp` with exactly the `advanced.ipAddress` block
 * `createAtriumAuth` builds, and compares it to ours on the same chain. If a
 * library upgrade changes `getIp`'s rule, this fails here — which is the point.
 *
 * Catches: dropping `trustedProxies` from the `advanced.ipAddress` block in
 * `auth.ts` (the prefixed-chain case then diverges: ours reads the real caller,
 * the library reads nothing).
 */
describe('Better Auth resolves the same caller from the same configuration', () => {
  /**
   * The one thing that has to be subtracted before the two can be compared.
   *
   * `getIp` ends with `if (isTest() || isDevelopment()) return LOCALHOST_IP` —
   * and `NODE_ENV` is read into a module-level constant when `@better-auth/core`
   * is imported, so a test process cannot stub its way out of it. That fallback
   * fires exactly when nothing resolved, so "the library returned the fallback"
   * and "the library resolved nothing" are the same event here. It is subtracted
   * rather than ignored: the assertion below pins the fallback's existence, so a
   * library upgrade that removes it turns this into a visible failure instead of
   * a comparison that quietly changed meaning. No chain in this file resolves to
   * 127.0.0.1 by any other route.
   */
  const localhostUnderTest = '127.0.0.1';

  function advanced(strategy: ProxyStrategy) {
    return {
      advanced: {
        ipAddress: {
          ipAddressHeaders: ipHeadersFor(strategy),
          trustedProxies: trustedProxiesFor(strategy),
        },
      },
    };
  }

  function libraryIp(strategy: ProxyStrategy, chain: string): string | null {
    const resolved = getIp(headers({ 'x-forwarded-for': chain }), advanced(strategy));
    return resolved === localhostUnderTest ? null : resolved;
  }

  it('still has the development fallback this comparison subtracts', () => {
    expect(getIp(headers({}), advanced(unconfigured))).toBe(localhostUnderTest);
  });

  const chains = [
    '203.0.113.5',
    '9.9.9.9, 203.0.113.5',
    '9.9.9.9, 198.51.100.1, 203.0.113.5',
    '10.0.0.7',
    'not-an-address, 203.0.113.5',
    '203.0.113.5, not-an-address',
    '192.0.2.9, 203.0.113.5, 192.0.2.10',
  ];

  it.each(chains)('agrees on "%s" with the proxy named', (chain) => {
    const strategy: ProxyStrategy = {
      kind: 'forwarded',
      hops: 1,
      trustedProxies: ['192.0.2.0/24'],
    };
    expect(clientIp(headers({ 'x-forwarded-for': chain }), { strategy })).toBe(
      libraryIp(strategy, chain),
    );
  });

  it('hands the library no headers at all when nothing may be believed', () => {
    for (const strategy of [unconfigured, socketOnly]) {
      expect(ipHeadersFor(strategy)).toEqual([]);
      expect(trustedProxiesFor(strategy)).toEqual([]);
      // With no header list, `getIp` resolves nothing rather than a spoofable
      // address — and neither do we.
      expect(libraryIp(strategy, '9.9.9.9')).toBeNull();
      expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9' }), { strategy })).toBeNull();
    }
  });

  /**
   * Without `trustedProxies` the two diverge on a prefixed chain — ours reads
   * the real caller, the library reads nothing and buckets them with everybody
   * else it could not place. Coarser rather than laxer, and still two answers.
   * This is what configuring it buys, said as a difference rather than a claim.
   *
   * Catches: dropping `trustedProxies` from `auth.ts` — the divergence below
   * becomes the *configured* behaviour and the agreement suite above fails.
   */
  it('would disagree on a prefixed chain if the proxies were not named', () => {
    const counted: ProxyStrategy = { kind: 'forwarded', hops: 1 };
    const chain = '9.9.9.9, 203.0.113.5';
    expect(clientIp(headers({ 'x-forwarded-for': chain }), { strategy: counted })).toBe(
      '203.0.113.5',
    );
    expect(libraryIp(counted, chain)).toBeNull();
  });

  /**
   * The property that actually matters, and the one round 3 broke: an
   * unresolvable caller must land in a *bucket*, not outside the limiter.
   * Better Auth does this itself (`NO_TRUSTED_IP_KEY` in its rate limiter);
   * `unresolvedIpKey` is the same decision on our side, and
   * `apps/web/app/(auth)/actions.ts` is where it is spent.
   */
  it('names the shared bucket an unresolvable caller falls into', () => {
    expect(unresolvedIpKey).toBe('ip:unresolved');
  });
});

/**
 * Better Auth's own limiter reads the same answer, from the same setting.
 *
 * Two limiters disagreeing about who the caller is would be the same defect
 * class as a guard disagreeing with a router: one of them ends up counting
 * something the other does not. `getIp` in `better-auth@1.6.x` trusts a
 * single-value `x-forwarded-for` outright when no `trustedProxies` are set, so
 * handing it that header while `client-ip.ts` refuses to believe it is exactly
 * the disagreement to avoid.
 */
describe('ipHeadersFor — what the library is allowed to read', () => {
  it('gives it nothing when nothing in front of us can be believed', () => {
    expect(ipHeadersFor(unconfigured)).toEqual([]);
    expect(ipHeadersFor(socketOnly)).toEqual([]);
  });

  it('gives it the forwarded chain only behind a real proxy', () => {
    expect(ipHeadersFor(behind(1))).toEqual(['x-forwarded-for', 'x-real-ip']);
  });
});
