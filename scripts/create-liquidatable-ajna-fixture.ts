import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json';
import { ERC20Pool__factory, PoolInfoUtils__factory } from '@ajna-finance/sdk';
import { BigNumber, Contract, ContractFactory, Wallet, ethers } from 'ethers';
import { encodeSqrtRatioX96 } from '@uniswap/v3-sdk';
import ERC20_ABI from '../src/abis/erc20.abi.json';

type JsonObject = Record<string, unknown>;

type TokenDeployerManifest = {
  manifestPath: string;
  deployedAddress: string;
  name: string;
  symbol: string;
  chainId: number;
  chainName: string;
  status: string;
};

type SuccessEnvelope<T> = {
  ok: true;
  result: T;
};

type ErrorEnvelope = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

type AjnaEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

type PoolInspectionResult = {
  poolAddress: string;
  prices: {
    lup: string;
    lupIndex: number;
    hpb: string;
    hpbIndex: number;
    htp: string;
    htpIndex: number;
  };
};

type BorrowerInspectionResult = {
  owner: string;
  debt: string;
  collateral: string;
  thresholdPrice: string;
  neutralPrice: string;
  poolDebtInAuction: string;
};

type LenderInspectionResult = {
  owner: string;
  bucketIndex: number;
  lpBalance: string;
  depositTime: string;
  quoteRedeemable: string;
  collateralRedeemable: string;
};

type PreparedAction = {
  signatureStatus: 'signed' | 'unsigned';
};

type ExecutePreparedResult = {
  resolvedPoolAddress?: string;
  submitted: Array<{
    hash: string;
    status: number;
    gasUsed: string;
    label: string;
  }>;
};

type UniswapV3RouterConfig = {
  universalRouterAddress: string;
  permit2Address: string;
  poolFactoryAddress: string;
  quoterV2Address: string;
  wethAddress: string;
  positionManagerAddress: string;
  defaultFeeTier: number;
  defaultSlippage: number;
};

type UniswapV3LiquiditySummary = {
  provider: string;
  token0: string;
  token1: string;
  amount0Desired: string;
  amount1Desired: string;
  feeTier: number;
  poolAddress: string;
  positionManagerAddress: string;
};

type ExternalTakeDeploymentSummary = {
  owner: string;
  ajnaPoolFactory: string;
  keeperTakerFactory: string;
  uniswapV3Taker: string;
};

type ExternalTakeSnippetSummary = {
  path: string;
  content: string;
};

type AutoTuneSummary = {
  targetKickDelayDays: number;
  targetKickDelaySeconds: number;
  selectedBorrowAmountWad: string;
  lowerProbeBorrowAmountWad: string;
  upperProbeBorrowAmountWad: string;
  searchIterations: number;
};

type FixtureSummary = {
  network: 'base';
  rpcUrl: string;
  repos: {
    tokenDeployerRepo: string;
    ajnaSkillsRepo: string;
  };
  tempDir: string;
  outputPath: string;
  actors: {
    deployer: string;
    lender: string;
    borrower: string;
    keeper?: string;
  };
  tokenRequests: {
    quote: JsonObject;
    collateral: JsonObject;
  };
  quoteToken: TokenDeployerManifest;
  collateralToken: TokenDeployerManifest;
  pool: {
    address: string;
    interestRate: string;
    dominantBucketIndex: number;
    prices: PoolInspectionResult['prices'];
  };
  lender: LenderInspectionResult;
  borrower: BorrowerInspectionResult;
  liquidationCheck: {
    keeperKickEligibleByCurrentCode: boolean;
    strictlyAboveLup: boolean;
    keeperCondition: 'thresholdPrice >= lup';
    shapingTarget: 'thresholdPrice > lup';
  };
  borrowPlan: {
    lendAmountWad: string;
    borrowAmountWad: string;
    collateralAmountWad: string;
    limitIndex: number;
    requestedBorrowAmountWad?: string;
    targetKickDelayDays?: number;
  };
  autoTune?: AutoTuneSummary;
  removal: {
    attempts: number;
    removedAmountsWad: string[];
  };
  timeWarp: {
    count: number;
    secondsPerWarp: number;
  };
  uniswapV3ExternalTake?: {
    routerConfig: UniswapV3RouterConfig;
    liquidity: UniswapV3LiquiditySummary;
    deployment: ExternalTakeDeploymentSummary;
    keeperConfigSnippet: ExternalTakeSnippetSummary;
    note: 'Manual keeper take tests still need either a real subgraph/indexer or a repo-local subgraph override harness.';
  };
};

const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_NAME = 'base';
const BASE_AJNA_ERC20_POOL_FACTORY = '0x214f62B5836D83f3D6c4f71F174209097B1A779C';
const BASE_POOL_INFO_UTILS = '0x97fa9b0909C238D170C1ab3B5c728A3a45BBEcBa';
const BASE_UNISWAP_DEFAULTS: UniswapV3RouterConfig = {
  universalRouterAddress: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
  permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  poolFactoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  quoterV2Address: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  wethAddress: '0x4200000000000000000000000000000000000006',
  positionManagerAddress: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
  defaultFeeTier: 3000,
  defaultSlippage: 0.5,
};
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

type CliOptions = {
  withUniswapV3ExternalTake: boolean;
};

function parseOptions(argv: string[]): CliOptions {
  return {
    withUniswapV3ExternalTake:
      argv.includes('--with-uniswap-v3-external-take') ||
      process.env.AJNA_AGENT_ENABLE_UNISWAP_V3_EXTERNAL_TAKE === '1',
  };
}

