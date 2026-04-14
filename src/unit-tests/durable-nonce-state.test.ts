import fs from 'fs';
import path from 'path';
import { expect } from 'chai';
import {
  getDurableNonceFloor,
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
