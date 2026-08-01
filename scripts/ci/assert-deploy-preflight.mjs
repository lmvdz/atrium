/**
 * The host is one this stack may be deployed on at all.
 *
 * ## The defect this exists for, which no file in this repository can fix
 *
 * Routed here from issue #26 round 6. `docker-compose.yml` publishes 443 and 80
 * on every address and publishes mailpit's UI on `127.0.0.1` only, and the
 * second of those is a *containment* claim: nothing off this box can reach it.
 *
 * On Docker Engine **before 28.0.0** that claim is false in a way no Caddyfile
 * and no compose file can repair. Pre-28 engines insert their DNAT rules ahead
 * of the filter chain that would have dropped the packet, so a port published to
 * `127.0.0.1` is reachable from any host that can route a packet to this one —
 * in practice, anything on the same L2 segment. The obvious mitigation, a
 * hostname matcher in the proxy, is not one: `Host` is a header the client
 * writes, so a remote caller sending `Host: localhost` matches whatever
 * `localhost` was supposed to protect. Hostname matching is not a source-address
 * control and cannot be made into one.
 *
 * 28.0.0 fixed it (the `DOCKER-USER` chain now sees loopback-published traffic
 * and drops off-host packets to it). So the answer is a *prerequisite*, checked
 * before anything is built, rather than a configuration change: this deployment
 * requires an engine that filters, and requires that the filtering has not been
 * turned off.
 *
 * ## Why "default NAT" is a second, separate check
 *
 * 28.0.0 also introduced per-network gateway modes. `nat` is the default and is
 * the mode the fix applies to; the other two undo it, each in their own way:
 *
 *   - `routed` — container addresses are directly routable, published-port
 *     filtering does not apply, and *every* container port is reachable from
 *     anywhere that can route to the container subnet. Postgres on 5432 and
 *     MinIO on 9000 are then open to that network, published or not.
 *   - `nat-unprotected` — NAT, with the filtering explicitly disabled. Its name
 *     is the documentation.
 *
 * Either mode, set as a daemon default (`--default-network-opt`) or on this
 * project's own network, puts a 28+ engine back in the pre-28 position. So both
 * are looked at: the live `bridge` network carries whatever the daemon defaults
 * to, and the *resolved* compose configuration carries whatever this project
 * asks for — including anything an overlay added, which is the same lever
 * `assert-stack-config.mjs` exists to watch.
 *
 * ## What this does NOT claim
 *
 * That the box is safe. It is one prerequisite, not a firewall audit: a 28+
 * engine in NAT mode still publishes 443 and 80 to the world, which is the
 * point of them, and a host firewall is still the operator's job. What it rules
 * out is the specific failure where a port this repository *documents* as
 * loopback-only is not, and where nothing in the repository could have told you.
 *
 * ## Mutations it catches
 *
 * - an engine older than 28.0.0 — the whole reason the file exists. Demonstrated
 *   in the mutation ledger (`old-engine`) with a `docker` on PATH that reports
 *   27.5.1, because a runner cannot be downgraded.
 * - `com.docker.network.bridge.gateway_mode_ipv4=routed` (or `nat-unprotected`,
 *   or the ipv6 spelling) on the daemon's default bridge, i.e.
 *   `--default-network-opt bridge=…` in `/etc/docker/daemon.json`.
 * - the same option on this project's network, from any compose file or overlay
 *   (ledger case `routed-gateway`).
 *
 * Run standalone, before deploying:
 *
 *   node scripts/ci/assert-deploy-preflight.mjs
 */

import { compose, docker } from './compose.mjs';
import { isMainModule } from './main-module.mjs';
import { check, report } from './stack-client.mjs';

/**
 * The first engine that filters loopback-published ports against off-host
 * callers. Below this there is no configuration of this repository that makes
 * `127.0.0.1:8025` mean what it says.
 */
export const MINIMUM_ENGINE = { major: 28, minor: 0, patch: 0 };

/** The two option names a gateway mode can be spelled with. */
const GATEWAY_MODE_OPTIONS = [
  'com.docker.network.bridge.gateway_mode_ipv4',
  'com.docker.network.bridge.gateway_mode_ipv6',
];

/**
 * The only gateway mode this deployment may run under.
 *
 * Absent means `nat` on a 28+ engine, and the engine version is checked
 * separately, so an absent option is accepted rather than demanded — requiring
 * it to be written out would fail every stack that simply took the default,
 * which is the configuration this file is asking for.
 */
