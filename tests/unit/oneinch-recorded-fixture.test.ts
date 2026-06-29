import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { BigNumber, ethers } from 'ethers';
import {
  convertSwapApiResponseToDetails,
  validateOneInchSwapDetailsForAtomicTake,
} from '../../src/dex/one-inch';

// Real recorded 1inch /swap v6.0 response (Base WETH->USDC), captured with the
// keeper's own request params and committed at tests/fixtures/oneinch-aggregator/.
// It routes through the generic swap executor (selector 0x07ed2379) so the
// GenericRouter ABI decode in convertSwapApiResponseToDetails applies. This
// exercises the decode + atomic-take validation against the ACTUAL 1inch
// calldata shape (which the route-canary only self-encodes), so an ABI/shape
// drift is caught. No network at test time; the snapshot is deterministic.
const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'tests',
  'fixtures',
  'oneinch-aggregator',
  'base-weth-usdc.json'
);

interface OneInchRecordedFixture {
  synthetic: boolean;
  request: {
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    fromAddress: string;
  };
  response: { dstAmount: string; tx: { to: string; data: string; value: string } };
  expected: {
    aggregationExecutor: string;
    minReturnAmount: string;
    amount: string;
    flags: string;
    selector: string;
    dstReceiver: string;
  };
}

function loadFixture(): OneInchRecordedFixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

// `expected` for validateOneInchSwapDetailsForAtomicTake, pinned to the recorded
// route. srcReceiver is the router (tx.to); the validator also accepts
// srcReceiver == the aggregation executor, which is the case for this route.
function expectedFor(fx: OneInchRecordedFixture, executor: string) {
  return {
    srcToken: fx.request.fromTokenAddress,
    dstToken: fx.request.toTokenAddress,
    srcReceiver: fx.response.tx.to,
    dstReceiver: fx.request.fromAddress,
    amount: BigNumber.from(fx.request.amount),
    aggregationExecutors: [executor],
  };
}

describe('1inch recorded-response fixture (real /swap v6, Base WETH->USDC)', () => {
  it('is a real recorded capture, not synthetic', () => {
    expect(loadFixture().synthetic).to.equal(false);
  });

  it('decodes the real generic-swap calldata and validates for an atomic take', () => {
    const fx = loadFixture();
    expect(ethers.utils.hexDataSlice(fx.response.tx.data, 0, 4)).to.equal(
      fx.expected.selector
    );

    const details: any = convertSwapApiResponseToDetails(fx.response.tx);
    expect(ethers.utils.getAddress(details.aggregationExecutor)).to.equal(
      ethers.utils.getAddress(fx.expected.aggregationExecutor)
    );

    const desc = details.swapDescription;
    expect(desc.amount.toString()).to.equal(fx.expected.amount);
    expect(desc.minReturnAmount.toString()).to.equal(fx.expected.minReturnAmount);
    expect(BigNumber.from(desc.minReturnAmount).gt(0)).to.equal(true);
    expect(desc.flags.toString()).to.equal(fx.expected.flags);
    expect(ethers.utils.getAddress(desc.dstReceiver)).to.equal(
      ethers.utils.getAddress(fx.expected.dstReceiver)
    );

    const err = validateOneInchSwapDetailsForAtomicTake(
      details,
      expectedFor(fx, details.aggregationExecutor) as any
    );
    expect(err).to.equal(undefined);
  });

  it('rejects when the aggregation executor is not in the allowlist', () => {
    const fx = loadFixture();
    const details: any = convertSwapApiResponseToDetails(fx.response.tx);
    const err = validateOneInchSwapDetailsForAtomicTake(details, {
      ...expectedFor(fx, details.aggregationExecutor),
      aggregationExecutors: ['0x000000000000000000000000000000000000beef'],
    } as any);
    expect(err).to.be.a('string');
  });

  it('rejects when the output token does not match the pool quote token', () => {
    const fx = loadFixture();
    const details: any = convertSwapApiResponseToDetails(fx.response.tx);
    const err = validateOneInchSwapDetailsForAtomicTake(details, {
      ...expectedFor(fx, details.aggregationExecutor),
      // A valid but wrong output token (WETH, the input) must be rejected: the
      // validator enforces output-token == pool quote token.
      dstToken: fx.request.fromTokenAddress,
    } as any);
    expect(err).to.be.a('string');
  });
});
