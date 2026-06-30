import { expect } from 'chai';
import {
  requirePositive,
  requireOptionalPositiveInteger,
  requireOptionalNonNegative,
  requireOptionalBoolean,
  validateDecimalStringBigInt,
  parseLiquiditySourceKey,
  isPrivateOrRelayTakeWriteMode,
  getConfiguredTakeWriteMode,
  validateExternalTakeTransportPolicy,
  validateExternalTakeRouteSelectionMode,
  validateHybridGasQuoteFailureFallbackMode,
  validateOneInchAggregationExecutorAllowlist,
  validatePostAuctionDex,
  validateTakeWriteConfig,
  validateKickSettings,
  validateSettlementSettings,
  validateRouterFeeTiers,
  validateTakeSettings,
} from '../../src/config/validation-rules';
import {
  KeeperConfig,
  LiquiditySource,
  PostAuctionDex,
  TakeWriteTransportMode,
} from '../../src/config';
import { baseAutoDiscoverConfig } from './auto-discover-validation-helpers';

// Direct branch coverage for the config-validation guards. These fail-closed
// throws gate live actions (which DEX/router/taker a swap or take uses, where
// take txs submit, kick reward margins) and are never reached by integration
// tests, which run valid configs — so every reject branch here is otherwise
// uncovered. Each case triggers one guard; the happy path covers the pass side.
const ADDR = '0x1234567890123456789012345678901234567890';
const ADDR2 = '0x4200000000000000000000000000000000000006';
const cfg = (partial: unknown): KeeperConfig => partial as KeeperConfig;