const SAFE_GATEWAY_MODE = 'nat';

/** `28.0.0`, `29.3.0`, `28.1.1-beta.2` → `{major, minor, patch}`; else null. */
export function parseEngineVersion(raw) {
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? '').trim());
  if (!found) return null;
  return { major: Number(found[1]), minor: Number(found[2]), patch: Number(found[3]) };
}

/** Ordering on `{major, minor, patch}`. */
function atLeast(version, floor) {
  if (version.major !== floor.major) return version.major > floor.major;
  if (version.minor !== floor.minor) return version.minor > floor.minor;
  return version.patch >= floor.patch;
}

/**
 * The whole verdict, as a pure function of what was observed.
 *
 * Separated from the observing so `gate-selftest.mjs` can put an engine this
 * runner does not have through it. Returns human-readable problems; empty means
 * the host qualifies.
 *
 * ## Why `defaultBridge` is a three-state answer and not a map
 *
 * Round 2's gauntlet: "the preflight's 'default bridge NAT' is not asserted — a
 * failed inspection becomes `{}` and is accepted while the message claims both."
 * Exactly right, and it is this repository's own recurring defect wearing a
 * `catch` block: `{}` reads as "no gateway mode is set", which is the *safe*
 * answer, so an inspection that failed for any reason at all — a daemon that
 * refused, a permission error, a docker that is not there — was indistinguishable
 * from a clean bill of health, and the success line went on saying "default NAT".
 *
 * So the observation carries its own status. "There is no default bridge" is a
 * real and safe answer (rootless daemons have none), "here are its options" is a
 * real answer, and "I could not find out" is a third thing and fails closed.
 *
 * @param {object} observed
 * @param {string} observed.engineVersion  `docker version -f {{.Server.Version}}`
 * @param {{present: boolean, options?: Record<string,string>, error?: string}} observed.defaultBridge
 *        what `docker network inspect bridge` said, including that it could not say
 * @param {Record<string, {driver_opts?: Record<string,string>}>} observed.composeNetworks
 *        the `networks:` block of the *resolved* compose configuration
 */
export function checkHostNetworkPolicy({
  engineVersion,
  defaultBridge = { present: false },
  composeNetworks = {},
}) {
  const problems = [];
  const defaultBridgeOptions = defaultBridge.present ? (defaultBridge.options ?? {}) : {};

  if (defaultBridge.error) {
    problems.push(
      `the daemon's default bridge could not be inspected (${defaultBridge.error}), so whether it runs in NAT mode is unknown. An unknown answer is not a safe one: this check exists because \`routed\` and \`nat-unprotected\` re-open the pre-28 exposure, and reporting "default NAT" over a failed inspection is the shape of failure this whole ticket is about.`,
    );
  }

  const version = parseEngineVersion(engineVersion);
  if (version === null) {
    problems.push(
      `the Docker engine reported its version as ${JSON.stringify(engineVersion ?? null)}, which is not a version. This deployment requires >= ${MINIMUM_ENGINE.major}.${MINIMUM_ENGINE.minor}.${MINIMUM_ENGINE.patch}, and an engine that cannot say what it is cannot be shown to be one.`,
    );
  } else if (!atLeast(version, MINIMUM_ENGINE)) {
    problems.push(
      `Docker Engine ${engineVersion} publishes loopback-bound ports to any host that can route a packet here: the DNAT rules land ahead of the filter chain, so \`127.0.0.1:8025\` is reachable off-box and a remote caller defeats a hostname matcher by sending \`Host: localhost\`. Upgrade to >= ${MINIMUM_ENGINE.major}.${MINIMUM_ENGINE.minor}.${MINIMUM_ENGINE.patch}, or take the published ports off this host's reachable interfaces yourself — no compose file and no Caddyfile in this repository can close it.`,
    );
  }

  for (const option of GATEWAY_MODE_OPTIONS) {
    const mode = defaultBridgeOptions[option];
    if (mode !== undefined && mode !== SAFE_GATEWAY_MODE) {
      problems.push(
        `the daemon's default bridge runs with ${option}=${mode}, not ${SAFE_GATEWAY_MODE}. That is the pre-28 exposure re-enabled by configuration: \`routed\` makes every container port directly reachable (Postgres on 5432 and MinIO on 9000 included, published or not) and \`nat-unprotected\` keeps NAT while turning the filtering off. Remove it from --default-network-opt / daemon.json.`,
      );
    }
  }

  for (const [name, definition] of Object.entries(composeNetworks)) {
    const options = definition?.driver_opts ?? {};
    for (const option of GATEWAY_MODE_OPTIONS) {
      const mode = options[option];
      if (mode !== undefined && mode !== SAFE_GATEWAY_MODE) {
        problems.push(
          `the compose network \`${name}\` sets ${option}=${mode}. Whichever file set it — docker-compose.yml or an overlay — this stack would run with its published-port filtering off, which is the exposure the engine floor above exists to close.`,
        );
      }
    }
  }

  return problems;
}

