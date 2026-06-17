import { expect } from 'chai';
import {
  getSushiAggregatorProductionAllowlists,
  hasSushiAggregatorConfig,
} from '../../scripts/deployment/sushi-aggregator-deployment';
import { KeeperConfig, SushiAggregatorDexConfig } from '../../src/config';

const BASE_CHAIN_ID = 8453;
const CALL_TARGET = '0x1111111111111111111111111111111111111111';
const APPROVAL_SPENDER = '0x2222222222222222222222222222222222222222';
const SELECTOR = '0xabcdef12';

function keeperConfig(dex: KeeperConfig['dex']): KeeperConfig {
  return {
    network: {
      rpcUrl: 'http://localhost:8545',
      subgraph: { url: 'http://localhost:8000' },
    },
    signer: { keystore: '/tmp/keeper.json' },
    runtime: { logLevel: 'info', delayBetweenRuns: 60 },
    ajna: {
      erc20PoolFactory: '0x3333333333333333333333333333333333333333',
      erc721PoolFactory: '0x4444444444444444444444444444444444444444',
      poolUtils: '0x5555555555555555555555555555555555555555',
      positionManager: '0x6666666666666666666666666666666666666666',
      ajnaToken: '0x7777777777777777777777777777777777777777',
      grantFund: '',
      burnWrapper: '',
      lenderHelper: '',
    },
    manual: { pools: [] },
    dex,
  };
}

function sushiConfig(
  overrides: Partial<SushiAggregatorDexConfig> = {}
): KeeperConfig {
  return keeperConfig({
    sushiAggregator: {
      mode: 'production',
      callTargetAllowlist: { [BASE_CHAIN_ID]: [CALL_TARGET] },
      approvalSpenderAllowlist: { [BASE_CHAIN_ID]: [APPROVAL_SPENDER] },
      selectorAllowlist: { [BASE_CHAIN_ID]: { [CALL_TARGET]: [SELECTOR] } },
      ...overrides,
    },
  });
}

describe('Sushi aggregator deployment script support', () => {
  it('enables Sushi taker deployment only when dex.sushiAggregator is configured', () => {
    expect(hasSushiAggregatorConfig(sushiConfig())).to.equal(true);
    expect(hasSushiAggregatorConfig(keeperConfig({}))).to.equal(false);
  });

  it('resolves reviewed allowlists for the detected chain', () => {
    const allowlists = getSushiAggregatorProductionAllowlists(
      sushiConfig(),
      BASE_CHAIN_ID
    );

    expect(allowlists.callTargets).to.deep.equal([CALL_TARGET]);
    expect(allowlists.approvalSpenders).to.deep.equal([APPROVAL_SPENDER]);
    expect(allowlists.selectorAllowlist).to.deep.equal({
      [CALL_TARGET.toLowerCase()]: [SELECTOR],
    });
  });

  it('fails closed when config does not cover the detected chain', () => {
    expect(() =>
      getSushiAggregatorProductionAllowlists(sushiConfig(), 1)
    ).to.throw('dex.sushiAggregator.callTargetAllowlist[1]');
  });

  it('throws when no dex.sushiAggregator config is present', () => {
    expect(() =>
      getSushiAggregatorProductionAllowlists(keeperConfig({}), BASE_CHAIN_ID)
    ).to.throw('dex.sushiAggregator config is required');
  });

  it('fails closed when a selector targets an address not in the call-target allowlist', () => {
    const otherTarget = '0x9999999999999999999999999999999999999999';
    expect(() =>
      getSushiAggregatorProductionAllowlists(
        sushiConfig({
          selectorAllowlist: {
            [BASE_CHAIN_ID]: { [otherTarget]: [SELECTOR] },
          },
        }),
        BASE_CHAIN_ID
      )
    ).to.throw('is not present in callTargetAllowlist');
  });

  it('fails closed when a configured call target has no selector coverage', () => {
    const secondTarget = '0x8888888888888888888888888888888888888888';
    expect(() =>
      getSushiAggregatorProductionAllowlists(
        sushiConfig({
          callTargetAllowlist: {
            [BASE_CHAIN_ID]: [CALL_TARGET, secondTarget],
          },
          // Only CALL_TARGET has selectors; secondTarget is uncovered.
          selectorAllowlist: {
            [BASE_CHAIN_ID]: { [CALL_TARGET]: [SELECTOR] },
          },
        }),
        BASE_CHAIN_ID
      )
    ).to.throw('must include selectors for every configured call target');
  });
});