function usage() {
  return `Usage: ts-node scripts/create-liquidatable-ajna-fixture.ts [--with-uniswap-v3-external-take]\n\nRequired env:\n- AJNA_AGENT_RPC_URL or AJNA_RPC_URL_BASE\n- AJNA_AGENT_DEPLOYER_KEY\n- AJNA_AGENT_LENDER_KEY\n- AJNA_AGENT_BORROWER_KEY\n\nOptional env:\n- AJNA_AGENT_KEEPER_KEY\n- AJNA_AGENT_TOKEN_DEPLOYER_REPO (default: ../token-deployer)\n- AJNA_AGENT_AJNA_SKILLS_REPO (default: ../ajna-skills)\n- AJNA_AGENT_OUTPUT_PATH (default: temp summary path)\n- AJNA_AGENT_BUCKET_INDEX (default: 4600)\n- AJNA_AGENT_LIMIT_INDEX (default: 5000)\n- AJNA_AGENT_INTEREST_RATE (default: 50000000000000000)\n- AJNA_AGENT_LEND_AMOUNT_WAD (default: 1000000000000000000000)\n- AJNA_AGENT_BORROW_AMOUNT_WAD (default: 10000000000000000000)\n- AJNA_AGENT_COLLATERAL_AMOUNT_WAD (default: 100000000000000000000)\n- AJNA_AGENT_TARGET_KICK_DELAY_DAYS (optional; auto-tunes borrow amount to reach kickability within this many fork days)\n- AJNA_AGENT_QUOTE_MINT_RAW (default: 100000000000000000000000)\n- AJNA_AGENT_COLLATERAL_MINT_RAW (default: 100000000000000000000000)\n- AJNA_AGENT_MAX_REMOVE_ATTEMPTS (default: 16)\n- AJNA_AGENT_TIME_WARP_SECONDS (default: 31536000)\n- AJNA_AGENT_MAX_TIME_WARPS (default: 5)\n\nOptional Uniswap V3 external-take setup (requires --with-uniswap-v3-external-take or AJNA_AGENT_ENABLE_UNISWAP_V3_EXTERNAL_TAKE=1):\n- AJNA_AGENT_KEEPER_KEY (required in external-take mode; the deployed factory/taker owner)\n- AJNA_AGENT_UNISWAP_QUOTE_LIQUIDITY_RAW (default: 10000000000000000000000)\n- AJNA_AGENT_UNISWAP_COLLATERAL_LIQUIDITY_RAW (default: 10000000000000000000000)\n- AJNA_AGENT_UNISWAP_FEE_TIER (default: 3000)\n- AJNA_AGENT_UNISWAP_UNIVERSAL_ROUTER_ADDRESS\n- AJNA_AGENT_UNISWAP_PERMIT2_ADDRESS\n- AJNA_AGENT_UNISWAP_POOL_FACTORY_ADDRESS\n- AJNA_AGENT_UNISWAP_QUOTER_V2_ADDRESS\n- AJNA_AGENT_UNISWAP_WETH_ADDRESS\n- AJNA_AGENT_UNISWAP_POSITION_MANAGER_ADDRESS\n- AJNA_AGENT_AJNA_ERC20_POOL_FACTORY (default: Base mainnet ERC20 pool factory)\n`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function resolveRepoPath(envName: string, defaultRelativePath: string): string {
  const configured = process.env[envName];
  const resolved = path.resolve(configured ?? path.join(process.cwd(), defaultRelativePath));
  if (!fs.existsSync(resolved)) {
    throw new Error(`Repo path does not exist for ${envName}: ${resolved}`);
  }
  return resolved;
}

function ensureFileExists(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function runJsonCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): unknown {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  });

  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';

  if (result.status !== 0) {
    const detail = stderr || stdout || `exit status ${result.status}`;
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${detail}`);
  }

  if (!stdout) {
    throw new Error(`Command returned no stdout: ${command} ${args.join(' ')}`);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse JSON from command: ${command} ${args.join(' ')}\n${stdout}`);
  }
}

function runTokenDeployer(tokenDeployerRepo: string, args: string[]): unknown {
  const scriptPath = path.join(tokenDeployerRepo, 'scripts', 'token-deployer.mjs');
  ensureFileExists(scriptPath, 'token-deployer CLI');
  return runJsonCommand(process.execPath, [scriptPath, ...args], {
    cwd: tokenDeployerRepo,
    env: process.env,
  });
}

