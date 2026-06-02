import { utils } from 'ethers';
import {
  AutoDiscoverTakePolicy,
  DiscoveryConfig,
  ExternalTakePathKind,
  LifiDexConfig,
  LiquiditySource,
} from '../../../src/config';
import { SECONDS_PER_DAY } from '../../../src/constants';
import {
  getLifiPolicyApiKey,
  requireDefaultLifiApiBaseUrl,
} from '../../../src/dex/lifi';

export type HybridForkEnv = Record<string, string | undefined>;

export type ProductionLifiDexConfig = Extract<
  LifiDexConfig,
  { mode: 'production' }
>;

export interface HybridForkFixture {
  poolAddress: string;
  lenderWhale: string;
  borrowerWhale: string;
  kickerWhale: string;
  depositQuoteAmount: number;
  depositPrice: number;
  borrowAmount: number;
  collateralToPledge: number;
  timeToKick: number;
  timeAfterKick: number;
  maxWarps: number;
  warpSeconds: number;
  marketPriceFactor: number;
  minCollateral: number;
  liveTake: boolean;
  paths: ExternalTakePathKind[];
}

export type HybridForcedDiscoveryPolicy = DiscoveryConfig & {
  defaults: {
    take: {
      liquiditySource: LiquiditySource;
      marketPriceFactor: number;
      minCollateral: number;
    };
  };
  take: AutoDiscoverTakePolicy;
};

export const HYBRID_FORK_CONFIG_ENV = 'AJNA_AGENT_HYBRID_FORK_CONFIG';
export const DEFAULT_BASE_WETH_USDC_POOL =
  '0x0b17159f2486f669a1f930926638008e2ccb4287';
export const DEFAULT_HYBRID_EXTERNAL_TAKE_PATHS: ExternalTakePathKind[] = [
  'oneinch',
  'factory',
  'lifi',
];

