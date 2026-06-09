'use strict';

const http = require('http');
const https = require('https');

const LOCALHOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const INSTALL_MARK = Symbol.for('ajna.noEgressGuard.installed');

function parseAllowedHosts(raw) {
  const allowed = new Set(LOCALHOST_NAMES);
  for (const entry of String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    allowed.add(entry.toLowerCase());
  }
  return allowed;
}

function getHostnameFromOptions(options) {
  if (!options || typeof options !== 'object') {
    return undefined;
  }
  const hostname = options.hostname || options.host;
  if (typeof hostname !== 'string') {
    return undefined;
  }
  return hostname.split(':')[0];
}

function normalizeTarget(input, options, protocolHint) {
  try {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(input);
      return {
        protocol: url.protocol || protocolHint,
        hostname: url.hostname,
        port: url.port,
      };
    }
    if (input && typeof input === 'object') {
      const hostname = getHostnameFromOptions(input);
      if (hostname) {
        return {
          protocol: input.protocol || protocolHint,
          hostname,
          port: input.port ? String(input.port) : '',
        };
      }
    }
    const hostname = getHostnameFromOptions(options);
    if (hostname) {
      return {
        protocol: options.protocol || protocolHint,
        hostname,
        port: options.port ? String(options.port) : '',
      };
    }
  } catch {
    return {
      protocol: protocolHint,
      hostname: 'unparseable',
      port: '',
    };
  }
  return {
    protocol: protocolHint,
    hostname: 'unknown',
    port: '',
  };
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

  function assertAllowed(target) {
    const hostname = String(target.hostname || '').toLowerCase();
    if (allowedHosts.has(hostname)) {
      return;
    }
    recordBlockedTarget(target, reporter);
    throw buildBlockedEgressError(target);
  }

  function wrapRequest(original, protocolHint) {
    return function guardedRequest(input, options, callback) {
      const target = normalizeTarget(input, options, protocolHint);
      assertAllowed(target);
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
      const target = normalizeTarget(input, init, 'https:');
      assertAllowed(target);
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
};
