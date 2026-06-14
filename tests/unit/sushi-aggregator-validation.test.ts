// Sushi aggregator provider tests: fail-closed route validation,
// scoped-allowlist policy validation, and reviewed scope constants.
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import {
  assertValidSushiAggregatorDexConfig,
  normalizeSushiAggregatorChainPolicy,
} from '../../src/config/sushi-aggregator-policy';
import { SushiAggregatorDexConfig } from '../../src/config';
import {
  SUSHI_AGGREGATOR_PROVEN_SELECTOR,
  SUSHI_AGGREGATOR_PROVEN_SPENDER,
  SUSHI_AGGREGATOR_PROVEN_TARGET,
  SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
  SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS,
  SUSHI_AGGREGATOR_SCOPED_PAIRS,
  SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
} from '../../src/dex/sushi-aggregator/scope';
import { validateSushiAggregatorQuote } from '../../src/dex/sushi-aggregator/validate-route';

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'tests',
  'fixtures',
  'sushi-aggregator',
  'base-weth-usdc.json'
);

const BASE_CHAIN_ID = 8453;
const TAKER = '0x000000000000000000000000000000000000dead';

interface RecordedFixture {
  request: {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    maxSlippage: number;
    sender: string;
  };
  response: Record<string, unknown>;
}

function loadFixture(): RecordedFixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function scopedConfig(): SushiAggregatorDexConfig {
  return {
    mode: 'production',
    callTargetAllowlist: SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST,
    approvalSpenderAllowlist: SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
    selectorAllowlist: SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
  };
}

function validateFixture(params: {
  response?: Record<string, unknown>;
  chainPolicyChainId?: number;
  takerAddress?: string;
  maxPriceImpact?: number;
}) {
  const fixture = loadFixture();
  return validateSushiAggregatorQuote({
    quote: params.response ?? fixture.response,
    chainId: BASE_CHAIN_ID,
    fromToken: fixture.request.tokenIn,
    toToken: fixture.request.tokenOut,
    fromAmount: BigNumber.from(fixture.request.amountIn),
    takerAddress: params.takerAddress ?? fixture.request.sender,
    maxSlippage: fixture.request.maxSlippage,
    maxPriceImpact: params.maxPriceImpact ?? 0.05,
    chainPolicy: normalizeSushiAggregatorChainPolicy({
      config: scopedConfig(),
      fieldName: 'test.dex.sushiAggregator',
      chainId: params.chainPolicyChainId ?? BASE_CHAIN_ID,
    }),
    quotedAtMs: Date.now(),
  });
}

function mutateResponse(
  mutate: (response: Record<string, unknown>) => void
): Record<string, unknown> {
  const response = JSON.parse(
    JSON.stringify(loadFixture().response)
  ) as Record<string, unknown>;
  mutate(response);
  return response;
}

function headWordReplaced(
  data: string,
  index: number,
  word: string
): string {
  const start = 10 + index * 64;
  return data.slice(0, start) + word + data.slice(start + 64);
}

function addressWord(address: string): string {
  let hex = address.slice(2).toLowerCase();
  while (hex.length < 64) {
    hex = '0' + hex;
  }
  return hex;
}