/**
 * Every port this deployment publishes, against what it is *written down* as
 * publishing.
 *
 * ── THE DEFECT CLASS (#40 round 8, D6) ──────────────────────────────────────
 * The deploy job's own step comment described the runner as "a stack that lives
 * for ten minutes on a runner with no published database port". Nothing asserted
 * it, and it was **not true**: `docker-compose.yml` publishes Postgres on 5432
 * and MinIO on 9000 and 9001 with no interface prefix, which on a host with a
 * routable address means every address that host answers on. A blind critic
 * connected from a non-loopback address with the credentials from `.env` and
 * dumped the schema. Mailpit, in the overlay, does it the other way — `127.0.0.1:`
 * in front of the port — which is what makes the difference deliberate rather
 * than a convention nobody wrote down.
 *
 * **A premise stated in a comment and not asserted is this campaign's oldest
 * defect class.** The exposure itself is #51 and is not fixed here; what is
 * fixed here is that it is no longer a sentence in a comment. Every publication
 * is enumerated out of the resolved configuration and compared against the table
 * below, which says, per port, which interface it is on and why. A new
 * publication, a publication that moves off loopback, or a written entry that
 * stops being true is a red preflight before a single image is built.
 *
 * The table is not a *permission*; it is a description that has to keep
 * matching. `PUBLISHED` says what is true today, and every entry that is not
 * loopback names the issue that owns it.
 */
const PUBLISHED = {
  'proxy:80': {
    interface: '',
    why: 'the deployment is a web server; this is the redirect to TLS and it is the point of the stack',
  },
  'proxy:443': {
    interface: '',
    why: 'the deployment is a web server; every assertion in this job reaches it here',
  },
  'postgres:5432': {
    interface: '',
    why: 'ISSUE #51 — published on every interface this host answers on, with the credentials in `.env`. Loopback-only is the fix and it is not made here; this entry exists so the exposure is a line in a check rather than a claim in a comment that was false.',
  },
  'minio:9000': {
    interface: '',
    why: 'ISSUE #51 — same: the object store, published off-box, reachable with S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY from `.env`.',
  },
  'minio:9001': {
    interface: '',
    why: 'ISSUE #51 — the MinIO console, same exposure and the same fix.',
  },
  'mailpit:8025': {
    interface: '127.0.0.1',
    why: 'a store of live sign-in links, deliberately bound to loopback — and the reason the engine floor above exists, because engines before 28.0.0 publish loopback-bound ports off-box anyway',
  },
};

/**
 * The short form's fields, without splitting a `${VAR:-default}` in half.
 *
 * `'${POSTGRES_PORT:-5432}:5432'` has *two* fields and three colons, and reading
 * it naively makes `${POSTGRES_PORT` look like a bind address — which would have
 * reported the whole shipped file as misdescribed while saying nothing about any
 * real interface. Found by running this against docker-compose.yml, which is why
 * the self-test reads the YAML rather than only the resolved configuration.
 */
function splitPublication(publication) {
  const masked = String(publication).replace(/\$\{[^}]*\}/g, (match) => ' '.repeat(match.length));
  const text = String(publication);
  const fields = [];
  let start = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    if (index === masked.length || masked[index] === ':') {
      fields.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return fields;
}

/**
 * @param {object} services the `services` block of `docker compose config --format json`
 * @param {object} [expected] injectable so the self-tests can state a different world
 * @returns {string[]}
 */
