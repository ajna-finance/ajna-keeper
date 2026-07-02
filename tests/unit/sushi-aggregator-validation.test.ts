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
import { resolveSushiAggregatorChainId } from '../../src/take/sushi-aggregator/quote-service';

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
    approvalSpenderAllowlist:
      SUSHI_AGGREGATOR_SCOPED_APPROVAL_SPENDER_ALLOWLIST,
    selectorAllowlist: SUSHI_AGGREGATOR_SCOPED_SELECTOR_ALLOWLIST,
  };
}

function validateFixture(params: {
  response?: unknown;
  chainPolicyChainId?: number;
  chainPolicy?: ReturnType<typeof normalizeSushiAggregatorChainPolicy>;
  fromAmount?: BigNumber;
  fromToken?: string;
  toToken?: string;
  takerAddress?: string;
  maxSlippage?: number;
  maxPriceImpact?: number;
}) {
  const fixture = loadFixture();
  const fromAmount =
    params.fromAmount ?? BigNumber.from(fixture.request.amountIn);
  return validateSushiAggregatorQuote({
    quote: 'response' in params ? params.response : fixture.response,
    chainId: BASE_CHAIN_ID,
    fromToken: params.fromToken ?? fixture.request.tokenIn,
    toToken: params.toToken ?? fixture.request.tokenOut,
    fromAmount,
    takerAddress: params.takerAddress ?? fixture.request.sender,
    maxSlippage: params.maxSlippage ?? fixture.request.maxSlippage,
    maxPriceImpact: params.maxPriceImpact ?? 0.05,
    chainPolicy:
      params.chainPolicy ??
      normalizeSushiAggregatorChainPolicy({
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
  const response = JSON.parse(JSON.stringify(loadFixture().response)) as Record<
    string,
    unknown
  >;
  mutate(response);
  return response;
}

function headWordReplaced(data: string, index: number, word: string): string {
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

function uintWord(value: BigNumber | number | string): string {
  let hex = BigNumber.from(value).toHexString().slice(2);
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
    expect(normalized.routeMinOutRaw.lte(normalized.quoteAmountRaw)).to.equal(
      true
    );
  });

  it('rejects a response routed for the wrong chain policy', () => {
    expect(() =>
      validateFixture({ takerAddress: TAKER, chainPolicyChainId: 1 })
    ).to.throw('does not match keeper chain');
  });

  it('rejects an unallowlisted call target', () => {
    const response = mutateResponse((r) => {
      (r.tx as Record<string, unknown>).to =
        '0x1111111111111111111111111111111111111111';
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'not in the chain call-target allowlist'
    );
  });

  it('rejects an unallowlisted selector', () => {
    const response = mutateResponse((r) => {
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
    const response = mutateResponse((r) => {
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
    const response = mutateResponse((r) => {
      (r.tx as Record<string, unknown>).value = '1';
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'non-zero for an ERC20 collateral route'
    );
  });

  it('rejects price impact above the configured maximum', () => {
    const response = mutateResponse((r) => {
      r.priceImpact = -0.2;
    });
    expect(() =>
      validateFixture({ response, takerAddress: TAKER, maxPriceImpact: 0.05 })
    ).to.throw('exceeds configured maximum');
  });

  it('rejects a minimum output below the slippage band', () => {
    const response = mutateResponse((r) => {
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
    const response = mutateResponse((r) => {
      r.status = 'NoWay';
    });
    expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
      'not Success'
    );
  });

  it('rejects a response that is not an object', () => {
    expect(() =>
      validateFixture({ response: null, takerAddress: TAKER })
    ).to.throw('response is not a JSON object');
  });

  it('rejects a non-positive requested exact-fill amount', () => {
    expect(() =>
      validateFixture({
        fromAmount: BigNumber.from(0),
        takerAddress: TAKER,
      })
    ).to.throw('requested amount is not a positive token-unit value');
  });

  it('rejects provider amount and quote output mismatches', () => {
    const amountMismatch = mutateResponse((r) => {
      r.amountIn = '1';
    });
    expect(() =>
      validateFixture({ response: amountMismatch, takerAddress: TAKER })
    ).to.throw('response amountIn "1" does not match requested');

    for (const assumedAmountOut of [undefined, 'abc', '0']) {
      const response = mutateResponse((r) => {
        r.assumedAmountOut = assumedAmountOut;
      });
      expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
        'response assumedAmountOut is missing, non-decimal, or zero'
      );
    }
  });

  it('rejects missing or non-finite price impact', () => {
    for (const priceImpact of [undefined, Number.POSITIVE_INFINITY]) {
      const response = mutateResponse((r) => {
        r.priceImpact = priceImpact;
      });
      expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
        'response priceImpact is missing or non-finite'
      );
    }
  });

  it('rejects missing or invalid transaction envelopes', () => {
    const missingTx = mutateResponse((r) => {
      delete r.tx;
    });
    expect(() =>
      validateFixture({ response: missingTx, takerAddress: TAKER })
    ).to.throw('response is missing the tx object');

    const invalidTarget = mutateResponse((r) => {
      (r.tx as Record<string, unknown>).to = 'not-address';
    });
    expect(() =>
      validateFixture({ response: invalidTarget, takerAddress: TAKER })
    ).to.throw('tx.to is not a valid execution target address');

    const nonStringTarget = mutateResponse((r) => {
      (r.tx as Record<string, unknown>).to = 1;
    });
    expect(() =>
      validateFixture({ response: nonStringTarget, takerAddress: TAKER })
    ).to.throw('tx.to is not a valid execution target address');
  });

  it('rejects an execution target that is not approved as the spender', () => {
    const chainPolicy = normalizeSushiAggregatorChainPolicy({
      config: scopedConfig(),
      fieldName: 'test.dex.sushiAggregator',
      chainId: BASE_CHAIN_ID,
    });
    expect(() =>
      validateFixture({
        chainPolicy: {
          ...chainPolicy,
          approvalSpenders: [],
        },
        takerAddress: TAKER,
      })
    ).to.throw('is not in the chain approval-spender allowlist');
  });

  it('allows absent, null, and zero-equivalent transaction values', () => {
    for (const value of [undefined, null, '0x00']) {
      const response = mutateResponse((r) => {
        if (value === undefined) {
          delete (r.tx as Record<string, unknown>).value;
        } else {
          (r.tx as Record<string, unknown>).value = value;
        }
      });
      expect(() =>
        validateFixture({ response, takerAddress: TAKER })
      ).to.not.throw();
    }
  });

  it('rejects missing, short, or malformed calldata', () => {
    for (const data of [undefined, '0x1234', '0xzzzz']) {
      const response = mutateResponse((r) => {
        (r.tx as Record<string, unknown>).data = data;
      });
      expect(() => validateFixture({ response, takerAddress: TAKER })).to.throw(
        'tx.data is missing or shorter than the proven calldata head'
      );
    }
  });

  it('rejects a selector absent from the target allowlist', () => {
    const chainPolicy = normalizeSushiAggregatorChainPolicy({
      config: scopedConfig(),
      fieldName: 'test.dex.sushiAggregator',
      chainId: BASE_CHAIN_ID,
    });
    expect(() =>
      validateFixture({
        chainPolicy: {
          ...chainPolicy,
          selectorAllowlist: {},
        },
        takerAddress: TAKER,
      })
    ).to.throw('is not allowlisted for target');
  });

  it('rejects decoded calldata that rewrites token or amount inputs', () => {
    const wrongInputToken = mutateResponse((r) => {
      const tx = r.tx as Record<string, unknown>;
      tx.data = headWordReplaced(
        tx.data as string,
        0,
        addressWord('0x6666666666666666666666666666666666666666')
      );
    });
    expect(() =>
      validateFixture({ response: wrongInputToken, takerAddress: TAKER })
    ).to.throw('does not match pool collateral');

    const wrongAmount = mutateResponse((r) => {
      const tx = r.tx as Record<string, unknown>;
      tx.data = headWordReplaced(tx.data as string, 1, uintWord(1));
    });
    expect(() =>
      validateFixture({ response: wrongAmount, takerAddress: TAKER })
    ).to.throw('does not match requested');
  });

  it('rejects decoded minimum output outside the provider quote bounds', () => {
    const zeroMinOut = mutateResponse((r) => {
      const tx = r.tx as Record<string, unknown>;
      tx.data = headWordReplaced(tx.data as string, 4, uintWord(0));
    });
    expect(() =>
      validateFixture({ response: zeroMinOut, takerAddress: TAKER })
    ).to.throw('decoded minimum output is zero');

    const aboveExpected = mutateResponse((r) => {
      const tx = r.tx as Record<string, unknown>;
      tx.data = headWordReplaced(
        tx.data as string,
        4,
        uintWord(BigNumber.from(r.assumedAmountOut as string).add(1))
      );
    });
    expect(() =>
      validateFixture({ response: aboveExpected, takerAddress: TAKER })
    ).to.throw('exceeds expected output');
  });

  it('rejects invalid slippage configuration before deriving floors', () => {
    for (const maxSlippage of [0, 1]) {
      expect(() =>
        validateFixture({ maxSlippage, takerAddress: TAKER })
      ).to.throw('maxSlippage is not a fraction in (0, 1)');
    }
  });

  it('rejects malformed or contradictory token metadata', () => {
    const malformed = mutateResponse((r) => {
      r.tokens = [];
    });
    expect(() =>
      validateFixture({ response: malformed, takerAddress: TAKER })
    ).to.throw('response token metadata is missing or malformed');

    const wrongInputMeta = mutateResponse((r) => {
      const tokens = r.tokens as Array<Record<string, unknown>>;
      const tokenFrom = r.tokenFrom as number;
      tokens[tokenFrom] = {
        ...tokens[tokenFrom],
        address: '0x7777777777777777777777777777777777777777',
      };
    });
    expect(() =>
      validateFixture({ response: wrongInputMeta, takerAddress: TAKER })
    ).to.throw('response token metadata contradicts the requested input token');

    const wrongOutputMeta = mutateResponse((r) => {
      const tokens = r.tokens as Array<Record<string, unknown>>;
      const tokenTo = r.tokenTo as number;
      tokens[tokenTo] = {
        ...tokens[tokenTo],
        address: '0x8888888888888888888888888888888888888888',
      };
    });
    expect(() =>
      validateFixture({ response: wrongOutputMeta, takerAddress: TAKER })
    ).to.throw(
      'response token metadata contradicts the requested output token'
    );
  });
});

describe('Sushi aggregator quote service', () => {
  it('rejects a configured chainId that does not match the signer chain', async () => {
    const signer = {
      getChainId: async () => BASE_CHAIN_ID,
    } as any;

    try {
      await resolveSushiAggregatorChainId({ chainId: 1 }, signer);
      throw new Error('expected chain mismatch');
    } catch (error) {
      expect((error as Error).message).to.equal(
        'configured Sushi Aggregator chainId 1 does not match signer chainId 8453'
      );
    }
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

  it('rejects empty policy and out-of-range production guardrails', () => {
    expect(() =>
      assertValidSushiAggregatorDexConfig({
        config: {
          ...scopedConfig(),
          callTargetAllowlist: {},
        },
        fieldName: 'KeeperConfig.dex.sushiAggregator',
      })
    ).to.throw('callTargetAllowlist must configure at least one chain');

    expect(() =>
      assertValidSushiAggregatorDexConfig({
        config: {
          ...scopedConfig(),
          apiBaseUrl: 'http://aggregator.sushi.com',
        },
        fieldName: 'KeeperConfig.dex.sushiAggregator',
      })
    ).to.throw('must be HTTPS in production');

    for (const config of [
      { quoteTimeoutMs: 0 },
      { maxQuoteAgeMs: 0 },
      { defaultSlippage: 0 },
      { maxPriceImpact: 0 },
    ]) {
      expect(() =>
        assertValidSushiAggregatorDexConfig({
          config: {
            ...scopedConfig(),
            ...config,
          },
          fieldName: 'KeeperConfig.dex.sushiAggregator',
        })
      ).to.throw();
    }
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
