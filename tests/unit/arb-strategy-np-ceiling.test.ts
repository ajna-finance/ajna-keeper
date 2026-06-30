import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import * as erc20 from '../../src/erc20';
import {
  createArbTakeStrategy,
  resolveSelfKickNpCeiling,
} from '../../src/take/arb-strategy';

// P2 self-penalty wiring: the take path caps its own arbTake bucket at the
// auction neutralPrice for auctions THIS keeper kicked (read on-chain from
// auctionInfo: kicker + neutralPrice), so a bucketTake can never clear above NP
// and penalize the keeper's bond. Auctions kicked by others are uncapped.
describe('resolveSelfKickNpCeiling', () => {
  afterEach(() => sinon.restore());

  const makePool = (kicker: string, neutralPriceWad = ethers.utils.parseEther('7')) =>
    ({
      name: 'NP Pool',
      contract: {
        auctionInfo: sinon
          .stub()
          .resolves({ kicker_: kicker, neutralPrice_: neutralPriceWad }),
      },
    }) as any;

  const signer = (address: string) =>
    ({ getAddress: sinon.stub().resolves(address) }) as any;

  it('returns the neutralPrice when this keeper is the kicker (case-insensitive)', async () => {
    const ceiling = await resolveSelfKickNpCeiling(
      makePool('0xABCDEF0000000000000000000000000000000001'),
      signer('0xabcdef0000000000000000000000000000000001'),
      '0xBorrower'
    );
    expect(ceiling).to.equal(7);
  });

  it('returns undefined for an auction kicked by someone else', async () => {
    const ceiling = await resolveSelfKickNpCeiling(
      makePool('0x9999999999999999999999999999999999999999'),
      signer('0xabcdef0000000000000000000000000000000001'),
      '0xBorrower'
    );
    expect(ceiling).to.equal(undefined);
  });

  it('falls back to undefined (uncapped) when auctionInfo cannot be read', async () => {
    const pool = {
      name: 'NP Pool',
      contract: { auctionInfo: sinon.stub().rejects(new Error('rpc down')) },
    } as any;
    const ceiling = await resolveSelfKickNpCeiling(
      pool,
      signer('0xbot'),
      '0xBorrower'
    );
    expect(ceiling).to.equal(undefined);
  });
});

describe('evaluateArbTake applies the NP ceiling for self-kicked auctions', () => {
  afterEach(() => sinon.restore());

  // hmbPrice=10, factor=0.9 -> uncapped threshold 9. Auction price 8 is below
  // 9 (uncapped takeable), but a self-kick NP of 7 caps it below 8.
  function makePool(kicker: string) {
    return {
      name: 'Test Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      collateralAddress: '0x2222222222222222222222222222222222222222',
      getPrices: sinon.stub().resolves({ hpb: ethers.utils.parseEther('10') }),
      getBucketByIndex: sinon
        .stub()
        .returns({ price: ethers.utils.parseEther('10') }),
      contract: {
        auctionInfo: sinon
          .stub()
          .resolves({ kicker_: kicker, neutralPrice_: ethers.utils.parseEther('7') }),
      },
    } as any;
  }

  const poolConfig = {
    name: 'Test Pool',
    take: { minCollateral: 1, hpbPriceFactor: 0.9 },
  } as any;

  const subgraph = {
    cacheKey: 'test-subgraph',
    getHighestMeaningfulBucket: async () => ({ buckets: [{ bucketIndex: 321 }] }),
  } as any;

  const evalArgs = (kicker: string) => ({
    pool: makePool(kicker),
    signer: { getAddress: sinon.stub().resolves('0xBOT') } as any,
    poolConfig,
    subgraph,
    price: 8,
    auctionPrice: ethers.utils.parseEther('8'),
    collateral: ethers.utils.parseEther('2'),
    borrower: '0xBorrower',
  });

  it('skips the self-kicked arbTake when the bucket clears above NP', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    const result = await createArbTakeStrategy().evaluateArbTake(
      evalArgs('0xBOT')
    );
    expect(result.isArbTakeable).to.equal(false);
    expect(result.maxArbTakePrice).to.equal(7); // capped at NP
  });

  it('leaves an auction kicked by someone else uncapped', async () => {
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    const result = await createArbTakeStrategy().evaluateArbTake(
      evalArgs('0xSomeoneElse')
    );
    expect(result.isArbTakeable).to.equal(true);
    expect(result.maxArbTakePrice).to.equal(9); // uncapped threshold
  });
});