export function publishedPortProblems(services, expected = PUBLISHED) {
  const problems = [];
  const seen = new Set();
  for (const [service, definition] of Object.entries(services ?? {})) {
    for (const publication of definition?.ports ?? []) {
      // Keyed on the *container* port. The host port is `${HTTPS_PORT}` and
      // friends — configurable on purpose, so that a machine with 443 already
      // taken can still run this stack — and a table keyed on it would go red
      // for a port remap, which is a change to nothing that matters here. What
      // matters is which interface the host side is bound to.
      //
      // Two shapes, because there are two readers: `docker compose config`
      // resolves every publication to an object, and `gate-selftest.mjs` reads
      // the shipped YAML directly (the verify job has no `.env`, so it cannot
      // ask compose to interpolate one). The short form is
      // `[host_ip:][host:]container`, so the *last* field is the container port
      // and a three-field form is the only one that names an interface.
      const short = typeof publication === 'object' ? undefined : splitPublication(publication);
      const target = String(publication?.target ?? short?.at(-1) ?? '');
      const host = String(publication?.published ?? short?.at(-2) ?? target);
      const address = String(
        publication?.host_ip ?? (short !== undefined && short.length >= 3 ? short[0] : ''),
      );
      const key = `${service}:${target}`;
      seen.add(key);
      const declared = expected[key];
      if (declared === undefined) {
        problems.push(
          `${service} publishes its port ${target} (as host port ${host || '(unnamed)'}) and nothing in this file says it does. Every port this deployment opens is written down with the interface it is on and why — a publication nobody declared is the "runner with no published database port" comment all over again, and that comment was false for three rounds.`,
        );
        continue;
      }
      const on = address === '0.0.0.0' || address === '::' ? '' : address;
      if (on !== declared.interface) {
        problems.push(
          `${service} publishes its port ${target} on ${on === '' ? 'every interface this host answers on' : on}, and this file says ${declared.interface === '' ? 'every interface' : declared.interface}. ${declared.why}. Whichever of the two moved, a published port changing interface is the whole difference between "reachable from this machine" and "reachable from anything that can route a packet here".`,
        );
      }
    }
  }
  for (const key of Object.keys(expected)) {
    if (!seen.has(key)) {
      problems.push(
        `this file says ${key} is published and the resolved configuration does not publish it. A description that has stopped describing anything is one nobody re-read — take the entry out, or find out which file stopped opening the port.`,
      );
    }
  }
  return problems;
}

/**
 * What the daemon's default bridge is, or that we could not find out.
 *
 * Absence and failure are asked as two questions, because they were one answer
 * and the safe one won. `docker network ls` says whether a `bridge` network
 * exists at all — a rootless daemon legitimately has none — and only then is it
 * inspected. Either command failing is an *error*, not an empty options map.
 */
function observeDefaultBridge() {
  let listed;
  try {
    listed = docker(['network', 'ls', '--format', '{{.Name}}']);
  } catch (error) {
    return { present: false, error: `docker network ls failed: ${firstLine(error.message)}` };
  }
  const names = listed
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.includes('bridge')) {
    // No default bridge to be wrong about. Rootless daemons have none, and a
    // daemon whose `bridge` was removed cannot be running containers on it.
    return { present: false };
  }
  try {
    const options = JSON.parse(
      docker(['network', 'inspect', 'bridge', '--format', '{{json .Options}}']),
    );
    return { present: true, options: options ?? {} };
  } catch (error) {
    return {
      present: true,
      error: `docker network inspect bridge failed: ${firstLine(error.message)}`,
    };
  }
}

function firstLine(message) {
  return String(message ?? '').split('\n')[0];
}

/**
 * The `networks:` block of the resolved configuration.
 *
 * `docker compose config` rather than reading the YAML: it is the merge of every
 * `-f` file plus `.env` interpolation, which is the only form that reflects what
 * an overlay actually asked for.
 */
function composeConfig() {
  return JSON.parse(compose(['config', '--format', 'json']));
}

if (isMainModule(import.meta.url)) {
  const engineVersion = docker(['version', '--format', '{{.Server.Version}}']).trim();
  const defaultBridge = observeDefaultBridge();
  const resolved = composeConfig();
  const problems = [
    ...checkHostNetworkPolicy({
      engineVersion,
      defaultBridge,
      composeNetworks: resolved.networks ?? {},
    }),
    ...publishedPortProblems(resolved.services ?? {}),
  ];
  for (const problem of problems) check(false, problem);
  if (problems.length === 0) {
    // What was observed, not what was hoped for. The old line said "default NAT"
    // whether or not the bridge had been looked at.
    const bridge = defaultBridge.present
      ? `the daemon's default bridge is in ${defaultBridge.options?.['com.docker.network.bridge.gateway_mode_ipv4'] ?? SAFE_GATEWAY_MODE} mode`
      : 'this daemon has no default bridge network';
    console.info(
      `Deploy preflight: Docker Engine ${engineVersion}, ${bridge}, and no gateway mode overridden on any network of this project.`,
    );
  }
  report('assert-deploy-preflight');
}
