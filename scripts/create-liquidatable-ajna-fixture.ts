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
  source?: 'deployed' | 'reused';
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

type FixtureStageSummary = {
  nativeGasFunding: {
    enabled: boolean;
    status: 'funded' | 'skipped';
  };
  createPool: {
    enabled: boolean;
    status: 'created' | 'reused';
  };
  deployTokens: {
    enabled: boolean;
    quoteTokenSource: 'deployed' | 'reused';
    collateralTokenSource: 'deployed' | 'reused';
  };
  transferTokens: {
    enabled: boolean;
    status: 'transferred' | 'skipped';
  };
  seedUniswap?: {
    enabled: boolean;
    status: 'seeded' | 'skipped';
  };
  deployExternalTake?: {
    enabled: boolean;
    mode: 'deployed' | 'reused' | 'skipped';
  };
};

type ExternalTakeDeploymentSummary = {
  mode: 'deployed' | 'reused';
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
  profile?: 'realistic-1d';
  stages: FixtureStageSummary;
  repos: {
    tokenDeployerRepo: string;
    ajnaSkillsRepo: string;
  };
  tempDir: string;
  outputPath: string;
  actors: {
    /**
     * The operator key — funds the lender and borrower, deploys ERC20
     * tokens, creates the pool, seeds Uniswap, owns the external-take
     * factory/taker contracts. After startup, this is also the keeper
     * signer. Previously split as a separate "deployer" role; merged
     * because the two roles never run concurrently.
     */
    keeper: string;
    lender: string;
    borrower: string;
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
    liquidity?: UniswapV3LiquiditySummary;
    deployment?: ExternalTakeDeploymentSummary;
    keeperConfigSnippet?: ExternalTakeSnippetSummary;
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
const ERC20_METADATA_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)'
];
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];
const AJNA_KEEPER_TAKER_FACTORY_ABI = [
  'function owner() view returns (address)',
  'function poolFactory() view returns (address)',
  'function takerContracts(uint8 source) view returns (address)'
];
const UNISWAP_V3_KEEPER_TAKER_ABI = [
  'function owner() view returns (address)',
  'function poolFactory() view returns (address)',
  'function authorizedFactory() view returns (address)'
];
const AJNA_POOL_TOKEN_ABI = [
  'function collateralAddress() view returns (address)',
  'function quoteTokenAddress() view returns (address)'
];
const UNISWAP_V3_LIQUIDITY_SOURCE = 2;

// Ajna pool interest rates in 1e18-fixed WAD form.
//   1e17 = 0.1 = 10% APR (the factory maximum at time of writing; the
//   realistic-1d profile uses it because higher rates accelerate kick-
//   eligibility on a local fork).
//   5e16 = 0.05 = 5% APR (default for non-realistic profiles).
// If Ajna ever raises the factory cap, update FACTORY_MAX_INTEREST_RATE_WAD.
const FACTORY_MAX_INTEREST_RATE_WAD = '100000000000000000';
const DEFAULT_INTEREST_RATE_WAD = '50000000000000000';

// Ajna ERC20Pool's custom error when removing quote would push LUP below
// HTP. We match both the error-name form and the selector hex because
// different provider error shapes surface one or the other. If the Ajna
// ABI ever renames this error, both need updating.
const LUP_BELOW_HTP_ERROR_NAME = 'LUPBelowHTP()';
const LUP_BELOW_HTP_ERROR_SELECTOR = '0x444507e1';

type CliOptions = {
  withUniswapV3ExternalTake: boolean;
  fundNativeGas: boolean;
  createPool: boolean;
  deployTokens: boolean;
  transferTokens: boolean;
  seedUniswap: boolean;
  deployExternalTake: boolean;
};

function parseBooleanValue(name: string, rawValue: string): boolean {
  const normalized = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(
    `${name} must be one of: 1, 0, true, false, yes, no, on, off (received ${rawValue})`
  );
}

function resolveToggle(params: {
  argv: string[];
  enableFlag: string;
  disableFlag: string;
  envName: string;
  defaultValue: boolean;
}): boolean {
  if (params.argv.includes(params.enableFlag)) {
    return true;
  }
  if (params.argv.includes(params.disableFlag)) {
    return false;
  }
  const envValue = process.env[params.envName];
  if (envValue === undefined) {
    return params.defaultValue;
  }
  return parseBooleanValue(params.envName, envValue);
}

function parseOptions(argv: string[]): CliOptions {
  const withUniswapV3ExternalTake =
    argv.includes('--with-uniswap-v3-external-take') ||
    process.env.AJNA_AGENT_ENABLE_UNISWAP_V3_EXTERNAL_TAKE === '1';

  return {
    withUniswapV3ExternalTake,
    fundNativeGas: resolveToggle({
      argv,
      enableFlag: '--fund-native-gas',
      disableFlag: '--no-fund-native-gas',
      envName: 'AJNA_AGENT_FUND_NATIVE_GAS',
      defaultValue: true,
    }),
    createPool: resolveToggle({
      argv,
      enableFlag: '--create-pool',
      disableFlag: '--no-create-pool',
      envName: 'AJNA_AGENT_CREATE_POOL',
      defaultValue: true,
    }),
    deployTokens: resolveToggle({
      argv,
      enableFlag: '--deploy-tokens',
      disableFlag: '--no-deploy-tokens',
      envName: 'AJNA_AGENT_DEPLOY_TOKENS',
      defaultValue: true,
    }),
    transferTokens: resolveToggle({
      argv,
      enableFlag: '--transfer-tokens',
      disableFlag: '--no-transfer-tokens',
      envName: 'AJNA_AGENT_TRANSFER_TOKENS',
      defaultValue: true,
    }),
    seedUniswap: resolveToggle({
      argv,
      enableFlag: '--seed-uniswap',
      disableFlag: '--no-seed-uniswap',
      envName: 'AJNA_AGENT_SEED_UNISWAP',
      defaultValue: withUniswapV3ExternalTake,
    }),
    deployExternalTake: resolveToggle({
      argv,
      enableFlag: '--deploy-external-take',
      disableFlag: '--no-deploy-external-take',
      envName: 'AJNA_AGENT_DEPLOY_EXTERNAL_TAKE',
      defaultValue: withUniswapV3ExternalTake,
    }),
  };
}

