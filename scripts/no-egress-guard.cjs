'use strict';

const http = require('http');
const https = require('https');

const LOCALHOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const INSTALL_MARK = Symbol.for('ajna.noEgressGuard.installed');

function canonicalizeHost(host) {
  if (typeof host !== 'string') {
    return undefined;
  }
  let normalized = host.trim().toLowerCase();
  // URL.hostname and bracketed authorities surround IPv6 literals with [ ];
  // strip them so '[::1]' compares equal to the '::1' in the allowlist.
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

// Extract the host from a `host[:port]` authority. Bracket-aware so an IPv6
// literal like '[::1]:8545' yields '::1' rather than '[' (the old
// split(':')[0] that fail-closed-blocked a legitimate localhost-IPv6 target).
function extractHostFromAuthority(authority) {
  if (typeof authority !== 'string') {
    return undefined;
  }
  const value = authority.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return canonicalizeHost(end === -1 ? value : value.slice(0, end + 1));
  }
  const colon = value.indexOf(':');
  return canonicalizeHost(colon === -1 ? value : value.slice(0, colon));
}

function parseAllowedHosts(raw) {
  const allowed = new Set(LOCALHOST_NAMES);
  for (const entry of String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const canonical = canonicalizeHost(entry);
    if (canonical) {
      allowed.add(canonical);
    }
  }
  return allowed;
}

// The host an http(s) options object resolves to. `hostname` (bare host, no
// port) takes precedence over `host` (may include a port) — the same
// precedence Node's ClientRequest uses.
function hostFromOptions(options) {
  if (!options || typeof options !== 'object') {
    return undefined;
  }
  if (typeof options.hostname === 'string') {
    return canonicalizeHost(options.hostname);
  }
  if (typeof options.host === 'string') {
    return extractHostFromAuthority(options.host);
  }
  return undefined;
}

// Every host the call could actually contact. For the two-arg
// http.request(url, options) form Node assigns `options` over the parsed URL,
// so an options.host/hostname override redirects the real connection: it is
// collected as an additional candidate so it cannot slip past the allowlist
// while the URL host looks benign (the old fail-OPEN bypass). Fails closed
// (hostname 'unparseable'/'unknown', never in the allowlist) when no host is
// determinable.
function collectTargets(input, options, protocolHint) {
  const targets = [];
  try {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(input);
      targets.push({
        protocol: url.protocol || protocolHint,
        hostname: canonicalizeHost(url.hostname),
        port: url.port,
      });
    } else if (input && typeof input === 'object') {
      const hostname = hostFromOptions(input);
      if (hostname) {
        targets.push({
          protocol: input.protocol || protocolHint,
          hostname,
          port: input.port ? String(input.port) : '',
        });
      }
    }
    const overrideHost = hostFromOptions(options);
    if (overrideHost) {
      targets.push({
        protocol: (options && options.protocol) || protocolHint,
        hostname: overrideHost,
        port: options && options.port ? String(options.port) : '',
      });
    }
  } catch {
    return [{ protocol: protocolHint, hostname: 'unparseable', port: '' }];
  }
  if (targets.length === 0) {
    return [{ protocol: protocolHint, hostname: 'unknown', port: '' }];
  }
  return targets;
}

// The first candidate target whose host is not allow-listed, or null if every
// candidate is allowed. Pure (allowlist passed in) so it is unit-testable
// without monkeypatching global http.
function findBlockedTarget(targets, allowedHosts) {
  for (const target of targets) {
    const hostname = String(target.hostname || '').toLowerCase();
    if (!allowedHosts.has(hostname)) {
      return target;
    }
  }
  return null;
}

function redactTarget(target) {
  const protocol = target.protocol || 'unknown:';
  const port = target.port ? `:${target.port}` : '';
  return `${protocol}//${target.hostname}${port}`;
}

function buildBlockedEgressError(target) {
  const metadata = {
    result: 'unexpected_egress',
    protocol: target.protocol,
    hostname: target.hostname,
    redactedTarget: redactTarget(target),
  };
  const error = new Error(
    `unexpected_egress blocked outbound request to ${metadata.redactedTarget}`
  );
  error.code = 'AJNA_UNEXPECTED_EGRESS';
  error.egressGuard = metadata;
  return error;
}

function recordBlockedTarget(target, reporter) {
  const metadata = {
    result: 'unexpected_egress',
    protocol: target.protocol,
    hostname: target.hostname,
    redactedTarget: redactTarget(target),
    timestamp: new Date().toISOString(),
  };
  reporter(metadata);
  return metadata;
}

function recordInstalled(allowedHosts, reporter) {
  const metadata = {
    result: 'guard_installed',
    allowedHosts: Array.from(allowedHosts).sort(),
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  reporter(metadata);
  return metadata;
}

function installNoEgressGuard(options = {}) {
  const globalState = globalThis[INSTALL_MARK];
  if (globalState) {
    return globalState;
  }

  const fs = require('fs');
  const allowedHosts = parseAllowedHosts(
    options.allowedHosts || process.env.AJNA_NO_EGRESS_ALLOWED_HOSTS
  );
  const reportPath = options.reportPath || process.env.AJNA_NO_EGRESS_REPORT_PATH;
  const reporter =
    options.reporter ||
    ((metadata) => {
      if (!reportPath) {
        return;
      }
      fs.appendFileSync(reportPath, `${JSON.stringify(metadata)}\n`);
    });

  function assertAllowed(input, options, protocolHint) {
    const blocked = findBlockedTarget(
      collectTargets(input, options, protocolHint),
      allowedHosts
    );
    if (blocked) {
      recordBlockedTarget(blocked, reporter);
      throw buildBlockedEgressError(blocked);
    }
  }

  function wrapRequest(original, protocolHint) {
    return function guardedRequest(input, options, callback) {
      assertAllowed(input, options, protocolHint);
      return original.apply(this, arguments);
    };
  }

  http.request = wrapRequest(http.request, 'http:');
  https.request = wrapRequest(https.request, 'https:');
  http.get = wrapRequest(http.get, 'http:');
  https.get = wrapRequest(https.get, 'https:');

  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function guardedFetch(input, init) {
      assertAllowed(input, init, 'https:');
      return await originalFetch.apply(this, arguments);
    };
  }

  const state = { allowedHosts: Array.from(allowedHosts).sort() };
  globalThis[INSTALL_MARK] = state;
  recordInstalled(allowedHosts, reporter);
  return state;
}

if (process.env.AJNA_NO_EGRESS_GUARD_ENABLED === '1') {
  installNoEgressGuard();
}

module.exports = {
  installNoEgressGuard,
  // Exported for unit testing the allowlist decision without monkeypatching
  // global http/https/fetch.
  parseAllowedHosts,
  canonicalizeHost,
  extractHostFromAuthority,
  collectTargets,
  findBlockedTarget,
};