function runAjnaSkills<T>(
  ajnaSkillsRepo: string,
  action: string,
  payload: JsonObject,
  extraEnv: Record<string, string | undefined>
): T {
  const cliPath = path.join(ajnaSkillsRepo, 'dist', 'cli.js');
  ensureFileExists(cliPath, 'ajna-skills dist/cli.js');
  const envelope = runJsonCommand(process.execPath, [cliPath, action, JSON.stringify(payload)], {
    cwd: ajnaSkillsRepo,
    env: {
      ...process.env,
      ...extraEnv,
    },
  }) as AjnaEnvelope<T>;

  if (!('ok' in envelope)) {
    throw new Error(`Unexpected ajna-skills envelope for ${action}`);
  }
  if (!envelope.ok) {
    throw new Error(`ajna-skills ${action} failed: ${envelope.error.message}`);
  }
  return envelope.result;
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function big(value: string): BigNumber {
  return BigNumber.from(value);
}

function actorAddress(privateKey: string): string {
  return new Wallet(privateKey).address;
}

function normalizeAddress(address: string): string {
  return ethers.utils.getAddress(address);
}

function sortTokenPair<T>(tokenA: string, tokenB: string, aValue: T, bValue: T) {
  const normalizedA = normalizeAddress(tokenA);
  const normalizedB = normalizeAddress(tokenB);
  if (normalizedA.toLowerCase() < normalizedB.toLowerCase()) {
    return {
      token0: normalizedA,
      token1: normalizedB,
      value0: aValue,
      value1: bValue,
    };
  }
  return {
    token0: normalizedB,
    token1: normalizedA,
    value0: bValue,
    value1: aValue,
  };
}

function deployMintableErc20(params: {
  tokenDeployerRepo: string;
  tempDir: string;
  name: string;
  symbol: string;
  owner: string;
  initialSupply: string;
  rpcUrl: string;
  privateKey: string;
  targetDir: string;
}): TokenDeployerManifest {
  const requestPath = path.join(params.tempDir, `${params.symbol.toLowerCase()}-request.json`);
  const request = {
    standard: 'erc20',
    name: params.name,
    symbol: params.symbol,
    chainId: BASE_CHAIN_ID,
    chainName: BASE_CHAIN_NAME,
    owner: params.owner,
    initialRecipient: params.owner,
    initialSupply: params.initialSupply,
    decimals: 18,
    mintable: true,
  };
  writeJson(requestPath, request);

  return runTokenDeployer(params.tokenDeployerRepo, [
    'deploy',
    requestPath,
    '--target-dir',
    params.targetDir,
    '--broadcast',
    '--rpc-url',
    params.rpcUrl,
    '--private-key',
    params.privateKey,
  ]) as TokenDeployerManifest;
}

async function transferErc20(params: {
  signer: Wallet;
  tokenAddress: string;
  to: string;
  amount: string;
}) {
  const token = new Contract(params.tokenAddress, ERC20_ABI, params.signer);
  const tx = await token.transfer(params.to, params.amount, {
    gasLimit: 500_000,
  });
  await tx.wait();
}

function prepareAndExecute(
  ajnaSkillsRepo: string,
  action: string,
  payload: JsonObject,
  signerPrivateKey: string,
  baseRpcUrl: string,
  extraEnv: Record<string, string | undefined> = {}
): ExecutePreparedResult {
  const baseEnv = {
    AJNA_RPC_URL_BASE: baseRpcUrl,
    AJNA_SKILLS_MODE: 'execute',
    AJNA_SIGNER_PRIVATE_KEY: signerPrivateKey,
    ...extraEnv,
  };
  const prepared = runAjnaSkills<PreparedAction>(ajnaSkillsRepo, action, payload, baseEnv);
  if (prepared.signatureStatus !== 'signed') {
    throw new Error(`${action} produced an unsigned prepared action`);
  }
  return runAjnaSkills<ExecutePreparedResult>(
    ajnaSkillsRepo,
    'execute-prepared',
    { preparedAction: prepared },
    baseEnv
  );
}

function inspectPool(ajnaSkillsRepo: string, baseRpcUrl: string, poolAddress: string): PoolInspectionResult {
  return runAjnaSkills<PoolInspectionResult>(
    ajnaSkillsRepo,
    'inspect-pool',
    { network: 'base', poolAddress, detailLevel: 'full' },
    { AJNA_RPC_URL_BASE: baseRpcUrl }
  );
}

function inspectBorrower(
  ajnaSkillsRepo: string,
  baseRpcUrl: string,
  poolAddress: string,
  owner: string
): BorrowerInspectionResult {
  return runAjnaSkills<BorrowerInspectionResult>(
    ajnaSkillsRepo,
    'inspect-position',
    { network: 'base', poolAddress, owner, positionType: 'borrower' },
    { AJNA_RPC_URL_BASE: baseRpcUrl }
  );
}

function inspectLender(
  ajnaSkillsRepo: string,
  baseRpcUrl: string,
  poolAddress: string,
  owner: string,
  bucketIndex: number
): LenderInspectionResult {
  return runAjnaSkills<LenderInspectionResult>(
    ajnaSkillsRepo,
    'inspect-position',
    { network: 'base', poolAddress, owner, positionType: 'lender', bucketIndex },
    { AJNA_RPC_URL_BASE: baseRpcUrl }
  );
}

async function inspectPoolDirect(
  provider: ethers.providers.JsonRpcProvider,
  poolAddress: string
): Promise<PoolInspectionResult> {
  const poolInfoUtils = PoolInfoUtils__factory.connect(BASE_POOL_INFO_UTILS, provider);
  const prices = await poolInfoUtils.poolPricesInfo(poolAddress);
  return {
    poolAddress,
    prices: {
      lup: prices.lup_.toString(),
      lupIndex: prices.lupIndex_.toNumber(),
      hpb: prices.hpb_.toString(),
      hpbIndex: prices.hpbIndex_.toNumber(),
      htp: prices.htp_.toString(),
      htpIndex: prices.htpIndex_.toNumber(),
    },
  };
}

async function inspectBorrowerDirect(
  provider: ethers.providers.JsonRpcProvider,
  poolAddress: string,
  owner: string
): Promise<BorrowerInspectionResult> {
  const poolInfoUtils = PoolInfoUtils__factory.connect(BASE_POOL_INFO_UTILS, provider);
  const pool = ERC20Pool__factory.connect(poolAddress, provider);
  const [borrowerInfo, debtInfo] = await Promise.all([
    poolInfoUtils.borrowerInfo(poolAddress, owner),
    pool.debtInfo(),
  ]);
  return {
    owner,
    debt: borrowerInfo.debt_.toString(),
    collateral: borrowerInfo.collateral_.toString(),
    thresholdPrice: borrowerInfo.thresholdPrice_.toString(),
    neutralPrice: borrowerInfo.t0Np_.toString(),
    poolDebtInAuction: debtInfo[2].toString(),
  };
}

async function inspectLenderDirect(
  provider: ethers.providers.JsonRpcProvider,
  poolAddress: string,
  owner: string,
  bucketIndex: number
): Promise<LenderInspectionResult> {
  const poolInfoUtils = PoolInfoUtils__factory.connect(BASE_POOL_INFO_UTILS, provider);
  const pool = ERC20Pool__factory.connect(poolAddress, provider);
  const lenderInfo = await pool.lenderInfo(bucketIndex, owner);
  const lpBalance = lenderInfo[0];
  const depositTime = lenderInfo[1];
  const [quoteRedeemable, collateralRedeemable] = await Promise.all([
    poolInfoUtils.lpToQuoteTokens(poolAddress, lpBalance, bucketIndex),
    poolInfoUtils.lpToCollateral(poolAddress, lpBalance, bucketIndex),
  ]);
  return {
    owner,
    bucketIndex,
    lpBalance: lpBalance.toString(),
    depositTime: depositTime.toString(),
    quoteRedeemable: quoteRedeemable.toString(),
    collateralRedeemable: collateralRedeemable.toString(),
  };
}

function readArtifact(relativePath: string): { abi: any; bytecode: string } {
  const artifactPath = path.join(process.cwd(), relativePath);
  ensureFileExists(artifactPath, `artifact ${relativePath}`);
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as { abi: any; bytecode: string };
}

async function approveErc20Exact(
  signer: Wallet,
  tokenAddress: string,
  spender: string,
  amount: BigNumber
) {
  const token = new Contract(tokenAddress, ERC20_ABI, signer);
  const allowance = await token.allowance(await signer.getAddress(), spender);
  if (allowance.gte(amount)) {
    return;
  }
  if (!allowance.isZero()) {
    const resetTx = await token.approve(spender, 0);
    await resetTx.wait();
  }
  const approveTx = await token.approve(spender, amount);
  await approveTx.wait();
}

async function resolveSafeQuoteRemovalAmount(params: {
  lenderSigner: Wallet;
  poolAddress: string;
  bucketIndex: number;
  maxAmount: BigNumber;
}): Promise<BigNumber> {
  const pool = ERC20Pool__factory.connect(params.poolAddress, params.lenderSigner);
  let candidate = params.maxAmount;

  while (candidate.gt(0)) {
    try {
      await pool.estimateGas.removeQuoteToken(candidate, params.bucketIndex);
      return candidate;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('LUPBelowHTP()') && !message.includes('0x444507e1')) {
        throw error;
      }
      candidate = candidate.div(2);
    }
  }

  throw new Error('Unable to find a removable quote amount that preserves LUP >= HTP');
}

async function createSnapshot(provider: ethers.providers.JsonRpcProvider): Promise<string> {
  return String(await provider.send('evm_snapshot', []));
}

async function revertSnapshot(
  provider: ethers.providers.JsonRpcProvider,
  snapshotId: string
) {
  const reverted = await provider.send('evm_revert', [snapshotId]);
  if (!reverted) {
    throw new Error(`Failed to revert snapshot ${snapshotId}`);
  }
}

