import { expect } from 'chai';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { readConfigFile } from '../../src/config';
import { assertIsValidConfig } from '../../src/config/load';
import {
  KeeperConfig,
  PostAuctionDex,
  RewardActionLabel,
  TokenToCollect,
  validateTakeSettingsForChain,
} from '../../src/config';

const BASE_CONFIG: KeeperConfig = {
  network: {
    rpcUrl: 'https://example-rpc.invalid',
    subgraph: {
      url: 'https://example-subgraph.invalid',
    },
  },
  keeper: {
    keystore: '/tmp/keeper.json',
  },
  runtime: {
    logLevel: 'info',
    delayBetweenActions: 1,
    delayBetweenRuns: 10,
  },
  ajna: {
    erc20PoolFactory: '0x1111111111111111111111111111111111111111',
    erc721PoolFactory: '0x2222222222222222222222222222222222222222',
    poolUtils: '0x3333333333333333333333333333333333333333',
    positionManager: '0x4444444444444444444444444444444444444444',
    ajnaToken: '0x5555555555555555555555555555555555555555',
  },
  manual: {
    pools: [],
  },
};

describe('assertIsValidConfig rewards.lpLookbackSeconds', () => {
  it('accepts omission (defaults applied downstream)', () => {
    expect(() => assertIsValidConfig({ ...BASE_CONFIG })).to.not.throw();
  });

  it('accepts non-negative integers', () => {
    expect(() =>
      assertIsValidConfig({ ...BASE_CONFIG, rewards: { lpLookbackSeconds: 0 } })
    ).to.not.throw();
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { lpLookbackSeconds: 300 },
      })
    ).to.not.throw();
  });

  it('rejects negative values (would invert cursor math)', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { lpLookbackSeconds: -30 },
      })
    ).to.throw(/non-negative integer/);
  });

  it('rejects fractional values', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { lpLookbackSeconds: 0.5 },
      })
    ).to.throw(/non-negative integer/);
  });

  it('rejects string-typed values with a typeof-clarifying message', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { lpLookbackSeconds: '60' as any },
      })
    ).to.throw(/typeof string/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { lpLookbackSeconds: Number.NaN },
      })
    ).to.throw(/non-negative integer/);
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { lpLookbackSeconds: Number.POSITIVE_INFINITY },
      })
    ).to.throw(/non-negative integer/);
  });

  it('rejects values above the 1-day hard cap', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { lpLookbackSeconds: 86_401 },
      })
    ).to.throw(/must not exceed 86400/);
  });

  it('accepts the 1-day hard cap exactly', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { lpLookbackSeconds: 86_400 },
      })
    ).to.not.throw();
  });
});

describe('assertIsValidConfig defaultLpReward shape', () => {
  const validDefault = {
    redeemFirst: TokenToCollect.QUOTE,
    minAmountQuote: 0,
    minAmountCollateral: 0,
  };

  it('accepts a minimal valid defaultLpReward', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: { defaultLpReward: validDefault },
      })
    ).to.not.throw();
  });

  it('rejects negative minAmountQuote', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: { ...validDefault, minAmountQuote: -1 },
        },
      })
    ).to.throw(/minAmountQuote.*non-negative/);
  });

  it('rejects non-number minAmountCollateral', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            minAmountCollateral: '0' as any,
          },
        },
      })
    ).to.throw(/minAmountCollateral.*non-negative/);
  });
});

describe('assertIsValidConfig rewardAction shape', () => {
  const validDefault = {
    redeemFirst: TokenToCollect.QUOTE,
    minAmountQuote: 0,
    minAmountCollateral: 0,
  };
  const validExchange = {
    action: RewardActionLabel.EXCHANGE as const,
    address: '0x1234567890123456789012345678901234567890',
    targetToken: 'weth',
    slippage: 1,
    dexProvider: PostAuctionDex.UNISWAP_V3,
  };
  const validTransfer = {
    action: RewardActionLabel.TRANSFER as const,
    to: '0x1234567890123456789012345678901234567890',
  };

  it('accepts a fully-valid EXCHANGE rewardActionQuote', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionQuote: validExchange,
          },
        },
      })
    ).to.not.throw();
  });

  it('accepts a fully-valid TRANSFER rewardActionCollateral', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionCollateral: validTransfer,
          },
        },
      })
    ).to.not.throw();
  });

  it('rejects EXCHANGE with invalid dexProvider enum', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionQuote: {
              ...validExchange,
              dexProvider: 'bogus' as any,
            },
          },
        },
      })
    ).to.throw(/dexProvider must be one of/);
  });

  it('rejects EXCHANGE with non-hex address', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionQuote: { ...validExchange, address: 'not-an-address' },
          },
        },
      })
    ).to.throw(/address must be a 0x-prefixed/);
  });

  it('rejects EXCHANGE with empty targetToken', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionQuote: { ...validExchange, targetToken: '' },
          },
        },
      })
    ).to.throw(/targetToken/);
  });

  it('rejects EXCHANGE with negative slippage', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionQuote: { ...validExchange, slippage: -1 },
          },
        },
      })
    ).to.throw(/slippage.*non-negative/);
  });

  it('rejects EXCHANGE with fractional fee', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionQuote: { ...validExchange, fee: 0.5 },
          },
        },
      })
    ).to.throw(/fee.*non-negative integer/);
  });

  it('rejects TRANSFER with malformed to address', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionCollateral: { ...validTransfer, to: '0xabc' },
          },
        },
      })
    ).to.throw(/to must be a 0x-prefixed/);
  });

  it('rejects rewardAction with unknown action label', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionQuote: {
              action: 'unknown',
              to: '0x1234567890123456789012345678901234567890',
            } as any,
          },
        },
      })
    ).to.throw(/action must be/);
  });
});

