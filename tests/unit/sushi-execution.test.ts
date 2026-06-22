import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { BigNumber, ethers } from 'ethers';
import { LiquiditySource, TakeWriteTransportMode } from '../../src/config';
import { takeLiquidationSushiAggregator } from '../../src/take/sushi-aggregator/execution';
import {
  SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
} from '../../src/dex/sushi-aggregator/scope';
import { TakerRouter__factory } from '../../typechain-types/factories/contracts/factories';
import { NonceTracker } from '../../src/nonce';
import { malformedSingleExternalTakeExecutionPlan } from '../helpers/external-take-plan';

// The Sushi calldata-aggregator EXECUTION entry (takeLiquidationSushiAggregator)
// had no unit test — only its LI.FI sibling (lifi-execution.test.ts) did, so the
// Sushi-specific composition (taker resolution via config.sushiAggregatorTaker,
// the Sushi quote service fetch+validate+normalize, the provider id threading)
// was never isolated. These mirror the LI.FI execution tests for Sushi, using the
// recorded Base WETH/USDC fixture as the stubbed Sushi v7 quote.
describe('Sushi aggregator execution', () => {
  const CHAIN_ID = 8453;
  // The fixture quote was recorded for taker 0x...dead; the validator matches the
  // quote recipient to the taker, so the Sushi taker must be that address.
  const SUSHI_TAKER = '0x000000000000000000000000000000000000dead';

  function loadFixtureResponse(): Record<string, unknown> {
    const fixturePath = path.join(
      __dirname,
      '..',
      'fixtures',
      'sushi-aggregator',
      'base-weth-usdc.json'
    );
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8')).response;
  }

  afterEach(() => {
    NonceTracker.clearNonces();
    sinon.restore();
  });

  it('reports a pre-rejected Sushi plan as a pre-broadcast failure (hybrid fallback)', async () => {
    const onCalldataAggregatorExecutionFailure = sinon.spy();
    const succeeded = await takeLiquidationSushiAggregator({
      pool: {
        name: 'Sushi Reject Pool',
        poolAddress: '0x1111111111111111111111111111111111111111',
      } as any,
      signer: {} as any,
      poolConfig: {
        take: { liquiditySource: LiquiditySource.SUSHI_AGGREGATOR },
      } as any,
      liquidation: {
        borrower: '0x2222222222222222222222222222222222222222',
        auctionPrice: ethers.utils.parseEther('100'),
        collateral: ethers.utils.parseEther('1'),
        externalTakeExecutionPlan: malformedSingleExternalTakeExecutionPlan({
          isTakeable: false,
          externalTakePath: 'calldata_aggregator',
          providerId: 'sushi_aggregator',
          selectedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
          reason: 'Sushi fresh quote min output below execution floor',
        }),
      } as any,
      config: { onCalldataAggregatorExecutionFailure } as any,
    });

    expect(succeeded).to.equal(false);
    expect(onCalldataAggregatorExecutionFailure.calledOnce).to.equal(true);
    expect(
      onCalldataAggregatorExecutionFailure.firstCall.args[0].preBroadcast
    ).to.equal(true);
  });

  it('resolves the Sushi taker from config.sushiAggregatorTaker and rejects (no fetch) when it is missing', async () => {
    const axiosGet = sinon.stub(axios, 'get');
    const onCalldataAggregatorExecutionFailure = sinon.spy();
    const succeeded = await takeLiquidationSushiAggregator({
      pool: {
        name: 'Sushi No-Taker Pool',
        poolAddress: '0x1111111111111111111111111111111111111111',
        collateralAddress: '0x4200000000000000000000000000000000000006',
        quoteAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      } as any,
      signer: { getChainId: sinon.stub().resolves(CHAIN_ID) } as any,
      poolConfig: {
        take: { liquiditySource: LiquiditySource.SUSHI_AGGREGATOR },
      } as any,
      liquidation: {
        borrower: '0x2222222222222222222222222222222222222222',
        auctionPrice: ethers.utils.parseEther('100'),
        collateral: ethers.utils.parseEther('1'),
        externalTakeExecutionPlan: malformedSingleExternalTakeExecutionPlan({
          isTakeable: true,
          externalTakePath: 'calldata_aggregator',
          providerId: 'sushi_aggregator',
          selectedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
          approvedMinOutRaw: BigNumber.from(1),
          quoteAmountRaw: BigNumber.from('1673607541'),
          routeMinOutRaw: BigNumber.from('1665239503'),
          calldataQuote: {
            providerId: 'sushi_aggregator',
            quoteAmountRaw: BigNumber.from('1673607541'),
            routeMinOutRaw: BigNumber.from('1665239503'),
          },
        }),
      } as any,
      config: {
        keeperTakerRouter: '0x9999999999999999999999999999999999999999',
        // sushiAggregatorTaker intentionally absent
        chainId: CHAIN_ID,
        sushiAggregator: {
          mode: 'production',
          callTargetAllowlist: SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
          approvalSpenderAllowlist:
            SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
          selectorAllowlist: SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
        },
        tokenDecimalsCache: new Map([
          [`${CHAIN_ID}:0x4200000000000000000000000000000000000006`, 18],
        ]),
        onCalldataAggregatorExecutionFailure,
      } as any,
    });

    expect(succeeded).to.equal(false);
    // The Sushi quote service must NOT be reached when the taker is unresolved.
    expect(axiosGet.called).to.equal(false);
  });

  it('fetches + executes via the Sushi quote service (takerAddress + pool tokens in the request)', async () => {
    const axiosGet = sinon
      .stub(axios, 'get')
      .resolves({ status: 200, data: loadFixtureResponse() } as any);

    const estimateGas = sinon.stub().resolves(BigNumber.from(500_000));
    const populateTransaction = sinon.stub().resolves({
      to: '0x9999999999999999999999999999999999999999',
      data: '0x',
    });
    sinon.stub(TakerRouter__factory, 'connect').returns({
      estimateGas: { takeWithAtomicSwap: estimateGas },
      populateTransaction: { takeWithAtomicSwap: populateTransaction },
    } as any);

    const getTransactionCount = sinon.stub().resolves(0);
    const submitTransaction = sinon.stub().resolves({
      wait: sinon.stub().resolves({ status: 1 }),
    } as any);
    const collateral = '0x4200000000000000000000000000000000000006';
    const quoteToken = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const fromAmount = ethers.utils.parseEther('1');
    const quoteAmountRaw = BigNumber.from('1673607541');
    const routeMinOutRaw = BigNumber.from('1665239503');

    const succeeded = await takeLiquidationSushiAggregator({
      pool: {
        name: 'Sushi Exec Pool',
        poolAddress: '0x7777777777777777777777777777777777777777',
        collateralAddress: collateral,
        quoteAddress: quoteToken,
      } as any,
      signer: { getChainId: sinon.stub().resolves(CHAIN_ID) } as any,
      poolConfig: {
        take: { liquiditySource: LiquiditySource.SUSHI_AGGREGATOR },
      } as any,
      liquidation: {
        borrower: '0x8888888888888888888888888888888888888888',
        auctionPrice: ethers.utils.parseEther('100'),
        collateral: fromAmount,
        externalTakeExecutionPlan: malformedSingleExternalTakeExecutionPlan({
          isTakeable: true,
          externalTakePath: 'calldata_aggregator',
          selectedLiquiditySource: LiquiditySource.SUSHI_AGGREGATOR,
          quoteAmountRaw,
          routeMinOutRaw,
          approvedMinOutRaw: BigNumber.from(1),
          calldataQuote: {
            providerId: 'sushi_aggregator',
            quoteAmountRaw,
            routeMinOutRaw,
          },
        }),
      } as any,
      config: {
        keeperTakerRouter: '0x9999999999999999999999999999999999999999',
        sushiAggregatorTaker: SUSHI_TAKER,
        chainId: CHAIN_ID,
        sushiAggregator: {
          mode: 'production',
          callTargetAllowlist: SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
          approvalSpenderAllowlist:
            SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
          selectorAllowlist: SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
        },
        tokenDecimalsCache: new Map([[`${CHAIN_ID}:${collateral}`, 18]]),
        takeWriteTransport: {
          mode: TakeWriteTransportMode.PUBLIC_RPC,
          signer: {
            getAddress: sinon
              .stub()
              .resolves('0x6666666666666666666666666666666666666666'),
            getTransactionCount,
          },
          submitTransaction,
        },
        onCalldataAggregatorExecutionFailure: sinon.spy(),
      } as any,
    });

    // The Sushi quote service was invoked with the pool tokens + taker (the
    // provider-specific composition this test exists to pin).
    expect(axiosGet.calledOnce).to.equal(true);
    const url = String(axiosGet.firstCall.args[0]);
    expect(url).to.include(`/${CHAIN_ID}`);
    expect(url).to.include(`tokenIn=${collateral}`);
    expect(url).to.include(`tokenOut=${quoteToken}`);
    expect(url).to.include(`amount=${fromAmount.toString()}`);
    expect(url).to.include(`sender=${SUSHI_TAKER}`);
    // The validated+normalized Sushi quote drove the take through submission to a
    // successful receipt — the full Sushi composition end-to-end (fetch ->
    // validate -> normalize -> floor/age/context -> exact-fill -> submit).
    expect(submitTransaction.calledOnce).to.equal(true);
    expect(succeeded).to.equal(true);
  });
});