type BorrowKickSimulationResult = {
  keeperKickEligibleAfterDelay: boolean;
  borrowerPosition: BorrowerInspectionResult;
  poolInspection: PoolInspectionResult;
  attempts: number;
  removedAmountsWad: string[];
};

async function simulateBorrowToKickability(params: {
  provider: ethers.providers.JsonRpcProvider;
  poolAddress: string;
  borrowerAddress: string;
  borrowerSigner: Wallet;
  lenderAddress: string;
  lenderSigner: Wallet;
  bucketIndex: number;
  limitIndex: number;
  collateralAmountWad: string;
  borrowAmountWad: string;
  maxRemoveAttempts: number;
  targetKickDelaySeconds: number;
}): Promise<BorrowKickSimulationResult> {
  const snapshotId = await createSnapshot(params.provider);

  try {
    const borrowerPool = ERC20Pool__factory.connect(
      params.poolAddress,
      params.borrowerSigner
    );
    const borrowTx = await borrowerPool.drawDebt(
      params.borrowerAddress,
      params.borrowAmountWad,
      params.limitIndex,
      params.collateralAmountWad,
      { gasLimit: 2_000_000 }
    );
    await borrowTx.wait();

    let borrowerPosition = await inspectBorrowerDirect(
      params.provider,
      params.poolAddress,
      params.borrowerAddress
    );
    let poolInspection = await inspectPoolDirect(params.provider, params.poolAddress);
    let lenderPosition = await inspectLenderDirect(
      params.provider,
      params.poolAddress,
      params.lenderAddress,
      params.bucketIndex
    );
    const removedAmountsWad: string[] = [];
    let attempts = 0;
    const lenderPool = ERC20Pool__factory.connect(params.poolAddress, params.lenderSigner);

    while (
      big(borrowerPosition.thresholdPrice).lt(big(poolInspection.prices.lup)) &&
      attempts < params.maxRemoveAttempts
    ) {
      const redeemable = big(lenderPosition.quoteRedeemable);
      if (redeemable.isZero()) {
        break;
      }

      const removeAmount = await resolveSafeQuoteRemovalAmount({
        lenderSigner: params.lenderSigner,
        poolAddress: params.poolAddress,
        bucketIndex: params.bucketIndex,
        maxAmount: redeemable,
      });

      const removeTx = await lenderPool.removeQuoteToken(removeAmount, params.bucketIndex, {
        gasLimit: 2_000_000,
      });
      await removeTx.wait();

      removedAmountsWad.push(removeAmount.toString());
      attempts += 1;
      lenderPosition = await inspectLenderDirect(
        params.provider,
        params.poolAddress,
        params.lenderAddress,
        params.bucketIndex
      );
      borrowerPosition = await inspectBorrowerDirect(
        params.provider,
        params.poolAddress,
        params.borrowerAddress
      );
      poolInspection = await inspectPoolDirect(params.provider, params.poolAddress);
    }

    let keeperKickEligibleAfterDelay = big(borrowerPosition.thresholdPrice).gte(
      big(poolInspection.prices.lup)
    );

    if (!keeperKickEligibleAfterDelay && params.targetKickDelaySeconds > 0) {
      await params.provider.send('evm_increaseTime', [params.targetKickDelaySeconds]);
      await params.provider.send('evm_mine', []);
      borrowerPosition = await inspectBorrowerDirect(
        params.provider,
        params.poolAddress,
        params.borrowerAddress
      );
      poolInspection = await inspectPoolDirect(params.provider, params.poolAddress);
      keeperKickEligibleAfterDelay = big(borrowerPosition.thresholdPrice).gte(
        big(poolInspection.prices.lup)
      );
    }

    return {
      keeperKickEligibleAfterDelay,
      borrowerPosition,
      poolInspection,
      attempts,
      removedAmountsWad,
    };
  } finally {
    await revertSnapshot(params.provider, snapshotId);
  }
}

async function autoTuneBorrowAmountWad(params: {
  provider: ethers.providers.JsonRpcProvider;
  poolAddress: string;
  borrowerAddress: string;
  borrowerSigner: Wallet;
  lenderAddress: string;
  lenderSigner: Wallet;
  bucketIndex: number;
  limitIndex: number;
  lendAmountWad: string;
  collateralAmountWad: string;
  borrowAmountWad: string;
  maxRemoveAttempts: number;
  targetKickDelayDays: number;
}): Promise<AutoTuneSummary> {
  const targetKickDelaySeconds = Math.max(
    1,
    Math.round(params.targetKickDelayDays * 24 * 60 * 60)
  );
  const maxBorrowAmount = big(params.lendAmountWad).sub(1);
  let lower = big(params.borrowAmountWad);
  let upper = lower;
  let searchIterations = 0;

  const evaluate = async (candidate: BigNumber) => {
    searchIterations += 1;
    return simulateBorrowToKickability({
      provider: params.provider,
      poolAddress: params.poolAddress,
      borrowerAddress: params.borrowerAddress,
      borrowerSigner: params.borrowerSigner,
      lenderAddress: params.lenderAddress,
      lenderSigner: params.lenderSigner,
      bucketIndex: params.bucketIndex,
      limitIndex: params.limitIndex,
      collateralAmountWad: params.collateralAmountWad,
      borrowAmountWad: candidate.toString(),
      maxRemoveAttempts: params.maxRemoveAttempts,
      targetKickDelaySeconds,
    });
  };

  let lowerResult = await evaluate(lower);
  if (lowerResult.keeperKickEligibleAfterDelay) {
    return {
      targetKickDelayDays: params.targetKickDelayDays,
      targetKickDelaySeconds,
      selectedBorrowAmountWad: lower.toString(),
      lowerProbeBorrowAmountWad: lower.toString(),
      upperProbeBorrowAmountWad: lower.toString(),
      searchIterations,
    };
  }

  while (upper.lt(maxBorrowAmount)) {
    const nextUpper = upper.mul(105).div(100);
    upper = nextUpper.gt(upper) ? nextUpper : upper.add(1);
    if (upper.gt(maxBorrowAmount)) {
      upper = maxBorrowAmount;
    }
    const upperResult = await evaluate(upper);
    if (upperResult.keeperKickEligibleAfterDelay) {
      break;
    }
    lower = upper;
    lowerResult = upperResult;
    if (upper.eq(maxBorrowAmount)) {
      throw new Error(
        `Auto-tune could not find a borrow amount that becomes kickable within ${params.targetKickDelayDays} days before hitting the lend amount cap`
      );
    }
  }

  for (let i = 0; i < 18; i += 1) {
    const mid = lower.add(upper).div(2);
    if (mid.lte(lower) || mid.gte(upper)) {
      break;
    }
    const midResult = await evaluate(mid);
    if (midResult.keeperKickEligibleAfterDelay) {
      upper = mid;
    } else {
      lower = mid;
      lowerResult = midResult;
    }
  }

  return {
    targetKickDelayDays: params.targetKickDelayDays,
    targetKickDelaySeconds,
    selectedBorrowAmountWad: upper.toString(),
    lowerProbeBorrowAmountWad: lower.toString(),
    upperProbeBorrowAmountWad: upper.toString(),
    searchIterations,
  };
}

