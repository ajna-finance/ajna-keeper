//
// Config-loaded discovery smoke for the no-spend fixture harness.
//
// This drives the REAL config -> validation -> preflight -> discovery pipeline
// against the locally-created fixture (dry-run, zero egress) and emits a
// ConfigArtifact whose 13 booleans are each asserted `=== true` by
// assertConfigArtifact (scripts/run-no-spend-validation.mjs). None of the
// booleans are hardcoded — every one is the observed result of calling the
// same src/ function the production keeper uses:
//
//   * config load/validation .... assertIsValidConfig, validateAutoDiscoverConfig
//   * route preflight ........... resolveExternalTakeRouteDeploymentPreflight,
//                                 validateExternalTakeRouteDeployments
//   * subgraph/chain preflight .. assertSubgraphChainConsistency
//   * discovery target build .... buildDiscoveredTakeTargets, validateResolvedTakeTarget
//   * execution-config wiring ... getDiscoveryExecutionConfig, resolveExternalTakeDeployment
//   * pool hydration cooldown ... ensurePoolLoaded (failure path + cooldown reuse)
//
// The returned `target` is the config-built ResolvedTakeTarget for the fixture
// pool; the harness reuses it as the discovered-take target override so the
// subsequent take attempt runs against a target that came out of the config
// path (not the harness's hand-built fixture shortcut).
//
// The KeeperConfig assembled here mirrors buildDaemonConfig in
// scripts/no-spend/daemon-smoke.mjs — the same config startKeeperFromConfig
// already validates and runs in the persistent no-spend daemon.

import { Address, AjnaSDK, FungiblePool } from '@ajna-finance/sdk';
import { ethers } from 'ethers';
import {
  KeeperConfig,
  LiquiditySource,
  assertIsValidConfig,
  getAutoDiscoverTakePolicy,
  resolveExternalTakeDeployment,
  validateAutoDiscoverConfig,
} from '../../src/config';
import {
  buildDiscoveredTakeTargets,
  ensurePoolLoaded,
  normalizeAddress,
  validateResolvedTakeTarget,
  type PoolHydrationCooldowns,
  type PoolMap,
  type ResolvedTakeTarget,
} from '../../src/discovery/targets';
import { getDiscoveryExecutionConfig } from '../../src/discovery/types';
import {
  resolveExternalTakeRouteDeploymentPreflight,
  validateExternalTakeRouteDeployments,
} from '../../src/discovery/route-preflight-validation';
import { assertSubgraphChainConsistency } from '../../src/run';
import type { ChainwideLiquidationAuction } from '../../src/subgraph';
import { makeFixtureSubgraphReader } from './fixture-subgraph';
import {
  BASE_AJNA_CONFIG,
  BASE_ONEINCH_ROUTER,
  FIXTURE_SUBGRAPH_SENTINEL_URL,
} from './fixture-constants';

// Structural subset of the harness's FixtureSummary (declared inline in
// scripts/fixture-keeper-harness-cli.ts). Only the fields this smoke reads are
// listed; the richer harness type is structurally assignable to this.
export interface ConfigSmokeFixtureSummary {
  rpcUrl: string;
  pool: { address: string };
  borrower: {
    owner: string;
    debt?: string;
    collateral?: string;
    neutralPrice: string;
  };
  uniswapV3ExternalTake?: {
    routerConfig: {
      swapRouter02Address: string;
      poolFactoryAddress: string;
      quoterV2Address: string;
      wethAddress: string;
      defaultFeeTier: number;
      candidateFeeTiers?: number[];
      defaultSlippage: number;
    };
    deployment: {
      keeperTakerRouter: string;
      uniswapV3Taker: string;
    };
  };
  finalKick?: { auction?: { kickTime?: string; neutralPrice?: string } };
}

