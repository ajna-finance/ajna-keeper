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

let stateFilePath = DEFAULT_STATE_FILE;
let loaded = false;
let loadPromise: Promise<void> | undefined;
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

async function ensureLoaded(): Promise<void> {
  if (loaded) {
    return;
  }

  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = (async () => {
    try {
      const raw = await fsPromises.readFile(stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as DurableNonceFloorStateFile;
      entries.clear();
      for (const entry of parsed.entries ?? []) {
        const normalized = normalizeEntry(entry);
        entries.set(
          keyFor(normalized.chainId, normalized.address),
          normalized
        );
      }
      loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        entries.clear();
        loaded = true;
        return;
      }
      throw error;
    } finally {
      loadPromise = undefined;
    }
  })();

  await loadPromise;
}

async function saveState(): Promise<void> {
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
  await ensureLoaded();
  const normalized = normalizeEntry(entry);
  const key = keyFor(normalized.chainId, normalized.address);
  const existing = entries.get(key);
  if (existing && existing.nextNonce > normalized.nextNonce) {
    return;
  }
  entries.set(key, normalized);
  await saveState();
}

export async function clearDurableNonceFloor(
  chainId: number,
  address: string
): Promise<boolean> {
  await ensureLoaded();
  const deleted = entries.delete(keyFor(chainId, address));
  if (deleted) {
    await saveState();
  }
  return deleted;
}

export function setDurableNonceStateFilePathForTests(
  filePath?: string
): void {
  stateFilePath = path.resolve(filePath ?? DEFAULT_STATE_FILE);
  loaded = false;
  loadPromise = undefined;
  entries.clear();
}

export function clearDurableNonceStateForTests(): void {
  entries.clear();
  loaded = false;
  loadPromise = undefined;
  try {
    fs.rmSync(stateFilePath, { force: true });
  } catch {
    // ignore test cleanup failures
  }
}