describe('validation-rules: primitive validators', () => {
  describe('requirePositive', () => {
    it('throws for undefined, non-finite, zero, and negative', () => {
      for (const v of [undefined, NaN, Infinity, 'x', 0, -1]) {
        expect(() => requirePositive(v, 'bad')).to.throw('bad');
      }
    });
    it('passes for a positive finite number', () => {
      expect(() => requirePositive(0.5, 'bad')).to.not.throw();
    });
  });

  describe('requireOptionalPositiveInteger', () => {
    it('passes for undefined', () => {
      expect(() => requireOptionalPositiveInteger(undefined, 'm')).to.not.throw();
    });
    it('throws for non-integer, zero, negative, and non-number', () => {
      for (const v of [1.5, 0, -2, '3']) {
        expect(() => requireOptionalPositiveInteger(v, 'm')).to.throw('m');
      }
    });
    it('passes for a positive integer', () => {
      expect(() => requireOptionalPositiveInteger(4, 'm')).to.not.throw();
    });
  });

  describe('requireOptionalNonNegative', () => {
    it('passes for undefined and zero', () => {
      expect(() => requireOptionalNonNegative(undefined, 'm')).to.not.throw();
      expect(() => requireOptionalNonNegative(0, 'm')).to.not.throw();
    });
    it('throws for negative and non-finite', () => {
      expect(() => requireOptionalNonNegative(-1, 'm')).to.throw('m');
      expect(() => requireOptionalNonNegative(NaN, 'm')).to.throw('m');
    });
  });

  describe('requireOptionalBoolean', () => {
    it('passes for undefined and booleans', () => {
      expect(() => requireOptionalBoolean(undefined, 'm')).to.not.throw();
      expect(() => requireOptionalBoolean(true, 'm')).to.not.throw();
      expect(() => requireOptionalBoolean(false, 'm')).to.not.throw();
    });
    it('throws for non-boolean defined values', () => {
      expect(() => requireOptionalBoolean(1, 'm')).to.throw('m');
      expect(() => requireOptionalBoolean('true', 'm')).to.throw('m');
    });
  });

  describe('validateDecimalStringBigInt', () => {
    it('throws for non-strings and non-canonical decimals', () => {
      for (const v of [123, '', '-1', '1.5', '01', 'abc']) {
        expect(() => validateDecimalStringBigInt(v, 'f')).to.throw('f');
      }
    });
    it('passes for canonical non-negative decimal strings', () => {
      expect(() => validateDecimalStringBigInt('0', 'f')).to.not.throw();
      expect(() => validateDecimalStringBigInt('1230', 'f')).to.not.throw();
    });
  });

  describe('parseLiquiditySourceKey', () => {
    it('returns the enum value for a valid numeric key', () => {
      expect(parseLiquiditySourceKey(String(LiquiditySource.ONEINCH))).to.equal(
        LiquiditySource.ONEINCH
      );
    });
    it('returns undefined for non-integer, and out-of-range keys', () => {
      expect(parseLiquiditySourceKey('abc')).to.equal(undefined);
      expect(parseLiquiditySourceKey('1.5')).to.equal(undefined);
      expect(parseLiquiditySourceKey('99999')).to.equal(undefined);
    });
  });

  describe('take-write mode helpers', () => {
    it('isPrivateOrRelayTakeWriteMode is true only for private_rpc / relay', () => {
      expect(isPrivateOrRelayTakeWriteMode(TakeWriteTransportMode.PRIVATE_RPC)).to.equal(true);
      expect(isPrivateOrRelayTakeWriteMode(TakeWriteTransportMode.RELAY)).to.equal(true);
      expect(isPrivateOrRelayTakeWriteMode(TakeWriteTransportMode.PUBLIC_RPC)).to.equal(false);
      expect(isPrivateOrRelayTakeWriteMode(undefined)).to.equal(false);
    });
    it('getConfiguredTakeWriteMode returns the configured mode or undefined', () => {
      expect(
        getConfiguredTakeWriteMode(
          cfg({ writes: { take: { mode: TakeWriteTransportMode.RELAY } } })
        )
      ).to.equal(TakeWriteTransportMode.RELAY);
      expect(getConfiguredTakeWriteMode(cfg({ writes: {} }))).to.equal(undefined);
    });
  });

  describe('enum-mode validators (pass undefined + valid, throw on bad)', () => {
    it('validateExternalTakeTransportPolicy', () => {
      expect(() => validateExternalTakeTransportPolicy(undefined)).to.not.throw();
      expect(() => validateExternalTakeTransportPolicy('allow_public' as any)).to.not.throw();
      expect(() => validateExternalTakeTransportPolicy('nope' as any)).to.throw(/externalTakeTransportPolicy/);
    });
    it('validateExternalTakeRouteSelectionMode', () => {
      expect(() => validateExternalTakeRouteSelectionMode(undefined)).to.not.throw();
      expect(() => validateExternalTakeRouteSelectionMode('maximize_profit' as any)).to.not.throw();
      expect(() => validateExternalTakeRouteSelectionMode('nope' as any)).to.throw(/externalTakeRouteSelectionMode/);
    });
    it('validateHybridGasQuoteFailureFallbackMode', () => {
      expect(() => validateHybridGasQuoteFailureFallbackMode(undefined)).to.not.throw();
      expect(() => validateHybridGasQuoteFailureFallbackMode('disabled' as any)).to.not.throw();
      expect(() => validateHybridGasQuoteFailureFallbackMode('nope' as any)).to.throw(/hybridGasQuoteFailureFallbackMode/);
    });
  });
});