export interface ConfigArtifact {
  // Presence sentinel — the smoke ran. The orchestrator checks this separately
  // from the 13 computed booleans below.
  enabled: true;
  // A structurally-malformed config is rejected by assertIsValidConfig.
  malformedConfigRejected: boolean;
  // The fixture-derived config passes assertIsValidConfig.
  validConfigLoaded: boolean;
  // The resolved take settings pass validateTakeSettings (via the target).
  configValidationPassed: boolean;
  // validateAutoDiscoverConfig accepts the discovery block.
  autoDiscoverValidationPassed: boolean;
  // Route-deployment preflight reconciles the configured takers on-chain.
  routeDeploymentPreflightPassed: boolean;
  // Subgraph<->RPC chain-consistency preflight passes against the fixture stub.
  chainConsistencyPreflightPassed: boolean;
  // A discovered take target is built from the config + candidate input.
  discoveredTargetBuiltFromConfig: boolean;
  // The built target matches the fixture pool address.
  expectedTargetFound: boolean;
  // getDiscoveryExecutionConfig surfaces the configured taker contracts.
  executionConfigReturnedTakerContracts: boolean;
  // The direct-DEX taker resolves through the execution-config values.
  manualDirectDexResolvedThroughExecutionConfig: boolean;
  // ensurePoolLoaded skips (returns undefined for) a non-pool deployment.
  wrongDeploymentPoolSkipped: boolean;
  // The failed hydration records a forward-dated cooldown.
  hydrationCooldownRecorded: boolean;
  // A repeat hydration within the cooldown short-circuits (timestamp unchanged).
  hydrationCooldownPreventedRepeat: boolean;
}

const UNISWAP_V3 = LiquiditySource.UNISWAPV3;

// Mirrors buildDaemonConfig (scripts/no-spend/daemon-smoke.mjs:150) — the config
// the no-spend daemon already validates and runs end-to-end.
function buildFixtureKeeperConfig(
  summary: ConfigSmokeFixtureSummary,
  rpcUrl: string
): KeeperConfig {
  const uniswap = summary.uniswapV3ExternalTake!;
  return {
    network: {
      rpcUrl,
      readRpcUrls: [rpcUrl],
      subgraph: {
        url: FIXTURE_SUBGRAPH_SENTINEL_URL,
        fallbackUrls: [`${FIXTURE_SUBGRAPH_SENTINEL_URL}/fallback`],
      },
      tokenAddresses: {
        weth: uniswap.routerConfig.wethAddress,
      },
    },
    signer: {
      // assertIsValidConfig only checks the key exists; the smoke never builds
      // a signer from config (it receives ajna/provider from the harness).
      keystore: 'fixture-config-smoke-unused',
    },
    runtime: {
      logLevel: 'debug',
      delayBetweenRuns: 1,
      dryRun: true,
    },
    ajna: BASE_AJNA_CONFIG as KeeperConfig['ajna'],
    manual: {
      pools: [],
    },
    discovery: {
      enabled: true,
      dryRunNewPools: false,
      hydrateCooldownSec: 30,
      logSkips: true,
      allowPools: [summary.pool.address],
      denyPools: [],
      defaults: {
        take: {
          minCollateral: 0.01,
          liquiditySource: UNISWAP_V3,
          marketPriceFactor: 0.98,
        },
      },
      take: {
        enabled: true,
        allowedExternalTakePaths: ['direct_dex'],
        defaultDirectDexLiquiditySource: UNISWAP_V3,
        allowedLiquiditySources: [UNISWAP_V3],
        externalTakeRouteSelectionMode: 'maximize_profit',
        hybridGasQuoteFailureFallbackMode: 'disabled',
        maxGasCostNative: 1,
        validateRouteDeployments: true,
      },
    },
    dex: {
      oneInch: {
        routers: {
          8453: BASE_ONEINCH_ROUTER,
        },
      },
      uniswapV3: {
        router: uniswap.routerConfig,
      },
    },
    takers: {
      router: uniswap.deployment.keeperTakerRouter,
      contracts: {
        UniswapV3: uniswap.deployment.uniswapV3Taker,
      },
    },
  } as KeeperConfig;
}