function usage() {
  return `Usage: ts-node scripts/create-liquidatable-ajna-fixture.ts [--with-uniswap-v3-external-take] [--fund-native-gas|--no-fund-native-gas] [--create-pool|--no-create-pool] [--deploy-tokens|--no-deploy-tokens] [--transfer-tokens|--no-transfer-tokens] [--seed-uniswap|--no-seed-uniswap] [--deploy-external-take|--no-deploy-external-take]

Required env:
- AJNA_AGENT_RPC_URL or AJNA_RPC_URL_BASE
- AJNA_AGENT_KEEPER_KEY
  (Single operator key: funds lender/borrower, deploys tokens, creates
  the pool, seeds Uniswap, owns the external-take factory/taker, and
  later runs the keeper. Previously split as DEPLOYER_KEY + KEEPER_KEY.)

Optional env:
- AJNA_AGENT_LENDER_KEY
  (Optional. If unset, a fresh wallet is generated and persisted to the
  key file. On re-runs the persisted key is reused.)
- AJNA_AGENT_BORROWER_KEY
  (Same resolution as LENDER_KEY.)
- AJNA_AGENT_KEY_FILE
  (Path to the JSON file storing auto-generated lender/borrower keys.
  Default: ./.fixture-keys.json relative to cwd. File is written with
  mode 0600; add .fixture-keys.json to .gitignore.)
- AJNA_AGENT_TOKEN_DEPLOYER_REPO
- AJNA_AGENT_AJNA_SKILLS_REPO
- AJNA_AGENT_OUTPUT_PATH
- AJNA_AGENT_FUND_NATIVE_GAS=yes|no (default: yes)
- AJNA_AGENT_CREATE_POOL=yes|no (default: yes)
- AJNA_AGENT_POOL_ADDRESS (required when pool creation is disabled)
- AJNA_AGENT_DEPLOY_TOKENS=yes|no (default: yes)
- AJNA_AGENT_TRANSFER_TOKENS=yes|no (default: yes)
- AJNA_AGENT_QUOTE_TOKEN_ADDRESS (reuse existing quote token)
- AJNA_AGENT_COLLATERAL_TOKEN_ADDRESS (reuse existing collateral token)
- AJNA_AGENT_PROFILE
- AJNA_AGENT_BUCKET_INDEX
- AJNA_AGENT_LIMIT_INDEX
- AJNA_AGENT_INTEREST_RATE
- AJNA_AGENT_LEND_AMOUNT_WAD
- AJNA_AGENT_BORROW_AMOUNT_WAD
- AJNA_AGENT_COLLATERAL_AMOUNT_WAD
- AJNA_AGENT_TARGET_KICK_DELAY_DAYS
- AJNA_AGENT_QUOTE_MINT_RAW
- AJNA_AGENT_COLLATERAL_MINT_RAW
- AJNA_AGENT_MAX_REMOVE_ATTEMPTS
- AJNA_AGENT_NATIVE_GAS_FUND_WEI
- AJNA_AGENT_TIME_WARP_SECONDS
- AJNA_AGENT_MAX_TIME_WARPS

Optional Uniswap V3 external-take setup:
- AJNA_AGENT_SEED_UNISWAP=yes|no (default: yes when external take is enabled)
- AJNA_AGENT_DEPLOY_EXTERNAL_TAKE=yes|no (default: yes when external take is enabled)
- AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS (reuse existing factory)
- AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS (reuse existing UniswapV3 taker)
- AJNA_AGENT_UNISWAP_QUOTE_LIQUIDITY_RAW
- AJNA_AGENT_UNISWAP_COLLATERAL_LIQUIDITY_RAW
- AJNA_AGENT_UNISWAP_FEE_TIER
- AJNA_AGENT_UNISWAP_UNIVERSAL_ROUTER_ADDRESS
- AJNA_AGENT_UNISWAP_PERMIT2_ADDRESS
- AJNA_AGENT_UNISWAP_POOL_FACTORY_ADDRESS
- AJNA_AGENT_UNISWAP_QUOTER_V2_ADDRESS
- AJNA_AGENT_UNISWAP_WETH_ADDRESS
- AJNA_AGENT_UNISWAP_POSITION_MANAGER_ADDRESS
- AJNA_AGENT_AJNA_ERC20_POOL_FACTORY
`;
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

const DEFAULT_KEY_FILE_RELATIVE_PATH = '.fixture-keys.json';

type KeyFileRole = 'lender' | 'borrower';

interface KeyFileContents {
  lender?: string;
  borrower?: string;
}

function resolveKeyFilePath(): string {
  const configured = process.env.AJNA_AGENT_KEY_FILE;
  if (configured && configured.length > 0) return path.resolve(configured);
  return path.resolve(process.cwd(), DEFAULT_KEY_FILE_RELATIVE_PATH);
}

function readKeyFile(filePath: string): KeyFileContents {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.warn(
        `[fixture] Key file ${filePath} is not a JSON object; ignoring (a regenerated file will overwrite it).`
      );
      return {};
    }
    const result: KeyFileContents = {};
    if (typeof parsed.lender === 'string' && parsed.lender.length > 0) {
      result.lender = parsed.lender;
    }
    if (typeof parsed.borrower === 'string' && parsed.borrower.length > 0) {
      result.borrower = parsed.borrower;
    }
    return result;
  } catch (error) {
    console.warn(
      `[fixture] Failed to parse key file ${filePath}: ${error instanceof Error ? error.message : String(error)}. Ignoring (a regenerated file will overwrite it).`
    );
    return {};
  }
}

