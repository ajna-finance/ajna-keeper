import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
export const TS_NODE_BIN = path.join(
  ROOT,
  'node_modules',
  'ts-node',
  'dist',
  'bin.js'
);

dotenv.config({ path: path.join(ROOT, '.env') });

export const LOCALHOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const BASE_RPC_ENV_NAMES = [
  'AJNA_AGENT_NO_SPEND_FORK_RPC_URL',
  'BASE_RPC_URL',
  'AJNA_RPC_URL_BASE',
  'AJNA_AGENT_RPC_URL',
];

export function envValueWithSource(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return { name, value };
    }
  }
  return undefined;
}

export function envValue(...names) {
  return envValueWithSource(...names)?.value;
}

export function isLocalhostUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return LOCALHOST_NAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function assertLocalRpcUrl(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL: ${rawUrl}`);
  }
  if (!LOCALHOST_NAMES.has(parsed.hostname)) {
    throw new Error(`${label} must point to localhost, got ${rawUrl}`);
  }
}

export function resolveForkRpcUrl(options = {}) {
  const configured = envValueWithSource(
    ...(options.envNames ?? BASE_RPC_ENV_NAMES)
  );
  const forkRpcUrl =
    configured?.value ??
    (process.env.ALCHEMY_API_KEY
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      : undefined);
  const source =
    configured?.name ??
    (process.env.ALCHEMY_API_KEY ? 'ALCHEMY_API_KEY' : undefined);

  if (!forkRpcUrl) {
    if (options.required === false) return undefined;
    throw new Error(
      'Missing Base fork RPC. Set BASE_RPC_URL, AJNA_RPC_URL_BASE, AJNA_AGENT_RPC_URL, AJNA_AGENT_NO_SPEND_FORK_RPC_URL, or ALCHEMY_API_KEY.'
    );
  }
  if (options.rejectLocalhost && isLocalhostUrl(forkRpcUrl)) {
    throw new Error(
      `Refusing to use localhost as the Base fork source RPC: ${forkRpcUrl}`
    );
  }
  return { forkRpcUrl, source };
}

export async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function requestJsonRpc(rpcUrl, method, params = [], timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });
    const url = new URL(rpcUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        ...(url.username || url.password
          ? {
              auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(
                url.password
              )}`,
            }
          : {}),
        timeout: timeoutMs,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) {
              reject(
                new Error(`${method} failed: ${JSON.stringify(parsed.error)}`)
              );
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(
              new Error(
                `Failed to parse ${method} response: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            );
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy(new Error(`${method} timed out`));
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

export async function resolveForkBlock(params) {
  const forkRpcUrl = typeof params === 'string' ? params : params.forkRpcUrl;
  const requested =
    typeof params === 'string'
      ? 'latest'
      : params.requested ?? params.requestedForkBlock ?? 'latest';
  const tag =
    requested === 'latest' ? 'latest' : `0x${Number(requested).toString(16)}`;
  const block = await requestJsonRpc(
    forkRpcUrl,
    'eth_getBlockByNumber',
    [tag, false],
    typeof params === 'string' ? 15_000 : params.timeoutMs ?? 15_000
  );
  if (!block?.number || !block?.hash) {
    throw new Error(`Failed to resolve Base fork block for ${requested}`);
  }
  return {
    requested,
    number: Number.parseInt(block.number, 16),
    hash: block.hash,
  };
}

export function redactUrlForReport(rawUrl, source) {
  try {
    const parsed = new URL(rawUrl);
    return {
      source,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      credentialRedacted: Boolean(parsed.username || parsed.password),
    };
  } catch {
    return {
      source,
      protocol: 'unknown',
      hostname: 'unparseable',
      credentialRedacted: true,
    };
  }
}

export function getAllowedHostList(...urls) {
  const hosts = new Set(Array.from(LOCALHOST_NAMES));
  for (const rawUrl of urls) {
    if (!rawUrl) continue;
    try {
      hosts.add(new URL(rawUrl).hostname.toLowerCase());
    } catch {
      // URL validity is checked elsewhere; ignore here so reporting helpers stay side-effect free.
    }
  }
  return Array.from(hosts).sort().join(',');
}

export function baseChildEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? os.homedir(),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    NODE_ENV: 'test',
    ...extra,
  };
}

export function readTail(filePath, maxBytes = 6_000) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  const buffer = fs.readFileSync(filePath);
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString();
}

export function runLoggedCommand(params) {
  return new Promise((resolve) => {
    if (params.label) {
      process.stdout.write(
        `${params.prefix ?? ''}${params.prefix ? ' ' : ''}${params.label}\n`
      );
    }
    const logStream = fs.createWriteStream(params.logPath, { flags: 'a' });
    const child = spawn(params.command[0], params.command.slice(1), {
      cwd: params.cwd ?? ROOT,
      env: {
        ...process.env,
        ...(params.env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timeout =
      params.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => {
              if (child.exitCode === null) {
                child.kill('SIGKILL');
              }
            }, 5_000).unref();
          }, params.timeoutMs);
    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));
    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      logStream.end(() => {
        resolve({
          status: code === 0 && !timedOut ? 'passed' : 'failed',
          exitCode: code,
          signal: signal ?? undefined,
          timedOut,
          logPath: params.logPath,
          tail: code === 0 && !timedOut ? undefined : readTail(params.logPath),
        });
      });
    });
    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      logStream.end(() => {
        resolve({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          logPath: params.logPath,
        });
      });
    });
  });
}

export function runCommandWithTimeout(
  label,
  command,
  env,
  logPath,
  timeoutMs = 180_000
) {
  return runLoggedCommand({
    label,
    prefix: '[no-spend]',
    command,
    env,
    logPath,
    timeoutMs,
  });
}

export function runNodeScript(label, scriptPath, args, env, logPath) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`[no-spend] ${label}\n`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const child = spawn(process.execPath, [TS_NODE_BIN, scriptPath, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logStream.write(chunk));
    child.stderr.on('data', (chunk) => logStream.write(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      logStream.end(() => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `${label} failed${
              signal ? ` with signal ${signal}` : ` with exit code ${code}`
            }\n${readTail(logPath)}`
          )
        );
      });
    });
  });
}

export function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to read ${label} at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