describe('validation-rules: validatePostAuctionDex', () => {
  it('ONEINCH requires dex.oneInch.routers', () => {
    expect(() => validatePostAuctionDex(PostAuctionDex.ONEINCH, cfg({ dex: { oneInch: {} } }))).to.throw(/oneInch\.routers/);
    expect(() => validatePostAuctionDex(PostAuctionDex.ONEINCH, cfg({ dex: { oneInch: { routers: { 1: ADDR } } } }))).to.not.throw();
  });

  it('UNISWAP_V3 requires universalRouter and a QuoterV2 address (from either location)', () => {
    expect(() => validatePostAuctionDex(PostAuctionDex.UNISWAP_V3, cfg({ dex: { uniswapV3: {} } }))).to.throw(/universalRouter/);
    // universalRouter present but no quoterV2 anywhere -> fails closed
    expect(() =>
      validatePostAuctionDex(PostAuctionDex.UNISWAP_V3, cfg({ dex: { uniswapV3: { universalRouter: {} } } }))
    ).to.throw(/QuoterV2 address/);
    // quoterV2 on universalRouter -> ok
    expect(() =>
      validatePostAuctionDex(
        PostAuctionDex.UNISWAP_V3,
        cfg({ dex: { uniswapV3: { universalRouter: { quoterV2Address: ADDR } } } })
      )
    ).to.not.throw();
    // quoterV2 on router fallback location -> ok
    expect(() =>
      validatePostAuctionDex(
        PostAuctionDex.UNISWAP_V3,
        cfg({ dex: { uniswapV3: { universalRouter: {}, router: { quoterV2Address: ADDR } } } })
      )
    ).to.not.throw();
  });

  it('CURVE requires dex.curve; unsupported provider throws', () => {
    expect(() => validatePostAuctionDex(PostAuctionDex.CURVE, cfg({ dex: {} }))).to.throw(/dex\.curve/);
    expect(() => validatePostAuctionDex(PostAuctionDex.CURVE, cfg({ dex: { curve: {} } }))).to.not.throw();
    expect(() => validatePostAuctionDex('bogus' as unknown as PostAuctionDex, cfg({ dex: {} }))).to.throw(/Unsupported PostAuctionDex/);
  });
});

describe('validation-rules: validateTakeWriteConfig', () => {
  it('returns early when no writes.take is configured', () => {
    expect(() => validateTakeWriteConfig(cfg({ writes: {} }))).to.not.throw();
  });

  it('PUBLIC_RPC rejects a non-positive receiptTimeoutMs', () => {
    expect(() =>
      validateTakeWriteConfig(cfg({ writes: { take: { mode: TakeWriteTransportMode.PUBLIC_RPC, receiptTimeoutMs: 0 } } }))
    ).to.throw(/receiptTimeoutMs/);
    expect(() =>
      validateTakeWriteConfig(cfg({ writes: { take: { mode: TakeWriteTransportMode.PUBLIC_RPC, receiptTimeoutMs: 5000 } } }))
    ).to.not.throw();
  });

  it('PRIVATE_RPC requires rpcUrl', () => {
    expect(() =>
      validateTakeWriteConfig(cfg({ writes: { take: { mode: TakeWriteTransportMode.PRIVATE_RPC } } }))
    ).to.throw(/rpcUrl required when mode is private_rpc/);
    expect(() =>
      validateTakeWriteConfig(cfg({ writes: { take: { mode: TakeWriteTransportMode.PRIVATE_RPC, rpcUrl: 'https://x' } } }))
    ).to.not.throw();
  });

  it('RELAY requires relay.url and rejects bad relay timeouts', () => {
    expect(() =>
      validateTakeWriteConfig(cfg({ writes: { take: { mode: TakeWriteTransportMode.RELAY, relay: {} } } }))
    ).to.throw(/relay\.url required when mode is relay/);
    expect(() =>
      validateTakeWriteConfig(
        cfg({ writes: { take: { mode: TakeWriteTransportMode.RELAY, relay: { url: 'https://r', maxBlockNumberOffset: 0 } } } })
      )
    ).to.throw(/maxBlockNumberOffset/);
    expect(() =>
      validateTakeWriteConfig(
        cfg({ writes: { take: { mode: TakeWriteTransportMode.RELAY, relay: { url: 'https://r' } } } })
      )
    ).to.not.throw();
  });

  it('rejects an unsupported mode', () => {
    expect(() =>
      validateTakeWriteConfig(cfg({ writes: { take: { mode: 'carrier-pigeon' } } }))
    ).to.throw(/unsupported mode/);
  });
});

