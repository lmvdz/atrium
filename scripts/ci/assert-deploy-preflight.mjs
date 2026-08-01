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
function composeNetworks() {
  const resolved = JSON.parse(compose(['config', '--format', 'json']));
  return resolved.networks ?? {};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const engineVersion = docker(['version', '--format', '{{.Server.Version}}']).trim();
  const defaultBridge = observeDefaultBridge();
  const problems = checkHostNetworkPolicy({
    engineVersion,
    defaultBridge,
    composeNetworks: composeNetworks(),
  });
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
