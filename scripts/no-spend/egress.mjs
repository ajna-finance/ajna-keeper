import fs from 'fs';
import path from 'path';
import process from 'process';
import {
  ROOT,
  baseChildEnv,
  runCommandWithTimeout,
} from './runtime.mjs';
import { EGRESS_POSITIVE_CONTROL_BLOCKED_EXIT_CODE } from './egress-constants.mjs';

export const NO_EGRESS_GUARD_PATH = path.join(
  ROOT,
  'scripts',
  'no-egress-guard.cjs'
);
const EGRESS_POSITIVE_CONTROL_SCRIPT_PATH = path.join(
  ROOT,
  'scripts',
  'no-spend',
  'egress-positive-control.mjs'
);

function requireNoSpendInvariant(condition, message) {
  if (!condition) {
    throw new Error(`Missing no-spend invariant: ${message}`);
  }
}

export function withNoEgressGuard(env, params) {
  const nodeOptions = [
    env.NODE_OPTIONS,
    `--require=${NO_EGRESS_GUARD_PATH}`,
  ].filter(Boolean);
  return {
    ...env,
    NODE_OPTIONS: nodeOptions.join(' '),
    AJNA_NO_EGRESS_GUARD_ENABLED: '1',
    AJNA_NO_EGRESS_ALLOWED_HOSTS: params.allowedHosts,
    AJNA_NO_EGRESS_REPORT_PATH: params.reportPath,
  };
}

export function readEgressRecords(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return [];
  }
  return fs
    .readFileSync(reportPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {
          result: 'malformed_record',
          raw: line,
        };
      }
    });
}

export function assertEgressReport(reportPath, label) {
  const records = readEgressRecords(reportPath);
  const installedRecords = records.filter(
    (record) => record.result === 'guard_installed'
  );
  const unexpectedRecords = records.filter(
    (record) => record.result === 'unexpected_egress'
  );
  const malformedRecords = records.filter(
    (record) => record.result === 'malformed_record'
  );
  requireNoSpendInvariant(
    installedRecords.length > 0,
    `${label}: no-egress guard installed via NODE_OPTIONS`
  );
  requireNoSpendInvariant(
    unexpectedRecords.length === 0,
    `${label}: no unexpected outbound egress records`
  );
  requireNoSpendInvariant(
    malformedRecords.length === 0,
    `${label}: no malformed egress report records`
  );
  return {
    reportPath,
    installedRecords: installedRecords.length,
    unexpectedRecords: unexpectedRecords.length,
  };
}

export async function runNoEgressRequirePositiveControl(params) {
  const logPath = path.join(params.tempDir, 'egress-require-positive-control.log');
  const reportPath = path.join(
    params.tempDir,
    'egress-require-positive-control.jsonl'
  );
  const result = await runCommandWithTimeout(
    'no-egress guard NODE_OPTIONS positive control',
    [process.execPath, EGRESS_POSITIVE_CONTROL_SCRIPT_PATH],
    withNoEgressGuard(baseChildEnv(), {
      allowedHosts: params.allowedHosts,
      reportPath,
    }),
    logPath,
    30_000
  );
  const records = readEgressRecords(reportPath);
  const blocked = records.some(
    (record) => record.result === 'unexpected_egress'
  );
  requireNoSpendInvariant(
    result.exitCode === EGRESS_POSITIVE_CONTROL_BLOCKED_EXIT_CODE && blocked,
    'no-egress guard positive control blocked an external request through NODE_OPTIONS'
  );
  return {
    reportPath,
    logPath,
    exitCode: result.exitCode,
    blocked,
  };
}
