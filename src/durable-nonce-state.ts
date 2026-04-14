import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';

export interface DurableNonceFloorEntry {
  chainId: number;
  address: string;
  nextNonce: number;
  txHash?: string;
  submittedAtMs: number;
  expiresAtBlock?: number;
  relayUrl?: string;
}

interface DurableNonceFloorStateFile {
  version: 1;
  entries: DurableNonceFloorEntry[];
}

const DEFAULT_STATE_FILE = path.resolve(
  process.env.AJNA_KEEPER_DURABLE_NONCE_STATE_FILE ??
    path.join('local', 'take-write-relay-state.json')
);
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_TIMEOUT_MS = 2_000;

let stateFilePath = DEFAULT_STATE_FILE;
let loaded = false;
let loadPromise: Promise<void> | undefined;
let lastLoadedMtimeMs: number | undefined;
const entries = new Map<string, DurableNonceFloorEntry>();

function keyFor(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

function normalizeEntry(entry: DurableNonceFloorEntry): DurableNonceFloorEntry {
  return {
    ...entry,
    address: entry.address.toLowerCase(),
  };
}

function getStateLockPath(): string {
  return `${stateFilePath}.lock`;
}

async function getStateFileMtimeMs(): Promise<number | undefined> {
  try {
    const stat = await fsPromises.stat(stateFilePath);
    return stat.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function loadEntriesFromStateFile(parsed: DurableNonceFloorStateFile): void {
  entries.clear();
  for (const entry of parsed.entries ?? []) {
    const normalized = normalizeEntry(entry);
    entries.set(keyFor(normalized.chainId, normalized.address), normalized);
  }
}

async function reloadFromDisk(): Promise<void> {
  const raw = await fsPromises.readFile(stateFilePath, 'utf8');
  const parsed = JSON.parse(raw) as DurableNonceFloorStateFile;
  loadEntriesFromStateFile(parsed);
  loaded = true;
  lastLoadedMtimeMs = await getStateFileMtimeMs();
}

function resetLoadedState(): void {
  entries.clear();
  loaded = true;
  lastLoadedMtimeMs = undefined;
}

async function ensureLoaded(): Promise<void> {
  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = (async () => {
    try {
      await reloadFromDisk();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        resetLoadedState();
        return;
      }
      throw error;
    } finally {
      loadPromise = undefined;
    }
  })();

  await loadPromise;
}

async function acquireStateLock() {
  await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      return await fsPromises.open(getStateLockPath(), 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring durable nonce state lock for ${stateFilePath}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, STATE_LOCK_RETRY_MS));
    }
  }
}

async function releaseStateLock(lockHandle: Awaited<ReturnType<typeof fsPromises.open>>): Promise<void> {
  try {
    await lockHandle.close();
  } finally {
    await fsPromises.rm(getStateLockPath(), { force: true });
  }
}

async function persistLoadedEntries(): Promise<void> {
  await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
  const tmpPath = `${stateFilePath}.tmp`;
  const payload: DurableNonceFloorStateFile = {
    version: 1,
    entries: Array.from(entries.values()).sort((a, b) =>
      keyFor(a.chainId, a.address).localeCompare(keyFor(b.chainId, b.address))
    ),
  };
  await fsPromises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  await fsPromises.rename(tmpPath, stateFilePath);
  loaded = true;
  lastLoadedMtimeMs = await getStateFileMtimeMs();
}

async function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockHandle = await acquireStateLock();
  try {
    return await operation();
  } finally {
    await releaseStateLock(lockHandle);
  }
}

export async function getDurableNonceFloor(
  chainId: number,
  address: string
): Promise<DurableNonceFloorEntry | undefined> {
  await ensureLoaded();
  return entries.get(keyFor(chainId, address));
}

export async function upsertDurableNonceFloor(
  entry: DurableNonceFloorEntry
): Promise<void> {
  await withStateLock(async () => {
    try {
      await reloadFromDisk();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        resetLoadedState();
      } else {
        throw error;
      }
    }

    const normalized = normalizeEntry(entry);
    const key = keyFor(normalized.chainId, normalized.address);
    const existing = entries.get(key);
    if (existing && existing.nextNonce > normalized.nextNonce) {
      return;
    }
    entries.set(key, normalized);
    await persistLoadedEntries();
  });
}

export async function clearDurableNonceFloor(
  chainId: number,
  address: string
): Promise<boolean> {
  return await withStateLock(async () => {
    try {
      await reloadFromDisk();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        resetLoadedState();
      } else {
        throw error;
      }
    }

    const deleted = entries.delete(keyFor(chainId, address));
    if (deleted) {
      await persistLoadedEntries();
    }
    return deleted;
  });
}

export function setDurableNonceStateFilePathForTests(
  filePath?: string
): void {
  stateFilePath = path.resolve(filePath ?? DEFAULT_STATE_FILE);
  loaded = false;
  loadPromise = undefined;
  lastLoadedMtimeMs = undefined;
  entries.clear();
}

export function clearDurableNonceStateForTests(): void {
  entries.clear();
  loaded = false;
  loadPromise = undefined;
  lastLoadedMtimeMs = undefined;
  try {
    fs.rmSync(stateFilePath, { force: true });
    fs.rmSync(getStateLockPath(), { force: true });
  } catch {
    // ignore test cleanup failures
  }
}
