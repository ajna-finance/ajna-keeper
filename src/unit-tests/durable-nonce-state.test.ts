import fs from 'fs';
import path from 'path';
import { expect } from 'chai';
import {
  getDurableNonceFloor,
  upsertDurableNonceFloor,
  setDurableNonceStateFilePathForTests,
  clearDurableNonceStateForTests,
} from '../durable-nonce-state';

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
