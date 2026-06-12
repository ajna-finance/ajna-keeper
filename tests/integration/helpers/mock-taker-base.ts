import { expect } from 'chai';
import { BigNumber, Wallet, constants, providers, utils } from 'ethers';
import { network } from 'hardhat';
import {
  CurveKeeperTaker__factory,
  SushiSwapKeeperTaker__factory,
  UniswapV3KeeperTaker__factory,
} from '../../../typechain-types/factories/contracts/takers';
import {
  MockAtomicSwapPool__factory,
  MockCurveSwapPool__factory,
  MockERC20__factory,
  MockMinOutBypassSwap__factory,
  MockPoolDeployer__factory,
  MockSushiSwapRouter__factory,
  MockSwapRouter02__factory,
} from '../../../typechain-types/factories/contracts/mocks';

export const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
export const DEADLINE = 4_102_444_800;
export const ZERO_FACTORY = constants.AddressZero;

// Keeper- and callback-payload detail shapes shared by the taker contracts.
export const UNISWAP_DETAILS_TYPE = '(address,address,uint24,uint256,uint256)';
export const SUSHI_DETAILS_TYPE = '(address,address,uint24,uint256,uint256)';
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

  const quoteToken = await new MockERC20__factory(owner).deploy(
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
  authorizedFactory: string = ZERO_FACTORY
) {
  const taker = await new UniswapV3KeeperTaker__factory(base.owner).deploy(
    base.poolDeployer.address,
    authorizedFactory
  );
  await taker.deployed();
  return taker;
}

export async function deploySushiTaker(
  base: MockTakerBase,
  authorizedFactory: string = ZERO_FACTORY
) {
  const taker = await new SushiSwapKeeperTaker__factory(base.owner).deploy(
    base.poolDeployer.address,
    authorizedFactory
  );
  await taker.deployed();
  return taker;
}

export async function deployCurveTaker(
  base: MockTakerBase,
  authorizedFactory: string = ZERO_FACTORY
) {
  const taker = await new CurveKeeperTaker__factory(base.owner).deploy(
    base.poolDeployer.address,
    authorizedFactory
  );
  await taker.deployed();
  return taker;
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

export async function deployFundedSushiRouter(
  base: MockTakerBase,
  amountOut: BigNumber
) {
  const router = await new MockSushiSwapRouter__factory(base.owner).deploy(
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

/** Keeper-facing SushiSwap details encoding (feeTier, amountOutMinimum, deadline). */
export function encodeSushiKeeperDetails(
  amountOutMinimum: BigNumber,
  options: { feeTier?: number; deadline?: number } = {}
) {
  return utils.defaultAbiCoder.encode(
    ['uint24', 'uint256', 'uint256'],
    [options.feeTier ?? 500, amountOutMinimum, options.deadline ?? DEADLINE]
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