// Deterministic candidate row mirroring the fixture subgraph reader's chainwide
// shape (scripts/no-spend/fixture-subgraph.ts), built from summary fields so the
// smoke does not depend on live on-chain auction state at the moment it runs.
function buildFixtureCandidateInput(
  summary: ConfigSmokeFixtureSummary
): ChainwideLiquidationAuction[] {
  const debt = summary.borrower.debt ?? '1';
  const collateral = summary.borrower.collateral ?? '1';
  const poolId = summary.pool.address.toLowerCase();
  return [
    {
      id: `${poolId}-${summary.borrower.owner.toLowerCase()}`,
      borrower: summary.borrower.owner,
      kickTime: summary.finalKick?.auction?.kickTime ?? '0',
      debtRemaining: debt,
      collateralRemaining: collateral,
      neutralPrice:
        summary.finalKick?.auction?.neutralPrice ?? summary.borrower.neutralPrice,
      debt,
      collateral,
      pool: { id: poolId },
    } as ChainwideLiquidationAuction,
  ];
}

export async function runConfigLoadedDiscoverySmoke(params: {
  ajna: AjnaSDK;
  provider: ethers.providers.JsonRpcProvider;
  pool: FungiblePool;
  summary: ConfigSmokeFixtureSummary;
  dryRun: boolean;
}): Promise<{ artifact: ConfigArtifact; target: ResolvedTakeTarget }> {
  const { ajna, provider, pool, summary } = params;
  const uniswap = summary.uniswapV3ExternalTake!;
  const rpcUrl = summary.rpcUrl;
  const chainId = (await provider.getNetwork()).chainId;

  // (1) malformedConfigRejected — assertIsValidConfig throws on a config that
  // is missing required top-level keys.
  let malformedConfigRejected = false;
  try {
    assertIsValidConfig({} as Partial<KeeperConfig>);
  } catch {
    malformedConfigRejected = true;
  }

  // (2) validConfigLoaded — the fixture-derived config passes the same check.
  const config = buildFixtureKeeperConfig(summary, rpcUrl);
  let validConfigLoaded = false;
  try {
    assertIsValidConfig(config);
    validConfigLoaded = true;
  } catch {
    validConfigLoaded = false;
  }

  // (4) autoDiscoverValidationPassed — discovery block validates and the take
  // policy resolves enabled.
  let autoDiscoverValidationPassed = false;
  try {
    validateAutoDiscoverConfig(config, chainId);
    autoDiscoverValidationPassed =
      getAutoDiscoverTakePolicy(config.discovery)?.enabled === true;
  } catch {
    autoDiscoverValidationPassed = false;
  }

  // (5) routeDeploymentPreflightPassed — the configured takers reconcile
  // against their on-chain deployment/allowlist.
  let routeDeploymentPreflightPassed = false;
  try {
    const preflight = resolveExternalTakeRouteDeploymentPreflight(config);
    if (preflight.shouldValidate) {
      await validateExternalTakeRouteDeployments({
        config,
        provider,
        chainId,
        requirements: preflight.requirements,
      });
      routeDeploymentPreflightPassed = true;
    }
  } catch {
    routeDeploymentPreflightPassed = false;
  }

  // (6) chainConsistencyPreflightPassed — the fixture subgraph stub reports the
  // RPC's latest block (provider passed), so skew is ~0.
  let chainConsistencyPreflightPassed = false;
  try {
    const subgraph = makeFixtureSubgraphReader(
      pool,
      summary.borrower.owner,
      provider
    );
    await assertSubgraphChainConsistency({ subgraph, provider, chainId });
    chainConsistencyPreflightPassed = true;
  } catch {
    chainConsistencyPreflightPassed = false;
  }

  // (7/8) discoveredTargetBuiltFromConfig / expectedTargetFound — build the
  // discovered targets from the config + a deterministic candidate row.
  const candidateInput = buildFixtureCandidateInput(summary);
  const targets = await buildDiscoveredTakeTargets(config, candidateInput);
  const discoveredTargetBuiltFromConfig = targets.length > 0;
  const target = targets.find(
    (t) => normalizeAddress(t.poolAddress) === normalizeAddress(summary.pool.address)
  );
  const expectedTargetFound = !!target;

  // (3) configValidationPassed — the built target's take settings validate.
  let configValidationPassed = false;
  if (target) {
    try {
      validateResolvedTakeTarget(target, config);
      configValidationPassed = true;
    } catch {
      configValidationPassed = false;
    }
  }

  // (9) executionConfigReturnedTakerContracts — the execution config surfaces
  // the configured router + UniswapV3 taker.
  const exec = getDiscoveryExecutionConfig(config);
  const executionConfigReturnedTakerContracts =
    !!exec.keeperTakerRouter &&
    normalizeAddress(exec.keeperTakerRouter) ===
      normalizeAddress(uniswap.deployment.keeperTakerRouter) &&
    !!exec.takerContracts?.UniswapV3 &&
    normalizeAddress(exec.takerContracts.UniswapV3) ===
      normalizeAddress(uniswap.deployment.uniswapV3Taker);

  // (10) manualDirectDexResolvedThroughExecutionConfig — the direct-DEX taker
  // resolves through the values getDiscoveryExecutionConfig returned.
  const resolution = resolveExternalTakeDeployment({
    liquiditySource: UNISWAP_V3,
    config: {
      keeperTakerRouter: exec.keeperTakerRouter,
      takerContracts: exec.takerContracts,
    },
  });
  const manualDirectDexResolvedThroughExecutionConfig =
    resolution.deploymentType === 'direct_dex' &&
    normalizeAddress(resolution.resolvedTakerAddress) ===
      normalizeAddress(uniswap.deployment.uniswapV3Taker);

  // (11/12/13) hydration cooldown mechanics — a deployed-but-non-pool address
  // (the router) fails to hydrate, records a forward cooldown, and a repeat
  // call within the cooldown short-circuits without advancing the timestamp.
  const badAddress = uniswap.deployment.keeperTakerRouter as Address;
  const poolMap: PoolMap = new Map();
  const cooldowns: PoolHydrationCooldowns = new Map();
  const firstLoad = await ensurePoolLoaded({
    ajna,
    poolMap,
    poolAddress: badAddress,
    config,
    hydrationCooldowns: cooldowns,
  });
  const cooldownKey = normalizeAddress(badAddress);
  const recordedCooldown = cooldowns.get(cooldownKey);
  const wrongDeploymentPoolSkipped = firstLoad === undefined;
  const hydrationCooldownRecorded =
    recordedCooldown !== undefined && recordedCooldown > Date.now();
  const secondLoad = await ensurePoolLoaded({
    ajna,
    poolMap,
    poolAddress: badAddress,
    config,
    hydrationCooldowns: cooldowns,
  });
  const cooldownAfterRepeat = cooldowns.get(cooldownKey);
  const hydrationCooldownPreventedRepeat =
    secondLoad === undefined && cooldownAfterRepeat === recordedCooldown;

  if (!target) {
    throw new Error(
      'config smoke: expected discovered target not found for fixture pool ' +
        summary.pool.address
    );
  }

  const artifact: ConfigArtifact = {
    enabled: true,
    malformedConfigRejected,
    validConfigLoaded,
    configValidationPassed,
    autoDiscoverValidationPassed,
    routeDeploymentPreflightPassed,
    chainConsistencyPreflightPassed,
    discoveredTargetBuiltFromConfig,
    expectedTargetFound,
    executionConfigReturnedTakerContracts,
    manualDirectDexResolvedThroughExecutionConfig,
    wrongDeploymentPoolSkipped,
    hydrationCooldownRecorded,
    hydrationCooldownPreventedRepeat,
  };

  return { artifact, target };
}