export function optionalHybridEnv(
  env: HybridForkEnv,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function requireHybridEnv(
  env: HybridForkEnv,
  name: string,
  hint: string
): string {
  const value = optionalHybridEnv(env, name);
  if (!value) {
    throw new Error(
      `${name} is required for RUN_HYBRID_FORK_LOOP=true (${hint})`
    );
  }
  return value;
}

export function parseHybridEnvNumber(
  env: HybridForkEnv,
  name: string,
  fallback: number
): number {
  const value = optionalHybridEnv(env, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

export function requireProductionLifi(
  lifi: LifiDexConfig
): ProductionLifiDexConfig {
  if (lifi.mode !== 'production') {
    throw new Error('reviewed config dex.lifi must be production mode');
  }
  return lifi;
}

export function requireDefaultHybridLifiApiBaseUrl(
  apiBaseUrl: string | undefined
): void {
  requireDefaultLifiApiBaseUrl({
    apiBaseUrl,
    errorMessage:
      'hybrid LI.FI fork execution proof requires the default LI.FI API base URL; refusing custom or mocked API base URL',
  });
}

export function getHybridLifiApiKey(
  config: LifiDexConfig,
  env: HybridForkEnv = process.env
): string | undefined {
  return getLifiPolicyApiKey({
    config,
    env,
    fallbackEnvNames: [
      'AJNA_AGENT_LIFI_API_KEY',
      'AJNA_AGENT_HYBRID_LIFI_API_KEY',
      'LIFI_API_KEY',
    ],
    readEnv: optionalHybridEnv,
  });
}

export function parseHybridPaths(
  env: HybridForkEnv = process.env
): ExternalTakePathKind[] {
  const raw = optionalHybridEnv(env, 'AJNA_AGENT_HYBRID_PATHS');
  if (!raw) {
    return DEFAULT_HYBRID_EXTERNAL_TAKE_PATHS;
  }
  const parsed = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const valid = parsed.filter((value): value is ExternalTakePathKind =>
    (DEFAULT_HYBRID_EXTERNAL_TAKE_PATHS as string[]).includes(value)
  );
  if (valid.length === 0 || valid.length !== parsed.length) {
    throw new Error(
      'AJNA_AGENT_HYBRID_PATHS must be a non-empty CSV subset of: oneinch,factory,lifi'
    );
  }
  return valid;
}

export function defaultSourceForHybridPaths(
  paths: readonly ExternalTakePathKind[]
): LiquiditySource {
  if (paths.includes('factory')) {
    return LiquiditySource.UNISWAPV3;
  }
  if (paths.includes('lifi')) {
    return LiquiditySource.LIFI;
  }
  return LiquiditySource.ONEINCH;
}

export function loadHybridForkFixture(
  env: HybridForkEnv = process.env
): HybridForkFixture {
  const lenderWhale = requireHybridEnv(
    env,
    'AJNA_AGENT_HYBRID_LENDER_WHALE',
    "an account holding the pool's quote token at the fork block"
  );
  return {
    poolAddress: utils.getAddress(
      optionalHybridEnv(env, 'AJNA_AGENT_HYBRID_POOL') ??
        DEFAULT_BASE_WETH_USDC_POOL
    ),
    lenderWhale: utils.getAddress(lenderWhale),
    borrowerWhale: utils.getAddress(
      requireHybridEnv(
        env,
        'AJNA_AGENT_HYBRID_BORROWER_WHALE',
        "an account holding the pool's collateral token at the fork block"
      )
    ),
    kickerWhale: utils.getAddress(
      optionalHybridEnv(env, 'AJNA_AGENT_HYBRID_KICKER_WHALE') ?? lenderWhale
    ),
    depositQuoteAmount: parseHybridEnvNumber(
      env,
      'AJNA_AGENT_HYBRID_DEPOSIT_QUOTE_AMOUNT',
      5000
    ),
    depositPrice: parseHybridEnvNumber(
      env,
      'AJNA_AGENT_HYBRID_DEPOSIT_PRICE',
      2010
    ),
    borrowAmount: parseHybridEnvNumber(
      env,
      'AJNA_AGENT_HYBRID_BORROW_AMOUNT',
      1900
    ),
    collateralToPledge: parseHybridEnvNumber(
      env,
      'AJNA_AGENT_HYBRID_COLLATERAL_PLEDGE',
      1
    ),
    timeToKick:
      SECONDS_PER_DAY *
      parseHybridEnvNumber(env, 'AJNA_AGENT_HYBRID_TIME_TO_KICK_DAYS', 10950),
    timeAfterKick:
      3600 *
      parseHybridEnvNumber(env, 'AJNA_AGENT_HYBRID_TIME_AFTER_KICK_HOURS', 24),
    maxWarps: parseHybridEnvNumber(env, 'AJNA_AGENT_HYBRID_MAX_WARPS', 24),
    warpSeconds:
      3600 * parseHybridEnvNumber(env, 'AJNA_AGENT_HYBRID_WARP_HOURS', 6),
    marketPriceFactor: parseHybridEnvNumber(
      env,
      'AJNA_AGENT_HYBRID_MARKET_PRICE_FACTOR',
      0.99
    ),
    minCollateral: parseHybridEnvNumber(
      env,
      'AJNA_AGENT_HYBRID_MIN_COLLATERAL',
      0.0001
    ),
    liveTake: env.AJNA_AGENT_HYBRID_FORK_LIVE_TAKE === 'true',
    paths: parseHybridPaths(env),
  };
}

export function shouldRunLifiCallbackProof(
  fixture: HybridForkFixture,
  env: HybridForkEnv = process.env
): boolean {
  return (
    fixture.paths.includes('lifi') &&
    env.AJNA_AGENT_HYBRID_LIFI_CALLBACK_PROOF === 'true'
  );
}

export function buildForcedDiscoveryPolicy(
  fixture: HybridForkFixture
): HybridForcedDiscoveryPolicy {
  const paths = fixture.paths;
  const take: AutoDiscoverTakePolicy = {
    enabled: true,
    allowedExternalTakePaths: paths,
    externalTakeRouteSelectionMode: 'maximize_profit',
    validateRouteDeployments: true,
    maxGasCostNative: 0.05,
    externalTakeProbeTimeoutMs: 8000,
    oneInchQuoteTimeoutMs: 8000,
  };
  if (paths.includes('factory')) {
    take.defaultFactoryLiquiditySource = LiquiditySource.UNISWAPV3;
    take.allowedLiquiditySources = [LiquiditySource.UNISWAPV3];
  }
  if (paths.includes('lifi')) {
    take.dexGasOverrides = { [LiquiditySource.LIFI]: '900000' };
  }
  return {
    enabled: true,
    logSkips: true,
    defaults: {
      take: {
        liquiditySource: defaultSourceForHybridPaths(paths),
        marketPriceFactor: fixture.marketPriceFactor,
        minCollateral: fixture.minCollateral,
      },
    },
    take,
  };
}