describe('validation-rules: validateOneInchAggregationExecutorAllowlist', () => {
  const wrap = (allowlist: unknown) => cfg({ dex: { oneInch: { aggregationExecutorAllowlist: allowlist } } });
  it('passes when undefined', () => {
    expect(() => validateOneInchAggregationExecutorAllowlist(cfg({ dex: { oneInch: {} } }))).to.not.throw();
  });
  it('rejects non-object / array allowlists', () => {
    expect(() => validateOneInchAggregationExecutorAllowlist(wrap([]))).to.throw(/keyed by chainId/);
    expect(() => validateOneInchAggregationExecutorAllowlist(wrap(null))).to.throw(/keyed by chainId/);
  });
  it('rejects non-canonical chainId keys and empty executor arrays', () => {
    expect(() => validateOneInchAggregationExecutorAllowlist(wrap({ '01': [ADDR] }))).to.throw(/canonical positive integer chain ID/);
    expect(() => validateOneInchAggregationExecutorAllowlist(wrap({ '8453': [] }))).to.throw(/non-empty address arrays/);
  });
  it('rejects invalid and duplicate executor addresses', () => {
    expect(() => validateOneInchAggregationExecutorAllowlist(wrap({ '8453': ['not-an-address'] }))).to.throw(/invalid address/);
    expect(() => validateOneInchAggregationExecutorAllowlist(wrap({ '8453': [ADDR, ADDR] }))).to.throw(/duplicate addresses/);
  });
  it('passes for a canonical, deduped allowlist', () => {
    expect(() => validateOneInchAggregationExecutorAllowlist(wrap({ '8453': [ADDR, ADDR2] }))).to.not.throw();
  });
});

describe('validation-rules: validateKickSettings', () => {
  it('passes for undefined and for explicitly disabled kick', () => {
    expect(() => validateKickSettings(undefined, 'k')).to.not.throw();
    expect(() => validateKickSettings({ enabled: false }, 'k')).to.not.throw();
  });
  it('rejects non-objects and a non-boolean enabled', () => {
    expect(() => validateKickSettings(42, 'k')).to.throw(/must be an object/);
    expect(() => validateKickSettings({ enabled: 'yes' }, 'k')).to.throw(/explicitly true or false/);
  });
  it('when enabled, requires non-negative minDebt and a priceFactor in (0,1)', () => {
    expect(() => validateKickSettings({ enabled: true, minDebt: -1, priceFactor: 0.9 }, 'k')).to.throw(/minDebt/);
    expect(() => validateKickSettings({ enabled: true, minDebt: 100, priceFactor: 0 }, 'k')).to.throw(/priceFactor must be a positive/);
    expect(() => validateKickSettings({ enabled: true, minDebt: 100, priceFactor: 1 }, 'k')).to.throw(/less than 1/);
    expect(() => validateKickSettings({ enabled: true, minDebt: 100, priceFactor: 0.9 }, 'k')).to.not.throw();
  });
});

describe('validation-rules: validateSettlementSettings', () => {
  it('requires enabled=true', () => {
    expect(() => validateSettlementSettings({ enabled: false } as any)).to.throw(/enabled must be true/);
  });
  it('rejects negative minAuctionAge and non-positive bounds', () => {
    expect(() => validateSettlementSettings({ enabled: true, minAuctionAge: -1 } as any)).to.throw(/minAuctionAge/);
    expect(() => validateSettlementSettings({ enabled: true, maxBucketDepth: 0 } as any)).to.throw(/maxBucketDepth/);
    expect(() => validateSettlementSettings({ enabled: true, maxIterations: -3 } as any)).to.throw(/maxIterations/);
  });
  it('passes for a valid settlement config', () => {
    expect(() => validateSettlementSettings({ enabled: true, minAuctionAge: 0, maxBucketDepth: 5, maxIterations: 10 } as any)).to.not.throw();
  });
});

