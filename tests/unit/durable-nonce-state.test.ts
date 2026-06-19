import fs from 'fs';
import path from 'path';
import { expect } from 'chai';
import {
  getDurableNonceFloor,
  upsertDurableNonceFloor,
  setDurableNonceStateFilePathForTests,
  clearDurableNonceStateForTests,
} from '../../src/durable-nonce-state';

describe('durable nonce state', () => {
  let durableStatePath: string;

  beforeEach(() => {
    durableStatePath = path.join(
      '/tmp',
      `ajna-keeper-durable-state-${Date.now()}-${Math.random()}.json`
    );
    setDurableNonceStateFilePathForTests(durableStatePath);
    clearDurableNonceStateForTests();
  });

  afterEach(() => {
    clearDurableNonceStateForTests();
  });

  it('reloads durable nonce floors when another process updates the state file', async () => {
    const address = '0x00000000000000000000000000000000000000aa';

    await upsertDurableNonceFloor({
      chainId: 1,
      address,
      nextNonce: 7,
      submittedAtMs: 123,
    });

    const initialEntry = await getDurableNonceFloor(1, address);
    expect(initialEntry?.nextNonce).to.equal(7);

    fs.writeFileSync(
      durableStatePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            chainId: 1,
            address,
            nextNonce: 9,
            submittedAtMs: 456,
          },
        ],
      }),
      'utf8'
    );

    const updatedEntry = await getDurableNonceFloor(1, address);
    expect(updatedEntry?.nextNonce).to.equal(9);
  });

  // P1-3 nonce consistency on SIGTERM mid-broadcast: a take/settlement broadcast
  // persists its durable nonce floor BEFORE the receipt confirms, so if the
  // process is killed mid-broadcast the floor survives on disk and the restarted
  // keeper resumes from it — it cannot reuse the in-flight nonce (a gap/dup that
  // would strand the wallet).
  it('preserves the durable nonce floor across a simulated restart (SIGTERM mid-broadcast)', async () => {
    const address = '0x00000000000000000000000000000000000000bb';

    // Keeper broadcast nonce 7 -> persists floor nextNonce=8 before confirmation.
    await upsertDurableNonceFloor({
      chainId: 8453,
      address,
      nextNonce: 8,
      submittedAtMs: 1000,
    });
    // Durable on disk — survives process death.
    const onDisk = JSON.parse(fs.readFileSync(durableStatePath, 'utf8'));
    expect(
      onDisk.entries.find(
        (e: any) => e.address.toLowerCase() === address.toLowerCase()
      )?.nextNonce
    ).to.equal(8);

    // Simulate a fresh process start: reset in-memory state, KEEP the file.
    setDurableNonceStateFilePathForTests(durableStatePath);
    const afterRestart = await getDurableNonceFloor(8453, address);
    expect(afterRestart?.nextNonce).to.equal(8); // resumes at the floor, no reuse of 7

    // A stale/lower floor (e.g. a racing reload) must NOT lower it — monotonic,
    // so no path can roll back into reusing an already-broadcast nonce.
    await upsertDurableNonceFloor({
      chainId: 8453,
      address,
      nextNonce: 6,
      submittedAtMs: 500,
    });
    const afterStale = await getDurableNonceFloor(8453, address);
    expect(afterStale?.nextNonce).to.equal(8);
  });

  it('merges on-disk durable nonce floors instead of clobbering them on save', async () => {
    const addressA = '0x00000000000000000000000000000000000000aa';
    const addressB = '0x00000000000000000000000000000000000000bb';

    await upsertDurableNonceFloor({
      chainId: 1,
      address: addressA,
      nextNonce: 7,
      submittedAtMs: 123,
    });

    fs.writeFileSync(
      durableStatePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            chainId: 1,
            address: addressA,
            nextNonce: 7,
            submittedAtMs: 123,
          },
          {
            chainId: 1,
            address: addressB,
            nextNonce: 11,
            submittedAtMs: 456,
          },
        ],
      }),
      'utf8'
    );

    await upsertDurableNonceFloor({
      chainId: 1,
      address: addressA,
      nextNonce: 8,
      submittedAtMs: 789,
    });

    const parsed = JSON.parse(fs.readFileSync(durableStatePath, 'utf8'));
    expect(parsed.entries).to.deep.include({
      chainId: 1,
      address: addressA.toLowerCase(),
      nextNonce: 8,
      submittedAtMs: 789,
    });
    expect(parsed.entries).to.deep.include({
      chainId: 1,
      address: addressB.toLowerCase(),
      nextNonce: 11,
      submittedAtMs: 456,
    });
  });

  it('clears a stale lock file before persisting durable nonce floors', async () => {
    const lockPath = `${durableStatePath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'stale lock', 'utf8');
    fs.utimesSync(
      lockPath,
      new Date(Date.now() - 20_000),
      new Date(Date.now() - 20_000)
    );

    await upsertDurableNonceFloor({
      chainId: 1,
      address: '0x00000000000000000000000000000000000000aa',
      nextNonce: 7,
      submittedAtMs: 123,
    });

    const entry = await getDurableNonceFloor(
      1,
      '0x00000000000000000000000000000000000000aa'
    );
    expect(entry?.nextNonce).to.equal(7);
    expect(fs.existsSync(lockPath)).to.equal(false);
  });

  it('retries loading after a corrupted state file is corrected', async () => {
    const address = '0x00000000000000000000000000000000000000aa';
    fs.writeFileSync(durableStatePath, '{invalid json', 'utf8');

    try {
      await getDurableNonceFloor(1, address);
      expect.fail('Expected corrupted durable nonce state to throw');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
    }

    fs.writeFileSync(
      durableStatePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            chainId: 1,
            address,
            nextNonce: 7,
            submittedAtMs: 123,
          },
        ],
      }),
      'utf8'
    );

    const entry = await getDurableNonceFloor(1, address);
    expect(entry?.nextNonce).to.equal(7);
  });
});
