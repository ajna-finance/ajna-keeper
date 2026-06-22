import { expect } from 'chai';
import { BigNumber, Signer, Wallet, constants, providers, utils } from 'ethers';
import { network } from 'hardhat';
import { LiquiditySource } from '../../../src/config';
import { AGGREGATOR_SWAP_DETAILS_TUPLE_ABI } from '../../../src/take/aggregator-calldata/execution';
import type { BaseAggregatorCalldataTaker } from '../../../typechain-types';
import {
  CurveKeeperTaker__factory,
  UniswapV3KeeperTaker__factory,
} from '../../../typechain-types/factories/contracts/takers';
import { TakerRouter__factory } from '../../../typechain-types/factories/contracts/factories';
import {
  MockAtomicSwapPool__factory,
  MockCurveSwapPool__factory,
  MockERC20__factory,
  MockFeeOnTransferERC20__factory,
  MockLifiSwapTarget__factory,
  MockMinOutBypassSwap__factory,
  MockPoolDeployer__factory,
  MockSwapRouter02__factory,
} from '../../../typechain-types/factories/contracts/mocks';

export const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
export const DEADLINE = 4_102_444_800;
export const ZERO_FACTORY = constants.AddressZero;

// Keeper- and callback-payload detail shapes shared by the taker contracts.
export const UNISWAP_DETAILS_TYPE = '(address,address,uint24,uint256,uint256)';
export const CURVE_DETAILS_TYPE =
  '(address,address,address,uint8,uint8,uint8,uint256,uint256)';

export function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

export async function fundSigner(address: string) {
  await network.provider.send('hardhat_setBalance', [
    address,
    utils.parseEther('10').toHexString(),
  ]);
}

/**
 * Extracts only the revert-reason segments from a hardhat/ethers error
 * message. Hardhat embeds contract source (sourceContent) in some revert
 * errors, so matching against the full message can FALSE-PASS on any
 * identifier that merely appears in the source code. Matching against the
 * extracted segments binds assertions to the actual revert reason. Falls back
 * to the full message when no revert pattern is present (plain JS errors).
 */
export function extractRevertSegments(message: string): string {
  const patterns = [
    /reverted with reason string '[^']*'/g,
    /reverted with custom error '[^']*'/g,
    /reverted with panic code [^\s,)]+/g,
    /reverted with an unrecognized custom error \(return data: 0x[0-9a-fA-F]*\)/g,
    /Transaction reverted without a reason string/g,
    /Transaction reverted: function call to a non-contract account/g,
  ];
  const segments: string[] = [];
  for (const pattern of patterns) {
    for (const match of message.match(pattern) ?? []) {
      segments.push(match);
    }
  }
  return segments.length > 0 ? segments.join('\n') : message;
}