function resolveUniswapV3RouterConfig(): UniswapV3RouterConfig {
  return {
    universalRouterAddress: optionalEnv(
      'AJNA_AGENT_UNISWAP_UNIVERSAL_ROUTER_ADDRESS',
      BASE_UNISWAP_DEFAULTS.universalRouterAddress
    ),
    permit2Address: optionalEnv(
      'AJNA_AGENT_UNISWAP_PERMIT2_ADDRESS',
      BASE_UNISWAP_DEFAULTS.permit2Address
    ),
    poolFactoryAddress: optionalEnv(
      'AJNA_AGENT_UNISWAP_POOL_FACTORY_ADDRESS',
      BASE_UNISWAP_DEFAULTS.poolFactoryAddress
    ),
    quoterV2Address: optionalEnv(
      'AJNA_AGENT_UNISWAP_QUOTER_V2_ADDRESS',
      BASE_UNISWAP_DEFAULTS.quoterV2Address
    ),
    wethAddress: optionalEnv(
      'AJNA_AGENT_UNISWAP_WETH_ADDRESS',
      BASE_UNISWAP_DEFAULTS.wethAddress
    ),
    positionManagerAddress: optionalEnv(
      'AJNA_AGENT_UNISWAP_POSITION_MANAGER_ADDRESS',
      BASE_UNISWAP_DEFAULTS.positionManagerAddress
    ),
    defaultFeeTier: Number(
      optionalEnv(
        'AJNA_AGENT_UNISWAP_FEE_TIER',
        String(BASE_UNISWAP_DEFAULTS.defaultFeeTier)
      )
    ),
    defaultSlippage: Number(
      optionalEnv(
        'AJNA_AGENT_UNISWAP_DEFAULT_SLIPPAGE',
        String(BASE_UNISWAP_DEFAULTS.defaultSlippage)
      )
    ),
  };
}

async function createAndSeedUniswapV3Pool(params: {
  signer: Wallet;
  quoteTokenAddress: string;
  collateralTokenAddress: string;
  quoteLiquidityRaw: string;
  collateralLiquidityRaw: string;
  routerConfig: UniswapV3RouterConfig;
}): Promise<UniswapV3LiquiditySummary> {
  const { signer, quoteTokenAddress, collateralTokenAddress, routerConfig } = params;
  const positionManager = new Contract(
    routerConfig.positionManagerAddress,
    NonfungiblePositionManagerABI,
    signer
  );
  const quoteLiquidity = BigNumber.from(params.quoteLiquidityRaw);
  const collateralLiquidity = BigNumber.from(params.collateralLiquidityRaw);
  const ordered = sortTokenPair(
    collateralTokenAddress,
    quoteTokenAddress,
    collateralLiquidity,
    quoteLiquidity
  );

  await approveErc20Exact(signer, ordered.token0, routerConfig.positionManagerAddress, ordered.value0);
  await approveErc20Exact(signer, ordered.token1, routerConfig.positionManagerAddress, ordered.value1);

  const sqrtPriceX96 = encodeSqrtRatioX96(
    ordered.value1.toString(),
    ordered.value0.toString()
  ).toString();

  const createTx = await positionManager.createAndInitializePoolIfNecessary(
    ordered.token0,
    ordered.token1,
    routerConfig.defaultFeeTier,
    sqrtPriceX96,
    { gasLimit: 5_000_000 }
  );
  await createTx.wait();

  const provider = signer.provider;
  if (!provider) {
    throw new Error('Signer provider missing while creating Uniswap V3 pool');
  }
  const latestBlock = await provider.getBlock('latest');
  const recipient = await signer.getAddress();
  const mintTx = await positionManager.mint(
    {
      token0: ordered.token0,
      token1: ordered.token1,
      fee: routerConfig.defaultFeeTier,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: ordered.value0,
      amount1Desired: ordered.value1,
      amount0Min: 0,
      amount1Min: 0,
      recipient,
      deadline: latestBlock.timestamp + 3600,
    },
    { gasLimit: 10_000_000 }
  );
  await mintTx.wait();

  const factory = new Contract(routerConfig.poolFactoryAddress, FACTORY_ABI, signer);
  const poolAddress = await factory.getPool(
    ordered.token0,
    ordered.token1,
    routerConfig.defaultFeeTier
  );
  if (!poolAddress || poolAddress === ethers.constants.AddressZero) {
    throw new Error('Uniswap V3 pool creation completed but factory returned zero address');
  }

  return {
    provider: recipient,
    token0: ordered.token0,
    token1: ordered.token1,
    amount0Desired: ordered.value0.toString(),
    amount1Desired: ordered.value1.toString(),
    feeTier: routerConfig.defaultFeeTier,
    poolAddress,
    positionManagerAddress: routerConfig.positionManagerAddress,
  };
}

async function deployUniswapV3ExternalTakeContracts(params: {
  ownerSigner: Wallet;
  ajnaPoolFactoryAddress: string;
}): Promise<ExternalTakeDeploymentSummary> {
  const factoryArtifact = readArtifact(
    path.join(
      'artifacts',
      'contracts',
      'factories',
      'AjnaKeeperTakerFactory.sol',
      'AjnaKeeperTakerFactory.json'
    )
  );
  const takerArtifact = readArtifact(
    path.join(
      'artifacts',
      'contracts',
      'takers',
      'UniswapV3KeeperTaker.sol',
      'UniswapV3KeeperTaker.json'
    )
  );

  const factoryFactory = new ContractFactory(
    factoryArtifact.abi,
    factoryArtifact.bytecode,
    params.ownerSigner
  );
  const keeperTakerFactory = await factoryFactory.deploy(params.ajnaPoolFactoryAddress, {
    gasLimit: 6_000_000,
  });
  await keeperTakerFactory.deployed();

  const uniswapTakerFactory = new ContractFactory(
    takerArtifact.abi,
    takerArtifact.bytecode,
    params.ownerSigner
  );
  const uniswapV3Taker = await uniswapTakerFactory.deploy(
    params.ajnaPoolFactoryAddress,
    keeperTakerFactory.address,
    { gasLimit: 6_000_000 }
  );
  await uniswapV3Taker.deployed();

  const setTakerTx = await keeperTakerFactory.setTaker(2, uniswapV3Taker.address, {
    gasLimit: 500_000,
  });
  await setTakerTx.wait();

  return {
    owner: await params.ownerSigner.getAddress(),
    ajnaPoolFactory: params.ajnaPoolFactoryAddress,
    keeperTakerFactory: keeperTakerFactory.address,
    uniswapV3Taker: uniswapV3Taker.address,
  };
}