function writeKeyFile(filePath: string, contents: KeyFileContents): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2) + '\n', {
    mode: 0o600,
  });
  // If the file already existed with looser mode, writeFileSync doesn't
  // tighten it. Force 0600 defensively. Log failures instead of silently
  // swallowing — an operator with a noexec FS or root-owned file needs
  // to know the private keys may still be world-readable.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    console.warn(
      `[fixture] Failed to enforce 0600 on ${filePath}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Verify the file permissions manually — it contains plaintext private keys.`
    );
  }
}

/**
 * Resolve a role key with env-var > key-file > auto-generate precedence.
 *
 * - Env var set → use it. Do NOT touch the key file. (Operator's explicit
 *   override; stay out of their way.)
 * - Else key file has this role → reuse.
 * - Else generate a fresh wallet, write the merged key file (role + any
 *   existing roles from the file), log the new address.
 *
 * Returns the private key and a short source label for logging.
 */
function resolveActorKey(
  role: KeyFileRole,
  envVarName: string,
  keyFilePath: string
): { privateKey: string; source: 'env' | 'file' | 'generated' } {
  const fromEnv = process.env[envVarName];
  if (fromEnv && fromEnv.length > 0) {
    return { privateKey: fromEnv, source: 'env' };
  }
  const fileContents = readKeyFile(keyFilePath);
  const fromFile = fileContents[role];
  if (fromFile) {
    return { privateKey: fromFile, source: 'file' };
  }
  // Generate fresh, merge into file, and persist.
  const wallet = Wallet.createRandom();
  const merged: KeyFileContents = { ...fileContents, [role]: wallet.privateKey };
  writeKeyFile(keyFilePath, merged);
  return { privateKey: wallet.privateKey, source: 'generated' };
}

function withGasBuffer(gasEstimate: BigNumber, minGas: number, multiplierBps = 12000): BigNumber {
  const buffered = gasEstimate.mul(multiplierBps).add(9999).div(10000);
  const floor = BigNumber.from(minGas);
  return buffered.gt(floor) ? buffered : floor;
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

  return {
    ...(runTokenDeployer(params.tokenDeployerRepo, [
      'deploy',
      requestPath,
      '--target-dir',
      params.targetDir,
      '--force',
      '--broadcast',
      '--rpc-url',
      params.rpcUrl,
      '--private-key',
      params.privateKey,
    ]) as TokenDeployerManifest),
    source: 'deployed',
  };
}

async function describeExistingErc20(params: {
  provider: ethers.providers.Provider;
  tokenAddress: string;
  fallbackName: string;
  fallbackSymbol: string;
}): Promise<TokenDeployerManifest> {
  const tokenAddress = normalizeAddress(params.tokenAddress);
  const token = new Contract(tokenAddress, ERC20_METADATA_ABI, params.provider);

  let name = params.fallbackName;
  let symbol = params.fallbackSymbol;

  try {
    name = await token.name();
  } catch {
    // Keep fallback metadata when the token contract omits ERC20 metadata.
  }

  try {
    symbol = await token.symbol();
  } catch {
    // Keep fallback metadata when the token contract omits ERC20 metadata.
  }

  return {
    manifestPath: '',
    deployedAddress: tokenAddress,
    name,
    symbol,
    chainId: BASE_CHAIN_ID,
    chainName: BASE_CHAIN_NAME,
    status: 'reused',
    source: 'reused',
  };
}

async function resolveFixtureToken(params: {
  existingAddress?: string;
  provider: ethers.providers.Provider;
  tokenDeployerRepo: string;
  tempDir: string;
  name: string;
  symbol: string;
  owner: string;
  initialSupply: string;
  rpcUrl: string;
  privateKey: string;
  targetDir: string;
}): Promise<TokenDeployerManifest> {
  if (params.existingAddress) {
    return describeExistingErc20({
      provider: params.provider,
      tokenAddress: params.existingAddress,
      fallbackName: params.name,
      fallbackSymbol: params.symbol,
    });
  }

  return deployMintableErc20({
    tokenDeployerRepo: params.tokenDeployerRepo,
    tempDir: params.tempDir,
    name: params.name,
    symbol: params.symbol,
    owner: params.owner,
    initialSupply: params.initialSupply,
    rpcUrl: params.rpcUrl,
    privateKey: params.privateKey,
    targetDir: params.targetDir,
  });
}

function optionalAddressEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  return normalizeAddress(value);
}

async function resolveExistingUniswapV3ExternalTakeDeployment(params: {
  provider: ethers.providers.Provider;
  ajnaPoolFactoryAddress: string;
  keeperTakerFactoryAddress: string;
  uniswapV3TakerAddress: string;
}): Promise<ExternalTakeDeploymentSummary> {
  const ajnaPoolFactoryAddress = normalizeAddress(params.ajnaPoolFactoryAddress);
  const keeperTakerFactoryAddress = normalizeAddress(params.keeperTakerFactoryAddress);
  const uniswapV3TakerAddress = normalizeAddress(params.uniswapV3TakerAddress);

  const keeperTakerFactory = new Contract(
    keeperTakerFactoryAddress,
    AJNA_KEEPER_TAKER_FACTORY_ABI,
    params.provider
  );
  const uniswapV3Taker = new Contract(
    uniswapV3TakerAddress,
    UNISWAP_V3_KEEPER_TAKER_ABI,
    params.provider
  );

  const [
    owner,
    configuredPoolFactory,
    configuredUniswapV3Taker,
    takerOwner,
    takerPoolFactory,
    authorizedFactory,
  ] = await Promise.all([
    keeperTakerFactory.owner(),
    keeperTakerFactory.poolFactory(),
    keeperTakerFactory.takerContracts(UNISWAP_V3_LIQUIDITY_SOURCE),
    uniswapV3Taker.owner(),
    uniswapV3Taker.poolFactory(),
    uniswapV3Taker.authorizedFactory(),
  ]);

  if (normalizeAddress(configuredPoolFactory) !== ajnaPoolFactoryAddress) {
    throw new Error(
      `Existing keeper taker factory ${keeperTakerFactoryAddress} targets Ajna pool factory ${configuredPoolFactory}, expected ${ajnaPoolFactoryAddress}`
    );
  }

  if (normalizeAddress(configuredUniswapV3Taker) !== uniswapV3TakerAddress) {
    throw new Error(
      `Existing keeper taker factory ${keeperTakerFactoryAddress} has UniswapV3 taker ${configuredUniswapV3Taker}, expected ${uniswapV3TakerAddress}`
    );
  }

  if (normalizeAddress(takerOwner) !== normalizeAddress(owner)) {
    throw new Error(
      `Existing UniswapV3 taker ${uniswapV3TakerAddress} owner ${takerOwner} does not match factory owner ${owner}`
    );
  }

  if (normalizeAddress(takerPoolFactory) !== ajnaPoolFactoryAddress) {
    throw new Error(
      `Existing UniswapV3 taker ${uniswapV3TakerAddress} targets Ajna pool factory ${takerPoolFactory}, expected ${ajnaPoolFactoryAddress}`
    );
  }

  if (normalizeAddress(authorizedFactory) !== keeperTakerFactoryAddress) {
    throw new Error(
      `Existing UniswapV3 taker ${uniswapV3TakerAddress} authorizes factory ${authorizedFactory}, expected ${keeperTakerFactoryAddress}`
    );
  }

  return {
    mode: 'reused',
    owner: normalizeAddress(owner),
    ajnaPoolFactory: ajnaPoolFactoryAddress,
    keeperTakerFactory: keeperTakerFactoryAddress,
    uniswapV3Taker: uniswapV3TakerAddress,
  };
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

async function ensureNativeBalance(params: {
  signer: Wallet;
  provider: ethers.providers.JsonRpcProvider;
  to: string;
  minimumWei: string;
}) {
  const minimum = BigNumber.from(params.minimumWei);
  const current = await params.provider.getBalance(params.to);
  if (current.gte(minimum)) {
    return;
  }
  const tx = await params.signer.sendTransaction({
    to: params.to,
    value: minimum.sub(current),
    gasLimit: 21_000,
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
  // ERC20Pool.debtInfo() returns an unnamed 4-tuple:
  //   [0] poolDebt_, [1] accruedDebt_, [2] debtInAuction_, [3] t0Debt_
  // Typechain doesn't emit named properties for this ABI so we index by
  // position. Update the index if Ajna ever re-shapes the tuple.
  const [, , poolDebtInAuction] = debtInfo;
  return {
    owner,
    debt: borrowerInfo.debt_.toString(),
    collateral: borrowerInfo.collateral_.toString(),
    thresholdPrice: borrowerInfo.thresholdPrice_.toString(),
    neutralPrice: borrowerInfo.t0Np_.toString(),
    poolDebtInAuction: poolDebtInAuction.toString(),
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
      if (
        !message.includes(LUP_BELOW_HTP_ERROR_NAME) &&
        !message.includes(LUP_BELOW_HTP_ERROR_SELECTOR)
      ) {
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

// Auto-tune phase 1 (upper-bound probe) grows the candidate borrow amount
// by this percentage per step until the simulation reports kick-eligibility
// within the target delay. 5% per step is the balance point: smaller steps
// burn RPC round-trips on doomed simulations; larger steps overshoot and
// make the subsequent binary search converge to a value well above the
// minimum kickable borrow amount, producing a fixture with more auction
// headroom than needed.
const BORROW_PROBE_GROWTH_BPS = 10_500;

// Auto-tune phase 2 (binary search) halves the [lower, upper] range this
// many times. 18 halvings ≈ 2^-18 (~4e-6) of the initial range — far
// tighter than any WAD-precision borrow delta we care about. Each halving
// is one simulation round-trip, so this also bounds the RPC cost of the
// tune at ~20 calls worst case.
const BORROW_BINARY_SEARCH_ITERATIONS = 18;

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

  const initialLowerResult = await evaluate(lower);
  if (initialLowerResult.keeperKickEligibleAfterDelay) {
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
    const nextUpper = upper.mul(BORROW_PROBE_GROWTH_BPS).div(10_000);
    upper = nextUpper.gt(upper) ? nextUpper : upper.add(1);
    if (upper.gt(maxBorrowAmount)) {
      upper = maxBorrowAmount;
    }
    const upperResult = await evaluate(upper);
    if (upperResult.keeperKickEligibleAfterDelay) {
      break;
    }
    lower = upper;
    if (upper.eq(maxBorrowAmount)) {
      throw new Error(
        `Auto-tune could not find a borrow amount that becomes kickable within ${params.targetKickDelayDays} days before hitting the lend amount cap`
      );
    }
  }

  for (let i = 0; i < BORROW_BINARY_SEARCH_ITERATIONS; i += 1) {
    const mid = lower.add(upper).div(2);
    if (mid.lte(lower) || mid.gte(upper)) {
      break;
    }
    const midResult = await evaluate(mid);
    if (midResult.keeperKickEligibleAfterDelay) {
      upper = mid;
    } else {
      lower = mid;
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

  const createGasEstimate = await positionManager.estimateGas.createAndInitializePoolIfNecessary(
    ordered.token0,
    ordered.token1,
    routerConfig.defaultFeeTier,
    sqrtPriceX96
  );
  const createTx = await positionManager.createAndInitializePoolIfNecessary(
    ordered.token0,
    ordered.token1,
    routerConfig.defaultFeeTier,
    sqrtPriceX96,
    { gasLimit: withGasBuffer(createGasEstimate, 400_000) }
  );
  await createTx.wait();

  const provider = signer.provider;
  if (!provider) {
    throw new Error('Signer provider missing while creating Uniswap V3 pool');
  }
  const latestBlock = await provider.getBlock('latest');
  const recipient = await signer.getAddress();
  const mintParams = {
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
    // 1-hour deadline measured from the fetched block's timestamp. Fork
    // block timestamps can drift relative to wall clock (the fixture
    // uses `evm_increaseTime` elsewhere in the run), so base the
    // deadline off `latestBlock.timestamp` rather than `Date.now()`.
    // 1 hour is comfortably beyond the mint's RPC-call budget.
    deadline: latestBlock.timestamp + 3600,
  };
  const mintGasEstimate = await positionManager.estimateGas.mint(mintParams);
  const mintTx = await positionManager.mint(mintParams, {
    gasLimit: withGasBuffer(mintGasEstimate, 700_000),
  });
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
  const factoryDeployTx = factoryFactory.getDeployTransaction(params.ajnaPoolFactoryAddress);
  const keeperFactoryDeployGasEstimate = await params.ownerSigner.estimateGas(factoryDeployTx);
  const keeperTakerFactory = await factoryFactory.deploy(params.ajnaPoolFactoryAddress, {
    gasLimit: withGasBuffer(keeperFactoryDeployGasEstimate, 1_500_000),
  });
  await keeperTakerFactory.deployed();

  const uniswapTakerFactory = new ContractFactory(
    takerArtifact.abi,
    takerArtifact.bytecode,
    params.ownerSigner
  );
  const takerDeployTx = uniswapTakerFactory.getDeployTransaction(
    params.ajnaPoolFactoryAddress,
    keeperTakerFactory.address
  );
  const uniswapTakerDeployGasEstimate = await params.ownerSigner.estimateGas(takerDeployTx);
  const uniswapV3Taker = await uniswapTakerFactory.deploy(
    params.ajnaPoolFactoryAddress,
    keeperTakerFactory.address,
    { gasLimit: withGasBuffer(uniswapTakerDeployGasEstimate, 1_500_000) }
  );
  await uniswapV3Taker.deployed();

  const setTakerGasEstimate = await keeperTakerFactory.estimateGas.setTaker(
    UNISWAP_V3_LIQUIDITY_SOURCE,
    uniswapV3Taker.address
  );
  const setTakerTx = await keeperTakerFactory.setTaker(
    UNISWAP_V3_LIQUIDITY_SOURCE,
    uniswapV3Taker.address,
    { gasLimit: withGasBuffer(setTakerGasEstimate, 250_000) }
  );
  await setTakerTx.wait();

  return {
    mode: 'deployed',
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

  // AJNA_AGENT_KEEPER_KEY is the single operator key: funds all other
  // actors, deploys ERC20 tokens, creates the Ajna pool, seeds Uniswap,
  // and owns the external-take factory/taker contracts when those are
  // deployed.
  const keeperKey = requiredEnv('AJNA_AGENT_KEEPER_KEY');

  // Lender and borrower keys are optional. Resolution per role:
  //   1. Env var set (AJNA_AGENT_LENDER_KEY / AJNA_AGENT_BORROWER_KEY) → use
  //   2. Else AJNA_AGENT_KEY_FILE (default ./.fixture-keys.json) has the role → reuse
  //   3. Else generate a fresh wallet, persist to the key file, log the address
  // First-time runs work with just AJNA_AGENT_KEEPER_KEY. Re-runs are
  // idempotent — the file is read on each invocation and fresh keys
  // only appear when one wasn't found.
  const keyFilePath = resolveKeyFilePath();
  const lenderResolution = resolveActorKey(
    'lender',
    'AJNA_AGENT_LENDER_KEY',
    keyFilePath
  );
  const borrowerResolution = resolveActorKey(
    'borrower',
    'AJNA_AGENT_BORROWER_KEY',
    keyFilePath
  );
  const lenderKey = lenderResolution.privateKey;
  const borrowerKey = borrowerResolution.privateKey;
  const existingQuoteTokenAddress = optionalAddressEnv('AJNA_AGENT_QUOTE_TOKEN_ADDRESS');
  const existingCollateralTokenAddress = optionalAddressEnv('AJNA_AGENT_COLLATERAL_TOKEN_ADDRESS');
  const existingPoolAddress = optionalAddressEnv('AJNA_AGENT_POOL_ADDRESS');
  const existingKeeperTakerFactoryAddress = optionalAddressEnv(
    'AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS'
  );
  const existingUniswapV3TakerAddress = optionalAddressEnv('AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS');
  const shouldFundNativeGas = options.fundNativeGas;
  const shouldCreatePool = options.createPool;
  const shouldDeployTokens = options.deployTokens;
  const shouldTransferTokens = options.transferTokens;
  const shouldSeedUniswap = options.withUniswapV3ExternalTake && options.seedUniswap;
  const shouldDeployExternalTake = options.withUniswapV3ExternalTake && options.deployExternalTake;

  if (!shouldCreatePool && !existingPoolAddress) {
    throw new Error('AJNA_AGENT_POOL_ADDRESS is required when pool creation is disabled');
  }

  if (!shouldDeployTokens && !existingQuoteTokenAddress) {
    throw new Error(
      'AJNA_AGENT_QUOTE_TOKEN_ADDRESS is required when token deployment is disabled'
    );
  }
  if (!shouldDeployTokens && !existingCollateralTokenAddress) {
    throw new Error(
      'AJNA_AGENT_COLLATERAL_TOKEN_ADDRESS is required when token deployment is disabled'
    );
  }

  if (Boolean(existingKeeperTakerFactoryAddress) !== Boolean(existingUniswapV3TakerAddress)) {
    throw new Error(
      'AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS and AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS must be provided together when reusing external-take contracts'
    );
  }

  if (!shouldDeployExternalTake && options.withUniswapV3ExternalTake) {
    if (!(existingKeeperTakerFactoryAddress && existingUniswapV3TakerAddress)) {
      throw new Error(
        'AJNA_AGENT_KEEPER_TAKER_FACTORY_ADDRESS and AJNA_AGENT_UNISWAP_V3_TAKER_ADDRESS are required when external-take deployment is disabled'
      );
    }
  }

  if (options.withUniswapV3ExternalTake && !shouldSeedUniswap && shouldDeployExternalTake) {
    throw new Error(
      'Cannot deploy external-take contracts while Uniswap seeding is disabled; disable both or enable seeding'
    );
  }

  const tokenDeployerRepo = resolveRepoPath('AJNA_AGENT_TOKEN_DEPLOYER_REPO', '../token-deployer');
  const ajnaSkillsRepo = resolveRepoPath('AJNA_AGENT_AJNA_SKILLS_REPO', '../ajna-skills');
  const fixtureProfile = process.env.AJNA_AGENT_PROFILE;
  if (fixtureProfile !== undefined && fixtureProfile !== 'realistic-1d') {
    throw new Error(`Unsupported AJNA_AGENT_PROFILE: ${fixtureProfile}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajna-liquidation-fixture-'));
  const outputPath = path.resolve(
    process.env.AJNA_AGENT_OUTPUT_PATH ?? path.join(tempDir, 'fixture-summary.json')
  );

  const defaultInterestRate =
    fixtureProfile === 'realistic-1d'
      ? FACTORY_MAX_INTEREST_RATE_WAD
      : DEFAULT_INTEREST_RATE_WAD;
  const interestRate = optionalEnv('AJNA_AGENT_INTEREST_RATE', defaultInterestRate);
  const bucketIndex = Number(optionalEnv('AJNA_AGENT_BUCKET_INDEX', '4600'));
  const limitIndex = Number(optionalEnv('AJNA_AGENT_LIMIT_INDEX', '5000'));
  const lendAmountWad = optionalEnv('AJNA_AGENT_LEND_AMOUNT_WAD', '1000000000000000000000');
  const borrowAmountWad = optionalEnv('AJNA_AGENT_BORROW_AMOUNT_WAD', '10000000000000000000');
  const collateralAmountWad = optionalEnv('AJNA_AGENT_COLLATERAL_AMOUNT_WAD', '100000000000000000000');
  const targetKickDelayDaysRaw =
    process.env.AJNA_AGENT_TARGET_KICK_DELAY_DAYS ??
    (fixtureProfile === 'realistic-1d' ? '1' : undefined);
  const targetKickDelayDays = targetKickDelayDaysRaw
    ? Number(targetKickDelayDaysRaw)
    : undefined;
  if (
    targetKickDelayDaysRaw !== undefined &&
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
    // Keeper is always present now (it's the operator key), so always
    // include the buffer in the quote mint so the keeper has enough for
    // downstream take/swap operations.
    .add(big(quoteKeeperBufferRaw))
    .toString();
  const collateralInitialSupplyRaw = big(collateralMintRaw)
    .add(big(collateralLiquidityRaw))
    .toString();
  const maxRemoveAttempts = Number(optionalEnv('AJNA_AGENT_MAX_REMOVE_ATTEMPTS', '16'));
  const nativeGasFundWei = optionalEnv('AJNA_AGENT_NATIVE_GAS_FUND_WEI', '1000000000000000000');

  const keeperAddress = actorAddress(keeperKey);
  const lenderAddress = actorAddress(lenderKey);
  const borrowerAddress = actorAddress(borrowerKey);

  const keySourceLabel = (source: 'env' | 'file' | 'generated') =>
    source === 'env'
      ? 'env var'
      : source === 'file'
        ? `reused from ${keyFilePath}`
        : `generated and saved to ${keyFilePath}`;
  console.log(
    `[fixture] Keeper (operator): ${keeperAddress}\n` +
      `[fixture] Lender: ${lenderAddress} (${keySourceLabel(lenderResolution.source)})\n` +
      `[fixture] Borrower: ${borrowerAddress} (${keySourceLabel(borrowerResolution.source)})`
  );

  const quoteRequest = {
    standard: 'erc20',
    name: optionalEnv('AJNA_AGENT_QUOTE_TOKEN_NAME', 'Quote Test Token'),
    symbol: optionalEnv('AJNA_AGENT_QUOTE_TOKEN_SYMBOL', 'QTEST'),
    chainId: BASE_CHAIN_ID,
    chainName: BASE_CHAIN_NAME,
    owner: keeperAddress,
    initialRecipient: keeperAddress,
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
    owner: keeperAddress,
    initialRecipient: keeperAddress,
    initialSupply: collateralInitialSupplyRaw,
    decimals: 18,
    mintable: true,
  };

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const keeperSigner = new Wallet(keeperKey, provider);
  const lenderSigner = new Wallet(lenderKey, provider);
  const borrowerSigner = new Wallet(borrowerKey, provider);
  // If an existing token address is provided via env var, always reuse it regardless of the
  // deploy flag. The flag acts as a strictness guard: when disabled, the validation above
  // requires the env var to be set. This keeps re-runs idempotent against state from earlier
  // deployments.
  const quoteManifest = await resolveFixtureToken({
    existingAddress: existingQuoteTokenAddress,
    provider,
    tokenDeployerRepo,
    tempDir,
    name: quoteRequest.name,
    symbol: quoteRequest.symbol,
    owner: keeperAddress,
    initialSupply: quoteRequest.initialSupply,
    rpcUrl,
    privateKey: keeperKey,
    targetDir: path.join(tempDir, 'quote-token-workspace'),
  });
  const collateralManifest = await resolveFixtureToken({
    existingAddress: existingCollateralTokenAddress,
    provider,
    tokenDeployerRepo,
    tempDir,
    name: collateralRequest.name,
    symbol: collateralRequest.symbol,
    owner: keeperAddress,
    initialSupply: collateralRequest.initialSupply,
    rpcUrl,
    privateKey: keeperKey,
    targetDir: path.join(tempDir, 'collateral-token-workspace'),
  });
  const stages: FixtureStageSummary = {
    nativeGasFunding: {
      enabled: shouldFundNativeGas,
      status: shouldFundNativeGas ? 'funded' : 'skipped',
    },
    createPool: {
      enabled: shouldCreatePool,
      status: shouldCreatePool ? 'created' : 'reused',
    },
    deployTokens: {
      enabled: shouldDeployTokens,
      quoteTokenSource: quoteManifest.source ?? (existingQuoteTokenAddress ? 'reused' : 'deployed'),
      collateralTokenSource:
        collateralManifest.source ?? (existingCollateralTokenAddress ? 'reused' : 'deployed'),
    },
    transferTokens: {
      enabled: shouldTransferTokens,
      status: shouldTransferTokens ? 'transferred' : 'skipped',
    },
    ...(options.withUniswapV3ExternalTake
      ? {
          seedUniswap: {
            enabled: shouldSeedUniswap,
            status: shouldSeedUniswap ? 'seeded' : 'skipped',
          },
          deployExternalTake: {
            enabled: shouldDeployExternalTake,
            mode: shouldDeployExternalTake
              ? 'deployed'
              : existingKeeperTakerFactoryAddress && existingUniswapV3TakerAddress
                ? 'reused'
                : 'skipped',
          },
        }
      : {}),
  };

  if (shouldFundNativeGas) {
    // The keeper is the funding source for the lender and borrower. It
    // doesn't need to fund itself — it's already running with gas.
    await ensureNativeBalance({
      signer: keeperSigner,
      provider,
      to: lenderAddress,
      minimumWei: nativeGasFundWei,
    });
    await ensureNativeBalance({
      signer: keeperSigner,
      provider,
      to: borrowerAddress,
      minimumWei: nativeGasFundWei,
    });
  }

  if (shouldTransferTokens) {
    await transferErc20({
      signer: keeperSigner,
      tokenAddress: quoteManifest.deployedAddress,
      to: lenderAddress,
      amount: quoteMintRaw,
    });
    await transferErc20({
      signer: keeperSigner,
      tokenAddress: collateralManifest.deployedAddress,
      to: borrowerAddress,
      amount: collateralMintRaw,
    });
    // Keeper retains its own `quoteKeeperBufferRaw` in-place (already the
    // mint recipient for the full quote supply). No self-transfer needed.
  }

  let uniswapSummary: FixtureSummary['uniswapV3ExternalTake'];
  let uniswapBootstrap:
    | {
        routerConfig: UniswapV3RouterConfig;
        liquidity?: UniswapV3LiquiditySummary;
        deployment?: ExternalTakeDeploymentSummary;
      }
    | undefined;
  if (options.withUniswapV3ExternalTake) {
    const routerConfig = resolveUniswapV3RouterConfig();
    const ajnaPoolFactoryAddress = optionalEnv(
      'AJNA_AGENT_AJNA_ERC20_POOL_FACTORY',
      BASE_AJNA_ERC20_POOL_FACTORY
    );
    const liquidity = shouldSeedUniswap
      ? await createAndSeedUniswapV3Pool({
          signer: keeperSigner,
          quoteTokenAddress: quoteManifest.deployedAddress,
          collateralTokenAddress: collateralManifest.deployedAddress,
          quoteLiquidityRaw,
          collateralLiquidityRaw,
          routerConfig,
        })
      : undefined;
    const deployment = shouldDeployExternalTake
      ? existingKeeperTakerFactoryAddress && existingUniswapV3TakerAddress
        ? await resolveExistingUniswapV3ExternalTakeDeployment({
            provider,
            ajnaPoolFactoryAddress,
            keeperTakerFactoryAddress: existingKeeperTakerFactoryAddress,
            uniswapV3TakerAddress: existingUniswapV3TakerAddress,
          })
        : await deployUniswapV3ExternalTakeContracts({
            ownerSigner: keeperSigner,
            ajnaPoolFactoryAddress,
          })
      : existingKeeperTakerFactoryAddress && existingUniswapV3TakerAddress
        ? await resolveExistingUniswapV3ExternalTakeDeployment({
            provider,
            ajnaPoolFactoryAddress,
            keeperTakerFactoryAddress: existingKeeperTakerFactoryAddress,
            uniswapV3TakerAddress: existingUniswapV3TakerAddress,
          })
        : undefined;

    if (stages.deployExternalTake && deployment) {
      stages.deployExternalTake.mode = deployment.mode;
    }

    uniswapBootstrap = {
      routerConfig,
      liquidity,
      deployment,
    };
  }

  const poolAddress = shouldCreatePool
    ? (() => {
        const createPoolResult = prepareAndExecute(
          ajnaSkillsRepo,
          'prepare-create-erc20-pool',
          {
            network: 'base',
            actorAddress: keeperAddress,
            collateralAddress: collateralManifest.deployedAddress,
            quoteAddress: quoteManifest.deployedAddress,
            interestRate,
            maxAgeSeconds: 600,
          },
          keeperKey,
          rpcUrl
        );

        const resolvedPoolAddress = createPoolResult.resolvedPoolAddress;
        if (!resolvedPoolAddress) {
          throw new Error('Pool creation did not return resolvedPoolAddress');
        }
        return resolvedPoolAddress;
      })()
    : existingPoolAddress!;

  // Confirm the resolved pool's token pair matches the resolved manifests. Catches env-var
  // typos pointing at a pool for a different token pair before we waste RPC on doomed
  // lend/borrow/kick calls.
  {
    const poolContract = new Contract(poolAddress, AJNA_POOL_TOKEN_ABI, provider);
    const [poolCollateral, poolQuote] = await Promise.all([
      poolContract.collateralAddress(),
      poolContract.quoteTokenAddress(),
    ]);
    const expectedCollateral = normalizeAddress(collateralManifest.deployedAddress);
    const expectedQuote = normalizeAddress(quoteManifest.deployedAddress);
    if (normalizeAddress(poolCollateral) !== expectedCollateral) {
      throw new Error(
        `Pool ${poolAddress} collateral ${poolCollateral} does not match expected ${expectedCollateral}`
      );
    }
    if (normalizeAddress(poolQuote) !== expectedQuote) {
      throw new Error(
        `Pool ${poolAddress} quote token ${poolQuote} does not match expected ${expectedQuote}`
      );
    }
  }

  if (uniswapBootstrap) {
    let keeperConfigSnippet: ExternalTakeSnippetSummary | undefined;
    if (uniswapBootstrap.deployment) {
      const snippetContent = buildKeeperExternalTakeSnippet({
        poolAddress,
        quoteToken: quoteManifest,
        collateralToken: collateralManifest,
        routerConfig: uniswapBootstrap.routerConfig,
        deployment: uniswapBootstrap.deployment,
      });
      const snippetPath = path.join(tempDir, 'keeper-uniswap-v3-config-snippet.ts');
      fs.writeFileSync(snippetPath, `${snippetContent}\n`);
      keeperConfigSnippet = {
        path: snippetPath,
        content: snippetContent,
      };
    }

    uniswapSummary = {
      routerConfig: uniswapBootstrap.routerConfig,
      liquidity: uniswapBootstrap.liquidity,
      deployment: uniswapBootstrap.deployment,
      keeperConfigSnippet,
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
    profile: fixtureProfile === 'realistic-1d' ? 'realistic-1d' : undefined,
    stages,
    repos: {
      tokenDeployerRepo,
      ajnaSkillsRepo,
    },
    tempDir,
    outputPath,
    actors: {
      keeper: keeperAddress,
      lender: lenderAddress,
      borrower: borrowerAddress,
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