export async function expectRevertContaining(
  action: Promise<unknown>,
  expected: string
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected revert containing "${expected}"`).to.be.instanceOf(
    Error
  );
  const revertSegments = extractRevertSegments((caught as Error).message);
  expect(
    revertSegments,
    `expected revert reason containing "${expected}"`
  ).to.contain(expected);
}

/**
 * Deploys the common mock take stack: funded owner, collateral/quote tokens,
 * pool deployer registry, and a registered MockAtomicSwapPool.
 */
export async function deployMockTakerBase(
  options: {
    collateralDecimals?: number;
    quoteDecimals?: number;
    quoteTokenScale?: BigNumber;
    // When set, the quote token charges this fee (bps) on every transfer, so the
    // pool receives less than is repaid — exercises the exact-fill backstop.
    feeOnTransferQuoteBps?: number;
  } = {}
) {
  const owner = Wallet.createRandom().connect(getProvider());
  await fundSigner(owner.address);

  const collateralToken = await new MockERC20__factory(owner).deploy(
    'Mock Collateral',
    'MCOLL',
    options.collateralDecimals ?? 18
  );
  await collateralToken.deployed();

  const quoteToken = options.feeOnTransferQuoteBps
    ? ((await (async () => {
        const fee = await new MockFeeOnTransferERC20__factory(owner).deploy(
          'Mock Quote',
          'MQUOTE',
          options.quoteDecimals ?? 18,
          options.feeOnTransferQuoteBps!
        );
        await fee.deployed();
        return fee;
      })()) as unknown as Awaited<
        ReturnType<MockERC20__factory['deploy']>
      >)
    : await new MockERC20__factory(owner).deploy(
        'Mock Quote',
        'MQUOTE',
        options.quoteDecimals ?? 18
      );
  await quoteToken.deployed();

  const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
  await poolDeployer.deployed();

  const pool = await new MockAtomicSwapPool__factory(owner).deploy(
    collateralToken.address,
    quoteToken.address,
    options.quoteTokenScale ?? BigNumber.from(1)
  );
  await pool.deployed();

  await poolDeployer.setDeployedPool(
    ERC20_NON_SUBSET_HASH,
    collateralToken.address,
    quoteToken.address,
    pool.address
  );

  return { owner, collateralToken, quoteToken, poolDeployer, pool };
}

export type MockTakerBase = Awaited<ReturnType<typeof deployMockTakerBase>>;

export async function deployUniswapTaker(
  base: MockTakerBase,
  authorizedRouter: string = ZERO_FACTORY
) {
  const taker = await new UniswapV3KeeperTaker__factory(base.owner).deploy(
    base.poolDeployer.address,
    authorizedRouter
  );
  await taker.deployed();
  return taker;
}

export async function deployCurveTaker(
  base: MockTakerBase,
  authorizedRouter: string = ZERO_FACTORY
) {
  const taker = await new CurveKeeperTaker__factory(base.owner).deploy(
    base.poolDeployer.address,
    authorizedRouter
  );
  await taker.deployed();
  return taker;
}

/** Standard borrower address shared by the aggregator-taker take fixtures. */
export const AGGREGATOR_TAKE_BORROWER = utils.getAddress(
  '0x00000000000000000000000000000000000000b0'
);

type AggregatorTakerFactory<T extends BaseAggregatorCalldataTaker> = new (
  signer: Signer
) => { deploy(poolDeployer: string, router: string): Promise<T> };

/**
 * Deploys a calldata-aggregator taker (1inch/Sushi/LI.FI shape) behind a fresh
 * TakerRouter, registers it at `source`, and allowlists a MockLifiSwapTarget for
 * `mockSwap`. The taker type is inferred from the passed `__factory`, so callers
 * keep full provider-specific typing on the returned `taker`.
 */
export async function deployAggregatorTaker<
  T extends BaseAggregatorCalldataTaker,
>(
  base: MockTakerBase,
  params: { Factory: AggregatorTakerFactory<T>; source: LiquiditySource }
) {
  const { owner, poolDeployer, pool, collateralToken, quoteToken } = base;

  const factory = await new TakerRouter__factory(owner).deploy(
    poolDeployer.address
  );
  await factory.deployed();

  const taker = await new params.Factory(owner).deploy(
    poolDeployer.address,
    factory.address
  );
  await taker.deployed();

  const target = await new MockLifiSwapTarget__factory(owner).deploy();
  await target.deployed();

  await factory.setTaker(params.source, taker.address);
  const selector = target.interface.getSighash('mockSwap');
  await taker.setCallTarget(target.address, true);
  await taker.setApprovalSpender(target.address, true);
  await taker.setCallSelector(target.address, selector, true);

  return {
    owner,
    collateral: collateralToken,
    quote: quoteToken,
    pool,
    poolDeployer,
    factory,
    taker,
    target,
  };
}

/**
 * Deploys an aggregator-taker fixture and stages a single mockSwap take through
 * TakerRouter: collateral in the pool, output quote in the target, the amount due
 * pre-funded+approved on the owner, and an encoded details/callData pair. Returns
 * the fixture plus a `send()` that fires the take, so each test asserts deltas
 * instead of re-staging the swap. `detailsAmountIn` defaults to `amountIn`; set it
 * higher to model stale (drifted) quoted calldata.
 */
export async function executeAggregatorTake<
  T extends BaseAggregatorCalldataTaker,
>(params: {
  Factory: AggregatorTakerFactory<T>;
  source: LiquiditySource;
  amountIn?: BigNumber;
  detailsAmountIn?: BigNumber;
  outputAmount?: BigNumber;
  quoteAmountDue?: BigNumber;
  amountOutMinimum?: BigNumber;
  feeOnTransferQuoteBps?: number;
}) {
  const base = await deployMockTakerBase({
    feeOnTransferQuoteBps: params.feeOnTransferQuoteBps,
  });
  const fixture = await deployAggregatorTaker(base, {
    Factory: params.Factory,
    source: params.source,
  });
  const amountIn = params.amountIn ?? utils.parseEther('1');
  const detailsAmountIn = params.detailsAmountIn ?? amountIn;
  const outputAmount = params.outputAmount ?? utils.parseEther('1.25');
  const quoteAmountDue = params.quoteAmountDue ?? utils.parseEther('1');
  const amountOutMinimum = params.amountOutMinimum ?? utils.parseEther('1.1');

  await fixture.collateral.mint(fixture.pool.address, amountIn);
  await fixture.quote.mint(fixture.target.address, outputAmount);
  await fixture.quote.mint(fixture.owner.address, quoteAmountDue);
  await fixture.quote
    .connect(fixture.owner)
    .approve(fixture.pool.address, constants.MaxUint256);
  await fixture.pool.setQuoteAmountDue(quoteAmountDue);

  const callData = fixture.target.interface.encodeFunctionData('mockSwap', [
    fixture.collateral.address,
    fixture.quote.address,
    fixture.taker.address,
    detailsAmountIn,
    outputAmount,
  ]);
  const details = utils.defaultAbiCoder.encode(
    [AGGREGATOR_SWAP_DETAILS_TUPLE_ABI],
    [
      {
        approvalSpender: fixture.target.address,
        srcToken: fixture.collateral.address,
        dstToken: fixture.quote.address,
        dstReceiver: fixture.taker.address,
        amountInTokenUnits: detailsAmountIn,
        amountOutMinimum,
        callData,
      },
    ]
  );

  const send = () =>
    fixture.factory.takeWithAtomicSwap(
      fixture.pool.address,
      AGGREGATOR_TAKE_BORROWER,
      constants.WeiPerEther,
      amountIn,
      params.source,
      fixture.target.address,
      details
    );

  return {
    ...fixture,
    amountIn,
    detailsAmountIn,
    outputAmount,
    quoteAmountDue,
    amountOutMinimum,
    details,
    send,
  };
}

export async function deployFundedSwapRouter02(
  base: MockTakerBase,
  amountOut: BigNumber
) {
  const router = await new MockSwapRouter02__factory(base.owner).deploy(
    amountOut
  );
  await router.deployed();
  if (amountOut.gt(0)) {
    await base.quoteToken.mint(router.address, amountOut);
  }
  return router;
}

export async function deployMinOutBypassSwap(
  base: MockTakerBase,
  actualAmountOut: BigNumber,
  reportedAmountOut: BigNumber
) {
  const router = await new MockMinOutBypassSwap__factory(base.owner).deploy(
    base.collateralToken.address,
    base.quoteToken.address,
    actualAmountOut,
    reportedAmountOut
  );
  await router.deployed();
  if (actualAmountOut.gt(0)) {
    await base.quoteToken.mint(router.address, actualAmountOut);
  }
  return router;
}

export async function deployFundedCurvePool(
  base: MockTakerBase,
  amountOut: BigNumber
) {
  const curvePool = await new MockCurveSwapPool__factory(base.owner).deploy(
    base.collateralToken.address,
    amountOut
  );
  await curvePool.deployed();
  await curvePool.setTokenOut(base.quoteToken.address);
  if (amountOut.gt(0)) {
    await base.quoteToken.mint(curvePool.address, amountOut);
  }
  return curvePool;
}

export interface UniswapDetailsParams {
  routerAddress: string;
  targetToken: string;
  amountOutMinimum: BigNumber | number;
  feeTier?: number;
  deadline?: number;
}

function uniswapDetailsTuple(params: UniswapDetailsParams) {
  return [
    params.routerAddress,
    params.targetToken,
    params.feeTier ?? 500,
    params.amountOutMinimum,
    params.deadline ?? DEADLINE,
  ];
}

/** Keeper-facing UniswapV3SwapDetails encoding (takeWithAtomicSwap input). */
export function encodeUniswapDetails(params: UniswapDetailsParams) {
  return utils.defaultAbiCoder.encode(
    [UNISWAP_DETAILS_TYPE],
    [uniswapDetailsTuple(params)]
  );
}

/**
 * Callback payloads carry (details, plannedAmountIn); takeWithAtomicSwap
 * derives the planned amount on-chain, so only direct-callback tests encode
 * it explicitly.
 */
export function encodeTakerCallbackData(
  detailsType: string,
  detailsValue: unknown[],
  plannedAmountIn: BigNumber
) {
  return utils.defaultAbiCoder.encode(
    [detailsType, 'uint256'],
    [detailsValue, plannedAmountIn]
  );
}

export function encodeUniswapCallbackData(
  params: UniswapDetailsParams & { plannedAmountIn: BigNumber }
) {
  return encodeTakerCallbackData(
    UNISWAP_DETAILS_TYPE,
    uniswapDetailsTuple(params),
    params.plannedAmountIn
  );
}


/** Keeper-facing Curve details encoding (pool, poolType, indices, min, deadline). */
export function encodeCurveKeeperDetails(
  curvePoolAddress: string,
  amountOutMinimum: BigNumber,
  options: {
    poolType?: number;
    tokenInIndex?: number;
    tokenOutIndex?: number;
    deadline?: number;
  } = {}
) {
  return utils.defaultAbiCoder.encode(
    ['address', 'uint8', 'uint8', 'uint8', 'uint256', 'uint256'],
    [
      curvePoolAddress,
      options.poolType ?? 0,
      options.tokenInIndex ?? 0,
      options.tokenOutIndex ?? 1,
      amountOutMinimum,
      options.deadline ?? DEADLINE,
    ]
  );
}