describe('Sushi aggregator route validation (Packet 3B)', () => {
  it('normalizes the recorded Base fixture into the shared quote', () => {
    const normalized = validateFixture({ takerAddress: TAKER });
    expect(normalized.providerId).to.equal('sushi_aggregator');
    expect(normalized.transactionTarget).to.equal(
      SUSHI_AGGREGATOR_PROVEN_TARGET
    );
    expect(normalized.approvalSpender).to.equal(
      SUSHI_AGGREGATOR_PROVEN_SPENDER
    );
    expect(normalized.selector).to.equal(SUSHI_AGGREGATOR_PROVEN_SELECTOR);
    expect(normalized.txValue).to.equal('0');
    expect(normalized.chainId).to.equal(BASE_CHAIN_ID);
    expect(normalized.routeMinOutRaw.gt(0)).to.equal(true);
    expect(
      normalized.routeMinOutRaw.lte(normalized.quoteAmountRaw)
    ).to.equal(true);
  });

  it('rejects a response routed for the wrong chain policy', () => {
    expect(() =>
      validateFixture({ takerAddress: TAKER, chainPolicyChainId: 1 })
    ).to.throw('does not match keeper chain');
  });

  it('rejects an unallowlisted call target', () => {
    const response = mutateResponse(r => {
      (r.tx as Record<string, unknown>).to =
        '0x1111111111111111111111111111111111111111';
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'not in the chain call-target allowlist'
    );
  });

  it('rejects an unallowlisted selector', () => {
    const response = mutateResponse(r => {
      const tx = r.tx as Record<string, unknown>;
      tx.data = '0xdeadbeef' + (tx.data as string).slice(10);
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'no proven head layout'
    );
  });

  it('rejects a recipient that is not the taker contract', () => {
    expect(() =>
      validateFixture({
        takerAddress: '0x2222222222222222222222222222222222222222',
      })
    ).to.throw('is not the taker contract');
  });

  it('rejects a rewritten output token', () => {
    const response = mutateResponse(r => {
      const tx = r.tx as Record<string, unknown>;
      tx.data = headWordReplaced(
        tx.data as string,
        3,
        addressWord('0x3333333333333333333333333333333333333333')
      );
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'does not match pool quote token'
    );
  });

  it('rejects a non-zero tx.value for ERC20 collateral routes', () => {
    const response = mutateResponse(r => {
      (r.tx as Record<string, unknown>).value = '1';
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'non-zero for an ERC20 collateral route'
    );
  });

  it('rejects price impact above the configured maximum', () => {
    const response = mutateResponse(r => {
      r.priceImpact = -0.2;
    });
    expect(() =>
      validateFixture({ response, takerAddress: TAKER, maxPriceImpact: 0.05 })
    ).to.throw('exceeds configured maximum');
  });

  it('rejects a minimum output below the slippage band', () => {
    const response = mutateResponse(r => {
      const tx = r.tx as Record<string, unknown>;
      const assumed = BigNumber.from(r.assumedAmountOut as string);
      let hex = assumed.div(2).toHexString().slice(2);
      while (hex.length < 64) {
        hex = '0' + hex;
      }
      tx.data = headWordReplaced(tx.data as string, 4, hex);
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'below the slippage floor'
    );
  });

  it('rejects non-Success provider status', () => {
    const response = mutateResponse(r => {
      r.status = 'NoWay';
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'not Success'
    );
  });
});

describe('Sushi aggregator config policy (Packet 3B)', () => {
  it('accepts the reviewed scoped production config', () => {
    expect(() =>
      assertValidSushiAggregatorDexConfig({
        config: scopedConfig(),
        fieldName: 'KeeperConfig.dex.sushiAggregator',
      })
    ).to.not.throw();
  });

  it('rejects a missing config when the provider is enabled', () => {
    expect(() =>
      assertValidSushiAggregatorDexConfig({
        config: undefined,
        fieldName: 'KeeperConfig.dex.sushiAggregator',
      })
    ).to.throw('required when the Sushi aggregator provider is enabled');
  });

  it('rejects non-production mode', () => {
    expect(() =>
      assertValidSushiAggregatorDexConfig({
        config: { ...scopedConfig(), mode: 'canary' as never },
        fieldName: 'KeeperConfig.dex.sushiAggregator',
      })
    ).to.throw("mode must be 'production'");
  });

  it('rejects a chain without configured allowlists', () => {
    expect(() =>
      assertValidSushiAggregatorDexConfig({
        config: scopedConfig(),
        fieldName: 'KeeperConfig.dex.sushiAggregator',
        chainId: 43111,
      })
    ).to.throw('callTargetAllowlist[43111]');
  });
});

describe('Sushi aggregator reviewed scope constants', () => {
  it('keeps the reviewed chain and pair scope explicit', () => {
    expect(SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS).to.deep.equal([
      1, 8453, 42161, 10, 137, 43114,
    ]);
    expect(SUSHI_AGGREGATOR_SCOPED_PAIRS).to.deep.equal([
      'WETH/USDC',
      'WAVAX/USDC',
    ]);
  });

  it('uses exactly the reviewed target, selector, and spender per scoped chain', () => {
    for (const chainKey of Object.keys(
      SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST
    )) {
      const chainId = Number(chainKey);
      expect(SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS).to.include(chainId);
      for (const target of SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST[
        chainId
      ]) {
        expect(target).to.equal(SUSHI_AGGREGATOR_PROVEN_TARGET);
      }
      expect(
        SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST[chainId]
      ).to.deep.equal([SUSHI_AGGREGATOR_PROVEN_SPENDER]);
      expect(
        SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST[chainId][
          SUSHI_AGGREGATOR_PROVEN_TARGET
        ]
      ).to.deep.equal([SUSHI_AGGREGATOR_PROVEN_SELECTOR]);
    }
  });

  it('does not configure allowlist entries outside the reviewed chains', () => {
    const scoped = SUSHI_AGGREGATOR_SCOPED_CHAIN_IDS.map(String).sort();
    expect(
      Object.keys(SUSHI_AGGREGATOR_SCOPED_CALL_TARGET_ALLOWLIST).sort()
    ).to.deep.equal(scoped);
    expect(
      Object.keys(SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST).sort()
    ).to.deep.equal(scoped);
    expect(
      Object.keys(SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST).sort()
    ).to.deep.equal(scoped);
  });
});