describe('validation-rules: validateRouterFeeTiers', () => {
  it('rejects an out-of-range oneInch slippage', () => {
    expect(() => validateRouterFeeTiers(cfg({ dex: { oneInch: { defaultSlippage: 150 } } }))).to.throw(/defaultSlippage/);
  });
  it('rejects an out-of-range curve executionDelayMs', () => {
    expect(() => validateRouterFeeTiers(cfg({ dex: { curve: { executionDelayMs: 10_000_000 } } }))).to.throw(/executionDelayMs/);
  });
  it('rejects bad candidateFeeTiers (empty, too many, invalid, duplicate)', () => {
    const u = (router: unknown) => cfg({ dex: { uniswapV3: { router } } });
    expect(() => validateRouterFeeTiers(u({ candidateFeeTiers: [] }))).to.throw(/non-empty array/);
    expect(() => validateRouterFeeTiers(u({ candidateFeeTiers: [100, 200, 300, 400, 500, 600, 700, 800, 900] }))).to.throw(/more than/);
    expect(() => validateRouterFeeTiers(u({ candidateFeeTiers: [-1] }))).to.throw(/uint24 fee tiers/);
    expect(() => validateRouterFeeTiers(u({ candidateFeeTiers: [3000, 3000] }))).to.throw(/duplicates/);
  });
  it('rejects a bad universalRouter defaultFeeTier', () => {
    expect(() => validateRouterFeeTiers(cfg({ dex: { uniswapV3: { universalRouter: { defaultFeeTier: -5 } } } }))).to.throw(/defaultFeeTier/);
  });
  it('passes for a valid fee-tier config (standard tiers)', () => {
    expect(() => validateRouterFeeTiers(cfg({ dex: { uniswapV3: { router: { candidateFeeTiers: [500, 3000], defaultFeeTier: 3000 } } } }))).to.not.throw();
  });
});

describe('validation-rules: validateTakeSettings (external-source + arbTake guards)', () => {
  const base = () => baseAutoDiscoverConfig();
  const uniTake = () => ({ liquiditySource: LiquiditySource.UNISWAPV3, marketPriceFactor: 0.99 }) as any;

  it('throws when neither arbTake nor external take is configured', () => {
    expect(() => validateTakeSettings({} as any, base())).to.throw(/Must configure arbTake/);
  });

  it('rejects NONE and non-external liquidity sources', () => {
    expect(() => validateTakeSettings({ liquiditySource: LiquiditySource.NONE, marketPriceFactor: 0.99 } as any, base())).to.throw(/cannot be NONE/);
  });

  it('enforces marketPriceFactor positivity and upper bound', () => {
    expect(() => validateTakeSettings({ liquiditySource: LiquiditySource.UNISWAPV3, marketPriceFactor: 0 } as any, base())).to.throw(/marketPriceFactor must be positive/);
    expect(() => validateTakeSettings({ liquiditySource: LiquiditySource.UNISWAPV3, marketPriceFactor: 3 } as any, base())).to.throw(/unreasonable/);
  });

  it('rejects a non-boolean allowSubsidy', () => {
    expect(() => validateTakeSettings({ ...uniTake(), allowSubsidy: 'yes' } as any, base())).to.throw(/allowSubsidy must be a boolean/);
  });

  it('requireRegisteredTakerContract: missing/invalid router and taker contract', () => {
    const noRouter = base();
    (noRouter.takers as any).router = undefined;
    expect(() => validateTakeSettings(uniTake(), noRouter)).to.throw(/takers\.router required/);

    const badRouter = base();
    (badRouter.takers as any).router = 'not-an-address';
    expect(() => validateTakeSettings(uniTake(), badRouter)).to.throw(/takers\.router must be a valid address/);

    const noTaker = base();
    delete (noTaker.takers as any).contracts.UniswapV3;
    expect(() => validateTakeSettings(uniTake(), noTaker)).to.throw(/takers\.contracts\.UniswapV3 required/);

    const badTaker = base();
    (badTaker.takers as any).contracts.UniswapV3 = 'bad';
    expect(() => validateTakeSettings(uniTake(), badTaker)).to.throw(/must be a valid address/);
  });

  it('passes for a fully configured UniswapV3 external take', () => {
    expect(() => validateTakeSettings(uniTake(), base())).to.not.throw();
  });

  it('enforces arbTake minCollateral and hpbPriceFactor positivity', () => {
    expect(() => validateTakeSettings({ minCollateral: 0, hpbPriceFactor: 0.9 } as any, base())).to.throw(/minCollateral/);
    expect(() => validateTakeSettings({ minCollateral: 0.01, hpbPriceFactor: 0 } as any, base())).to.throw(/hpbPriceFactor/);
    expect(() => validateTakeSettings({ minCollateral: 0.01, hpbPriceFactor: 0.9 } as any, base())).to.not.throw();
  });
});