describe('validateTakeSettingsForChain Curve execution delay', () => {
  it('accepts low bounded Curve execution delay overrides', () => {
    expect(() =>
      validateTakeSettingsForChain(
        {
          ...BASE_CONFIG,
          dex: {
            curve: {
              executionDelayMs: 60_000,
            },
          },
        } as KeeperConfig,
        1
      )
    ).to.not.throw();
  });

  it('rejects Curve execution delay overrides that can stall hot take loops', () => {
    expect(() =>
      validateTakeSettingsForChain(
        {
          ...BASE_CONFIG,
          dex: {
            curve: {
              executionDelayMs: 60_001,
            },
          },
        } as KeeperConfig,
        1
      )
    ).to.throw(/executionDelayMs must be an integer between 0 and 60000/);
  });
});

describe('assertIsValidConfig pool-override startup dry-run', () => {
  const validDefault = {
    redeemFirst: TokenToCollect.QUOTE,
    minAmountQuote: 0,
    minAmountCollateral: 0,
  };
  const validExchange = {
    action: RewardActionLabel.EXCHANGE as const,
    address: '0x1234567890123456789012345678901234567890',
    targetToken: 'weth',
    slippage: 1,
    dexProvider: PostAuctionDex.UNISWAP_V3,
  };

  it('rejects a per-pool override with malformed rewardActionQuote', () => {
    // Pool's override injects an invalid `dexProvider`; the startup dry-run
    // merges default + override and runs validateCollectLpRewardSettings
    // on the result, so the failure surfaces here instead of mid-loop.
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        rewards: {
          defaultLpReward: {
            ...validDefault,
            rewardActionQuote: validExchange,
          },
        },
        manual: {
          pools: [
            {
              address: '0x9999999999999999999999999999999999999999',
              price: {} as any,
              collectLpReward: {
                rewardActionQuote: {
                  ...validExchange,
                  dexProvider: 'not-a-dex' as any,
                },
              },
            } as any,
          ],
        },
      })
    ).to.throw(/Invalid LP reward config for pool 0x9999/);
  });

  it('rejects a legacy-mode pool (no default) whose override lacks mandatory mins', () => {
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        manual: {
          pools: [
            {
              address: '0x8888888888888888888888888888888888888888',
              price: {} as any,
              collectLpReward: {
                redeemFirst: TokenToCollect.QUOTE,
                // no minAmountQuote, no minAmountCollateral
              } as any,
            } as any,
          ],
        },
      })
    ).to.throw(/Invalid LP reward config for pool 0x8888/);
  });
});

describe('config-load', () => {
  it('loads a ts config file from a cwd-relative path', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ajna-keeper-config-load-')
    );
    const configPath = path.join(tempDir, 'config.ts');
    const configSource = `export default {
  network: {
    rpcUrl: 'https://example-rpc.invalid',
    subgraph: {
      url: 'https://example-subgraph.invalid',
    },
  },
  keeper: {
    keystore: '/tmp/keeper.json',
  },
  runtime: {
    logLevel: 'info',
    delayBetweenActions: 1,
    delayBetweenRuns: 10,
  },
  ajna: {
    erc20PoolFactory: '0x1111111111111111111111111111111111111111',
    erc721PoolFactory: '0x2222222222222222222222222222222222222222',
    poolUtils: '0x3333333333333333333333333333333333333333',
    positionManager: '0x4444444444444444444444444444444444444444',
    ajnaToken: '0x5555555555555555555555555555555555555555',
  },
  manual: {
    pools: [],
  },
};`;

    await fs.writeFile(configPath, configSource, 'utf8');

    try {
      const cwdRelativePath = path.relative(process.cwd(), configPath);
      const loadedConfig = await readConfigFile(cwdRelativePath);

      expect(loadedConfig.network.rpcUrl).to.equal(
        'https://example-rpc.invalid'
      );
      expect(loadedConfig.network.subgraph.url).to.equal(
        'https://example-subgraph.invalid'
      );
      expect(loadedConfig.manual.pools).to.deep.equal([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('loads a ts config file from an absolute path', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ajna-keeper-config-load-')
    );
    const configPath = path.join(tempDir, 'absolute-config.ts');
    const configSource = `export default {
  network: {
    rpcUrl: 'https://absolute-rpc.invalid',
    subgraph: {
      url: 'https://absolute-subgraph.invalid',
    },
  },
  keeper: {
    keystore: '/tmp/keeper.json',
  },
  runtime: {
    logLevel: 'debug',
    delayBetweenActions: 2,
    delayBetweenRuns: 20,
  },
  ajna: {
    erc20PoolFactory: '0x1111111111111111111111111111111111111111',
    erc721PoolFactory: '0x2222222222222222222222222222222222222222',
    poolUtils: '0x3333333333333333333333333333333333333333',
    positionManager: '0x4444444444444444444444444444444444444444',
    ajnaToken: '0x5555555555555555555555555555555555555555',
  },
  manual: {
    pools: [],
  },
};`;

    await fs.writeFile(configPath, configSource, 'utf8');

    try {
      const loadedConfig = await readConfigFile(configPath);
      expect(loadedConfig.runtime.logLevel).to.equal('debug');
      expect(loadedConfig.network.rpcUrl).to.equal(
        'https://absolute-rpc.invalid'
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
