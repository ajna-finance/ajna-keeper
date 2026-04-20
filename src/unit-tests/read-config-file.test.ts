import { expect } from 'chai';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { readConfigFile } from '../config';
import { assertIsValidConfig } from '../config/load';

const BASE_CONFIG = {
  ethRpcUrl: 'https://example-rpc.invalid',
  logLevel: 'info',
  subgraphUrl: 'https://example-subgraph.invalid',
  keeperKeystore: '/tmp/keeper.json',
  ajna: {
    erc20PoolFactory: '0x1111111111111111111111111111111111111111',
    erc721PoolFactory: '0x2222222222222222222222222222222222222222',
    poolUtils: '0x3333333333333333333333333333333333333333',
    positionManager: '0x4444444444444444444444444444444444444444',
    ajnaToken: '0x5555555555555555555555555555555555555555',
  },
  delayBetweenActions: 1,
  delayBetweenRuns: 10,
  pools: [],
};

describe('assertIsValidConfig lpRewardLookbackSeconds', () => {
  it('accepts omission (defaults applied downstream)', () => {
    expect(() => assertIsValidConfig({ ...BASE_CONFIG })).to.not.throw();
  });

  it('accepts non-negative integers', () => {
    expect(() =>
      assertIsValidConfig({ ...BASE_CONFIG, lpRewardLookbackSeconds: 0 })
    ).to.not.throw();
    expect(() =>
      assertIsValidConfig({ ...BASE_CONFIG, lpRewardLookbackSeconds: 300 })
    ).to.not.throw();
  });

  it('rejects negative values (would invert cursor math)', () => {
    expect(() =>
      assertIsValidConfig({ ...BASE_CONFIG, lpRewardLookbackSeconds: -30 })
    ).to.throw(/non-negative integer/);
  });

  it('rejects fractional values', () => {
    expect(() =>
      assertIsValidConfig({ ...BASE_CONFIG, lpRewardLookbackSeconds: 0.5 })
    ).to.throw(/non-negative integer/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() =>
      assertIsValidConfig({ ...BASE_CONFIG, lpRewardLookbackSeconds: Number.NaN })
    ).to.throw(/non-negative integer/);
    expect(() =>
      assertIsValidConfig({
        ...BASE_CONFIG,
        lpRewardLookbackSeconds: Number.POSITIVE_INFINITY,
      })
    ).to.throw(/non-negative integer/);
  });
});

describe('config-load', () => {
  it('loads a ts config file from a cwd-relative path', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ajna-keeper-config-load-')
    );
    const configPath = path.join(tempDir, 'config.ts');
    const configSource = `export default {
  ethRpcUrl: 'https://example-rpc.invalid',
  logLevel: 'info',
  subgraphUrl: 'https://example-subgraph.invalid',
  keeperKeystore: '/tmp/keeper.json',
  ajna: {
    erc20PoolFactory: '0x1111111111111111111111111111111111111111',
    erc721PoolFactory: '0x2222222222222222222222222222222222222222',
    poolUtils: '0x3333333333333333333333333333333333333333',
    positionManager: '0x4444444444444444444444444444444444444444',
    ajnaToken: '0x5555555555555555555555555555555555555555',
  },
  delayBetweenActions: 1,
  delayBetweenRuns: 10,
  pools: [],
};`;

    await fs.writeFile(configPath, configSource, 'utf8');

    try {
      const cwdRelativePath = path.relative(process.cwd(), configPath);
      const loadedConfig = await readConfigFile(cwdRelativePath);

      expect(loadedConfig.ethRpcUrl).to.equal('https://example-rpc.invalid');
      expect(loadedConfig.subgraphUrl).to.equal(
        'https://example-subgraph.invalid'
      );
      expect(loadedConfig.pools).to.deep.equal([]);
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
  ethRpcUrl: 'https://absolute-rpc.invalid',
  logLevel: 'debug',
  subgraphUrl: 'https://absolute-subgraph.invalid',
  keeperKeystore: '/tmp/keeper.json',
  ajna: {
    erc20PoolFactory: '0x1111111111111111111111111111111111111111',
    erc721PoolFactory: '0x2222222222222222222222222222222222222222',
    poolUtils: '0x3333333333333333333333333333333333333333',
    positionManager: '0x4444444444444444444444444444444444444444',
    ajnaToken: '0x5555555555555555555555555555555555555555',
  },
  delayBetweenActions: 2,
  delayBetweenRuns: 20,
  pools: [],
};`;

    await fs.writeFile(configPath, configSource, 'utf8');

    try {
      const loadedConfig = await readConfigFile(configPath);
      expect(loadedConfig.logLevel).to.equal('debug');
      expect(loadedConfig.ethRpcUrl).to.equal('https://absolute-rpc.invalid');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