function buildKeeperExternalTakeSnippet(params: {
  poolAddress: string;
  quoteToken: TokenDeployerManifest;
  collateralToken: TokenDeployerManifest;
  routerConfig: UniswapV3RouterConfig;
  deployment: ExternalTakeDeploymentSummary;
}): string {
  return `// Merge this into an existing Base keeper config.\n// Note: manual kick/take tests against this fresh local pool still need either a\n// local subgraph/indexer or a repo-local subgraph override harness.\n{\n  keeperTakerFactory: '${params.deployment.keeperTakerFactory}',\n  takerContracts: {\n    UniswapV3: '${params.deployment.uniswapV3Taker}',\n  },\n  universalRouterOverrides: {\n    universalRouterAddress: '${params.routerConfig.universalRouterAddress}',\n    permit2Address: '${params.routerConfig.permit2Address}',\n    poolFactoryAddress: '${params.routerConfig.poolFactoryAddress}',\n    quoterV2Address: '${params.routerConfig.quoterV2Address}',\n    wethAddress: '${params.routerConfig.wethAddress}',\n    defaultFeeTier: ${params.routerConfig.defaultFeeTier},\n    defaultSlippage: ${params.routerConfig.defaultSlippage},\n  },\n  pools: [\n    {\n      name: '${params.collateralToken.symbol} / ${params.quoteToken.symbol} Local Fixture',\n      address: '${params.poolAddress}',\n      price: { source: PriceOriginSource.FIXED, value: 1 },\n      kick: {\n        minDebt: 0.001,\n        priceFactor: 0.99,\n      },\n      take: {\n        minCollateral: 0.01,\n        liquiditySource: LiquiditySource.UNISWAPV3,\n        marketPriceFactor: 0.98,\n      },\n    },\n  ],\n}`;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (process.argv.includes('--help')) {
    process.stdout.write(usage());
    return;
  }

  const rpcUrl = process.env.AJNA_AGENT_RPC_URL ?? process.env.AJNA_RPC_URL_BASE;
  if (!rpcUrl) {
    throw new Error('Missing AJNA_AGENT_RPC_URL or AJNA_RPC_URL_BASE');
  }

  const deployerKey = requiredEnv('AJNA_AGENT_DEPLOYER_KEY');
  const lenderKey = requiredEnv('AJNA_AGENT_LENDER_KEY');
  const borrowerKey = requiredEnv('AJNA_AGENT_BORROWER_KEY');
  const keeperKey = process.env.AJNA_AGENT_KEEPER_KEY;

  if (options.withUniswapV3ExternalTake && !keeperKey) {
    throw new Error(
      'AJNA_AGENT_KEEPER_KEY is required when --with-uniswap-v3-external-take is enabled because the keeper must own the deployed factory/taker contracts'
    );
  }

  const tokenDeployerRepo = resolveRepoPath('AJNA_AGENT_TOKEN_DEPLOYER_REPO', '../token-deployer');
  const ajnaSkillsRepo = resolveRepoPath('AJNA_AGENT_AJNA_SKILLS_REPO', '../ajna-skills');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajna-liquidation-fixture-'));
  const outputPath = path.resolve(
    process.env.AJNA_AGENT_OUTPUT_PATH ?? path.join(tempDir, 'fixture-summary.json')
  );

  const interestRate = optionalEnv('AJNA_AGENT_INTEREST_RATE', '50000000000000000');
  const bucketIndex = Number(optionalEnv('AJNA_AGENT_BUCKET_INDEX', '4600'));
  const limitIndex = Number(optionalEnv('AJNA_AGENT_LIMIT_INDEX', '5000'));
  const lendAmountWad = optionalEnv('AJNA_AGENT_LEND_AMOUNT_WAD', '1000000000000000000000');
  const borrowAmountWad = optionalEnv('AJNA_AGENT_BORROW_AMOUNT_WAD', '10000000000000000000');
  const collateralAmountWad = optionalEnv('AJNA_AGENT_COLLATERAL_AMOUNT_WAD', '100000000000000000000');
  const targetKickDelayDays = process.env.AJNA_AGENT_TARGET_KICK_DELAY_DAYS
    ? Number(process.env.AJNA_AGENT_TARGET_KICK_DELAY_DAYS)
    : undefined;
  if (
    process.env.AJNA_AGENT_TARGET_KICK_DELAY_DAYS !== undefined &&
    (!Number.isFinite(targetKickDelayDays) || (targetKickDelayDays ?? 0) <= 0)
  ) {
    throw new Error('AJNA_AGENT_TARGET_KICK_DELAY_DAYS must be a positive number');
  }
  const quoteMintRaw = optionalEnv('AJNA_AGENT_QUOTE_MINT_RAW', '100000000000000000000000');
  const collateralMintRaw = optionalEnv('AJNA_AGENT_COLLATERAL_MINT_RAW', '100000000000000000000000');
  const quoteKeeperBufferRaw = optionalEnv(
    'AJNA_AGENT_KEEPER_QUOTE_BUFFER_RAW',
    '1000000000000000000000'
  );
  const defaultTimeWarpSeconds =
    targetKickDelayDays !== undefined
      ? String(Math.max(1, Math.round(targetKickDelayDays * 24 * 60 * 60)))
      : '31536000';
  const timeWarpSeconds = Number(
    optionalEnv('AJNA_AGENT_TIME_WARP_SECONDS', defaultTimeWarpSeconds)
  );
  const maxTimeWarps = Number(
    optionalEnv('AJNA_AGENT_MAX_TIME_WARPS', targetKickDelayDays !== undefined ? '1' : '5')
  );
  const quoteLiquidityRaw = options.withUniswapV3ExternalTake
    ? optionalEnv(
        'AJNA_AGENT_UNISWAP_QUOTE_LIQUIDITY_RAW',
        '10000000000000000000000'
      )
    : '0';
  const collateralLiquidityRaw = options.withUniswapV3ExternalTake
    ? optionalEnv(
        'AJNA_AGENT_UNISWAP_COLLATERAL_LIQUIDITY_RAW',
        '10000000000000000000000'
      )
    : '0';
  const quoteInitialSupplyRaw = big(quoteMintRaw)
    .add(big(quoteLiquidityRaw))
    .add(keeperKey ? big(quoteKeeperBufferRaw) : BigNumber.from(0))
    .toString();
  const collateralInitialSupplyRaw = big(collateralMintRaw)
    .add(big(collateralLiquidityRaw))
    .toString();
  const maxRemoveAttempts = Number(optionalEnv('AJNA_AGENT_MAX_REMOVE_ATTEMPTS', '16'));

  const deployerAddress = actorAddress(deployerKey);
  const lenderAddress = actorAddress(lenderKey);
  const borrowerAddress = actorAddress(borrowerKey);
  const keeperAddress = keeperKey ? actorAddress(keeperKey) : undefined;

  const quoteRequest = {
    standard: 'erc20',
    name: optionalEnv('AJNA_AGENT_QUOTE_TOKEN_NAME', 'Quote Test Token'),
    symbol: optionalEnv('AJNA_AGENT_QUOTE_TOKEN_SYMBOL', 'QTEST'),
    chainId: BASE_CHAIN_ID,
    chainName: BASE_CHAIN_NAME,
    owner: deployerAddress,
    initialRecipient: deployerAddress,
    initialSupply: quoteInitialSupplyRaw,
    decimals: 18,
    mintable: true,
  };
  const collateralRequest = {
    standard: 'erc20',
    name: optionalEnv('AJNA_AGENT_COLLATERAL_TOKEN_NAME', 'Collateral Test Token'),
    symbol: optionalEnv('AJNA_AGENT_COLLATERAL_TOKEN_SYMBOL', 'CTEST'),
    chainId: BASE_CHAIN_ID,
    chainName: BASE_CHAIN_NAME,
    owner: deployerAddress,
    initialRecipient: deployerAddress,
    initialSupply: collateralInitialSupplyRaw,
    decimals: 18,
    mintable: true,
  };

  const quoteManifest = deployMintableErc20({
    tokenDeployerRepo,
    tempDir,
    name: quoteRequest.name,
    symbol: quoteRequest.symbol,
    owner: deployerAddress,
    initialSupply: quoteRequest.initialSupply,
    rpcUrl,
    privateKey: deployerKey,
    targetDir: path.join(tempDir, 'quote-token-workspace'),
  });
  const collateralManifest = deployMintableErc20({
    tokenDeployerRepo,
    tempDir,
    name: collateralRequest.name,
    symbol: collateralRequest.symbol,
    owner: deployerAddress,
    initialSupply: collateralRequest.initialSupply,
    rpcUrl,
    privateKey: deployerKey,
    targetDir: path.join(tempDir, 'collateral-token-workspace'),
  });

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const deployerSigner = new Wallet(deployerKey, provider);
  const lenderSigner = new Wallet(lenderKey, provider);
  const borrowerSigner = new Wallet(borrowerKey, provider);

  await transferErc20({
    signer: deployerSigner,
    tokenAddress: quoteManifest.deployedAddress,
    to: lenderAddress,
    amount: quoteMintRaw,
  });
  await transferErc20({
    signer: deployerSigner,
    tokenAddress: collateralManifest.deployedAddress,
    to: borrowerAddress,
    amount: collateralMintRaw,
  });
  if (keeperAddress && keeperAddress.toLowerCase() !== deployerAddress.toLowerCase()) {
    await transferErc20({
      signer: deployerSigner,
      tokenAddress: quoteManifest.deployedAddress,
      to: keeperAddress,
      amount: quoteKeeperBufferRaw,
    });
  }

  let uniswapSummary: FixtureSummary['uniswapV3ExternalTake'];
  let uniswapBootstrap:
    | {
        routerConfig: UniswapV3RouterConfig;
        liquidity: UniswapV3LiquiditySummary;
        deployment: ExternalTakeDeploymentSummary;
      }
    | undefined;
  if (options.withUniswapV3ExternalTake) {
    const keeperSigner = new Wallet(keeperKey!, provider);
    const routerConfig = resolveUniswapV3RouterConfig();
    const liquidity = await createAndSeedUniswapV3Pool({
      signer: deployerSigner,
      quoteTokenAddress: quoteManifest.deployedAddress,
      collateralTokenAddress: collateralManifest.deployedAddress,
      quoteLiquidityRaw,
      collateralLiquidityRaw,
      routerConfig,
    });
    const deployment = await deployUniswapV3ExternalTakeContracts({
      ownerSigner: keeperSigner,
      ajnaPoolFactoryAddress: optionalEnv(
        'AJNA_AGENT_AJNA_ERC20_POOL_FACTORY',
        BASE_AJNA_ERC20_POOL_FACTORY
      ),
    });

    uniswapBootstrap = {
      routerConfig,
      liquidity,
      deployment,
    };
  }

  const createPoolResult = prepareAndExecute(
    ajnaSkillsRepo,
    'prepare-create-erc20-pool',
    {
      network: 'base',
      actorAddress: deployerAddress,
      collateralAddress: collateralManifest.deployedAddress,
      quoteAddress: quoteManifest.deployedAddress,
      interestRate,
      maxAgeSeconds: 600,
    },
    deployerKey,
    rpcUrl
  );

  const poolAddress = createPoolResult.resolvedPoolAddress;
  if (!poolAddress) {
    throw new Error('Pool creation did not return resolvedPoolAddress');
  }

  if (uniswapBootstrap) {
    const snippetContent = buildKeeperExternalTakeSnippet({
      poolAddress,
      quoteToken: quoteManifest,
      collateralToken: collateralManifest,
      routerConfig: uniswapBootstrap.routerConfig,
      deployment: uniswapBootstrap.deployment,
    });
    const snippetPath = path.join(tempDir, 'keeper-uniswap-v3-config-snippet.ts');
    fs.writeFileSync(snippetPath, `${snippetContent}\n`);

    uniswapSummary = {
      routerConfig: uniswapBootstrap.routerConfig,
      liquidity: uniswapBootstrap.liquidity,
      deployment: uniswapBootstrap.deployment,
      keeperConfigSnippet: {
        path: snippetPath,
        content: snippetContent,
      },
      note: 'Manual keeper take tests still need either a real subgraph/indexer or a repo-local subgraph override harness.',
    };
  }

  prepareAndExecute(
    ajnaSkillsRepo,
    'prepare-approve-erc20',
    {
      network: 'base',
      actorAddress: lenderAddress,
      tokenAddress: quoteManifest.deployedAddress,
      poolAddress,
      amount: lendAmountWad,
      approvalMode: 'exact',
      maxAgeSeconds: 600,
    },
    lenderKey,
    rpcUrl
  );

  prepareAndExecute(
    ajnaSkillsRepo,
    'prepare-lend',
    {
      network: 'base',
      poolAddress,
      actorAddress: lenderAddress,
      amount: lendAmountWad,
      bucketIndex,
      ttlSeconds: 600,
      approvalMode: 'exact',
    },
    lenderKey,
    rpcUrl
  );

  let lenderPosition = inspectLender(ajnaSkillsRepo, rpcUrl, poolAddress, lenderAddress, bucketIndex);

  prepareAndExecute(
    ajnaSkillsRepo,
    'prepare-approve-erc20',
    {
      network: 'base',
      actorAddress: borrowerAddress,
      tokenAddress: collateralManifest.deployedAddress,
      poolAddress,
      amount: collateralAmountWad,
      approvalMode: 'exact',
      maxAgeSeconds: 600,
    },
    borrowerKey,
    rpcUrl
  );

  let selectedBorrowAmountWad = borrowAmountWad;
  let autoTuneSummary: AutoTuneSummary | undefined;

  if (targetKickDelayDays !== undefined) {
    autoTuneSummary = await autoTuneBorrowAmountWad({
      provider,
      poolAddress,
      borrowerAddress,
      borrowerSigner,
      lenderAddress,
      lenderSigner,
      bucketIndex,
      limitIndex,
      lendAmountWad,
      collateralAmountWad,
      borrowAmountWad,
      maxRemoveAttempts,
      targetKickDelayDays,
    });
    selectedBorrowAmountWad = autoTuneSummary.selectedBorrowAmountWad;
  }

  prepareAndExecute(
    ajnaSkillsRepo,
    'prepare-borrow',
    {
      network: 'base',
      poolAddress,
      actorAddress: borrowerAddress,
      amount: selectedBorrowAmountWad,
      collateralAmount: collateralAmountWad,
      limitIndex,
      approvalMode: 'exact',
      maxAgeSeconds: 600,
    },
    borrowerKey,
    rpcUrl
  );

  let borrowerPosition = inspectBorrower(ajnaSkillsRepo, rpcUrl, poolAddress, borrowerAddress);
  let poolInspection = inspectPool(ajnaSkillsRepo, rpcUrl, poolAddress);
  const removedAmountsWad: string[] = [];
  let attempts = 0;

  while (big(borrowerPosition.thresholdPrice).lt(big(poolInspection.prices.lup)) && attempts < maxRemoveAttempts) {
    const redeemable = big(lenderPosition.quoteRedeemable);
    if (redeemable.isZero()) {
      throw new Error('Lender quoteRedeemable is zero before borrower became kickable');
    }

    const removeAmount = (
      await resolveSafeQuoteRemovalAmount({
        lenderSigner,
        poolAddress,
        bucketIndex,
        maxAmount: redeemable,
      })
    ).toString();
    prepareAndExecute(
      ajnaSkillsRepo,
      'prepare-unsupported-ajna-action',
      {
        network: 'base',
        actorAddress: lenderAddress,
        contractKind: 'erc20-pool',
        contractAddress: poolAddress,
        methodName: 'removeQuoteToken',
        args: [removeAmount, String(bucketIndex)],
        acknowledgeRisk: 'I understand this bypasses the stable skill surface',
        notes: 'Remove quote from dominant bucket to force thresholdPrice >= lup',
      },
      lenderKey,
      rpcUrl,
      { AJNA_ENABLE_UNSAFE_SDK_CALLS: '1' }
    );

    removedAmountsWad.push(removeAmount);
    attempts += 1;
    lenderPosition = inspectLender(ajnaSkillsRepo, rpcUrl, poolAddress, lenderAddress, bucketIndex);
    borrowerPosition = inspectBorrower(ajnaSkillsRepo, rpcUrl, poolAddress, borrowerAddress);
    poolInspection = inspectPool(ajnaSkillsRepo, rpcUrl, poolAddress);
  }

  let keeperKickEligibleByCurrentCode = big(borrowerPosition.thresholdPrice).gte(
    big(poolInspection.prices.lup)
  );
  let strictlyAboveLup = big(borrowerPosition.thresholdPrice).gt(
    big(poolInspection.prices.lup)
  );
  let timeWarpCount = 0;

  while (!keeperKickEligibleByCurrentCode && timeWarpCount < maxTimeWarps) {
    await provider.send('evm_increaseTime', [timeWarpSeconds]);
    await provider.send('evm_mine', []);
    timeWarpCount += 1;
    borrowerPosition = inspectBorrower(ajnaSkillsRepo, rpcUrl, poolAddress, borrowerAddress);
    poolInspection = inspectPool(ajnaSkillsRepo, rpcUrl, poolAddress);
    keeperKickEligibleByCurrentCode = big(borrowerPosition.thresholdPrice).gte(
      big(poolInspection.prices.lup)
    );
    strictlyAboveLup = big(borrowerPosition.thresholdPrice).gt(
      big(poolInspection.prices.lup)
    );
  }

  if (!keeperKickEligibleByCurrentCode) {
    throw new Error(
      `Fixture did not reach keeper kick condition after ${attempts} removal attempts and ${timeWarpCount} time warps: thresholdPrice=${borrowerPosition.thresholdPrice}, lup=${poolInspection.prices.lup}`
    );
  }

  const summary: FixtureSummary = {
    network: 'base',
    rpcUrl,
    repos: {
      tokenDeployerRepo,
      ajnaSkillsRepo,
    },
    tempDir,
    outputPath,
    actors: {
      deployer: deployerAddress,
      lender: lenderAddress,
      borrower: borrowerAddress,
      keeper: keeperAddress,
    },
    tokenRequests: {
      quote: quoteRequest,
      collateral: collateralRequest,
    },
    quoteToken: quoteManifest,
    collateralToken: collateralManifest,
    pool: {
      address: poolAddress,
      interestRate,
      dominantBucketIndex: bucketIndex,
      prices: poolInspection.prices,
    },
    lender: lenderPosition,
    borrower: borrowerPosition,
    liquidationCheck: {
      keeperKickEligibleByCurrentCode,
      strictlyAboveLup,
      keeperCondition: 'thresholdPrice >= lup',
      shapingTarget: 'thresholdPrice > lup',
    },
    borrowPlan: {
      lendAmountWad,
      borrowAmountWad: selectedBorrowAmountWad,
      collateralAmountWad,
      limitIndex,
      requestedBorrowAmountWad:
        autoTuneSummary !== undefined ? borrowAmountWad : undefined,
      targetKickDelayDays,
    },
    autoTune: autoTuneSummary,
    removal: {
      attempts,
      removedAmountsWad,
    },
    timeWarp: {
      count: timeWarpCount,
      secondsPerWarp: timeWarpSeconds,
    },
    uniswapV3ExternalTake: uniswapSummary,
  };

  writeJson(outputPath, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
