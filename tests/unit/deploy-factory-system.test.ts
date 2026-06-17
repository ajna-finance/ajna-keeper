import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { ethers } from 'ethers';

chai.use(chaiAsPromised);
import {
  DeploymentAddresses,
  configureFactory,
  generateConfigUpdate,
  validateConfig,
  verifyDeployment,
} from '../../scripts/deploy-factory-system-cli';
import { KeeperConfig, LiquiditySource } from '../../src/config';

// Characterization tests for the descriptor-driven deploy CLI orchestration
// (plan item M-A). These pin the operator-facing behavior the consolidation
// must preserve: the validateConfig gating predicates (including the
// no-allowlist-policy 1inch fail-before-deploy throw), the per-source
// configureFactory registration ordering, the verifyDeployment per-source
// assertions (Uniswap + LI.FI + the B-S1 Sushi branch the loop added, each with
// pass + config/authorization/owner-mismatch cases), and the
// generateConfigUpdate label / address-line output. ethers RPC is fully mocked:
// the signer transport is stubbed so no live network is touched.

const FACTORY = ethers.utils.getAddress(
  '0x00000000000000000000000000000000000fac01'
);
const UNISWAP_TAKER = ethers.utils.getAddress(
  '0x0000000000000000000000000000000000000002'
);
const CURVE_TAKER = ethers.utils.getAddress(
  '0x0000000000000000000000000000000000000004'
);
const LIFI_TAKER = ethers.utils.getAddress(
  '0x0000000000000000000000000000000000000005'
);
const SUSHI_TAKER = ethers.utils.getAddress(
  '0x0000000000000000000000000000000000000006'
);
const OWNER = ethers.utils.getAddress(
  '0x0000000000000000000000000000000000000aaa'
);

const FACTORY_ABI = [
  'function hasConfiguredTaker(uint8) view returns (bool)',
  'function takerContracts(uint8) view returns (address)',
  'function owner() view returns (address)',
  'function setTaker(uint8, address)',
];
const TAKER_ABI = [
  'function owner() view returns (address)',
  'function authorizedRouter() view returns (address)',
];
const FACTORY_IFACE = new ethers.utils.Interface(FACTORY_ABI);
const TAKER_IFACE = new ethers.utils.Interface(TAKER_ABI);

// A Signer-like seam that drives REAL ethers.Contract instances without a live
// RPC: view calls resolve through `call`, writes through `sendTransaction`. This
// mirrors the proven preflight-test approach (stub the transport, not the
// `ethers.Contract` constructor — under ts-node/esm the namespace binding for
// `ethers.Contract` is not interceptable).
function makeFakeSigner(params: {
  address: string;
  call: (tx: { to?: string; data?: string }) => string;
  onSend?: (tx: any) => void;
}): ethers.Signer {
  const provider: any = {
    _isProvider: true,
    resolveName: async (name: string) => name,
    getNetwork: async () => ({ chainId: 8453, name: 'base' }),
    call: async (tx: { to?: string; data?: string }) => params.call(tx),
    estimateGas: async () => ethers.BigNumber.from('100000'),
  };
  const signer: any = {
    _isSigner: true,
    provider,
    getAddress: async () => params.address,
    address: params.address,
    call: async (tx: { to?: string; data?: string }) => params.call(tx),
    resolveName: async (name: string) => name,
    sendTransaction: async (tx: any) => {
      params.onSend?.(tx);
      return {
        hash: '0xdeadbeef',
        // ethers wraps tx.wait and maps over receipt.logs, so it must exist.
        wait: async () => ({ status: 1, logs: [] }),
      };
    },
  };
  return signer as ethers.Signer;
}

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  return {
    logs,
    restore: () => {
      console.log = originalLog;
    },
  };
}

function baseConfig(dex: KeeperConfig['dex']): KeeperConfig {
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

describe('deploy-factory-system CLI orchestration (characterization)', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('validateConfig gating predicates', () => {
    it('fails BEFORE any deployment when dex.oneInch lacks an allowlist policy', async () => {
      const capture = captureConsole();
      try {
        await expect(
          validateConfig(baseConfig({ oneInch: { apiKey: 'x' } } as any))
        ).to.be.rejectedWith(
          /dex\.oneInch is configured without an aggregator allowlist policy/
        );
      } finally {
        capture.restore();
      }
    });

    it('requires ajna.erc20PoolFactory', async () => {
      const capture = captureConsole();
      const config = baseConfig({});
      (config.ajna as any).erc20PoolFactory = undefined;
      try {
        await expect(validateConfig(config)).to.be.rejectedWith(
          'Missing ajna.erc20PoolFactory in config'
        );
      } finally {
        capture.restore();
      }
    });

    it('passes for a minimal direct-DEX-free config (no pools)', async () => {
      const capture = captureConsole();
      try {
        await validateConfig(baseConfig({}));
      } finally {
        capture.restore();
      }
      expect(capture.logs.join('\n')).to.include(
        'Configuration validation passed'
      );
    });
  });

  describe('configureFactory registration ordering', () => {
    // Decode every setTaker(uint8,address) write the CLI issues against the
    // factory, in order.
    function recordingSigner(): {
      signer: ethers.Signer;
      registrations: Array<{ source: number; taker: string }>;
    } {
      const registrations: Array<{ source: number; taker: string }> = [];
      const signer = makeFakeSigner({
        address: OWNER,
        call: () => '0x',
        onSend: (tx) => {
          const parsed = FACTORY_IFACE.parseTransaction({ data: tx.data });
          if (parsed.name === 'setTaker') {
            registrations.push({
              source: Number(parsed.args[0]),
              taker: ethers.utils.getAddress(parsed.args[1]),
            });
          }
        },
      });
      return { signer, registrations };
    }

    it('registers Uniswap (source 2) and Curve (source 4) but NOT LI.FI here', async () => {
      const { signer, registrations } = recordingSigner();
      const addresses: DeploymentAddresses = {
        factory: FACTORY,
        uniswapTaker: UNISWAP_TAKER,
        curveTaker: CURVE_TAKER,
        lifiTaker: LIFI_TAKER,
        sushiAggregatorTaker: SUSHI_TAKER,
      };

      const capture = captureConsole();
      try {
        await configureFactory(signer as ethers.Wallet, FACTORY, addresses);
      } finally {
        capture.restore();
      }

      // configureFactory registers only the direct-DEX takers (Uniswap=2,
      // Curve=4). LI.FI and Sushi are registered separately AFTER allowlists.
      expect(registrations).to.deep.equal([
        { source: LiquiditySource.UNISWAPV3, taker: UNISWAP_TAKER },
        { source: LiquiditySource.CURVE, taker: CURVE_TAKER },
      ]);
    });

    it('skips Uniswap registration when no uniswap taker was deployed', async () => {
      const { signer, registrations } = recordingSigner();
      const addresses: DeploymentAddresses = {
        factory: FACTORY,
        curveTaker: CURVE_TAKER,
      };

      const capture = captureConsole();
      try {
        await configureFactory(signer as ethers.Wallet, FACTORY, addresses);
      } finally {
        capture.restore();
      }

      expect(registrations).to.deep.equal([
        { source: LiquiditySource.CURVE, taker: CURVE_TAKER },
      ]);
    });
  });

  describe('verifyDeployment per-source assertions', () => {
    interface VerifyStubOptions {
      hasUniswap?: boolean;
      registeredUniswap?: string;
      hasLifi?: boolean;
      registeredLifi?: string;
      hasSushi?: boolean;
      registeredSushi?: string;
      factoryOwner?: string;
      uniswapTakerOwner?: string;
      uniswapAuthorizedRouter?: string;
      lifiTakerOwner?: string;
      lifiAuthorizedRouter?: string;
      sushiTakerOwner?: string;
      sushiAuthorizedRouter?: string;
    }

    function deployer(options: VerifyStubOptions = {}): ethers.Wallet {
      const {
        hasUniswap = true,
        registeredUniswap = UNISWAP_TAKER,
        hasLifi = true,
        registeredLifi = LIFI_TAKER,
        hasSushi = true,
        registeredSushi = SUSHI_TAKER,
        factoryOwner = OWNER,
        uniswapTakerOwner = OWNER,
        uniswapAuthorizedRouter = FACTORY,
        lifiTakerOwner = OWNER,
        lifiAuthorizedRouter = FACTORY,
        sushiTakerOwner = OWNER,
        sushiAuthorizedRouter = FACTORY,
      } = options;

      const call = (tx: { to?: string; data?: string }): string => {
        const to = ethers.utils.getAddress(tx.to ?? FACTORY);
        const data = tx.data ?? '0x';
        if (to === FACTORY) {
          const parsed = FACTORY_IFACE.parseTransaction({ data });
          if (parsed.name === 'hasConfiguredTaker') {
            const source = Number(parsed.args[0]);
            return FACTORY_IFACE.encodeFunctionResult('hasConfiguredTaker', [
              source === LiquiditySource.LIFI
                ? hasLifi
                : source === LiquiditySource.SUSHI_AGGREGATOR
                  ? hasSushi
                  : hasUniswap,
            ]);
          }
          if (parsed.name === 'takerContracts') {
            const source = Number(parsed.args[0]);
            return FACTORY_IFACE.encodeFunctionResult('takerContracts', [
              source === LiquiditySource.LIFI
                ? registeredLifi
                : source === LiquiditySource.SUSHI_AGGREGATOR
                  ? registeredSushi
                  : registeredUniswap,
            ]);
          }
          if (parsed.name === 'owner') {
            return FACTORY_IFACE.encodeFunctionResult('owner', [factoryOwner]);
          }
        }
        const selector = data.slice(0, 10);
        const takerOwnerByAddress: Record<string, string> = {
          [UNISWAP_TAKER]: uniswapTakerOwner,
          [LIFI_TAKER]: lifiTakerOwner,
          [SUSHI_TAKER]: sushiTakerOwner,
        };
        const takerRouterByAddress: Record<string, string> = {
          [UNISWAP_TAKER]: uniswapAuthorizedRouter,
          [LIFI_TAKER]: lifiAuthorizedRouter,
          [SUSHI_TAKER]: sushiAuthorizedRouter,
        };
        if (selector === TAKER_IFACE.getSighash('owner')) {
          return TAKER_IFACE.encodeFunctionResult('owner', [
            takerOwnerByAddress[to] ?? OWNER,
          ]);
        }
        if (selector === TAKER_IFACE.getSighash('authorizedRouter')) {
          return TAKER_IFACE.encodeFunctionResult('authorizedRouter', [
            takerRouterByAddress[to] ?? FACTORY,
          ]);
        }
        throw new Error(`unexpected call to ${to}: ${selector}`);
      };

      return makeFakeSigner({ address: OWNER, call }) as ethers.Wallet;
    }

    it('throws when factory address is missing', async () => {
      await expect(verifyDeployment(deployer(), {})).to.be.rejectedWith(
        'Factory address is missing from deployment'
      );
    });

    it('passes when Uniswap + LI.FI configuration/authorization/owner match', async () => {
      const capture = captureConsole();
      try {
        await verifyDeployment(deployer(), {
          factory: FACTORY,
          uniswapTaker: UNISWAP_TAKER,
          lifiTaker: LIFI_TAKER,
        });
      } finally {
        capture.restore();
      }
      expect(capture.logs.join('\n')).to.include(
        'All verification checks passed'
      );
    });

    it('throws on Uniswap factory-configuration mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ registeredUniswap: CURVE_TAKER }), {
            factory: FACTORY,
            uniswapTaker: UNISWAP_TAKER,
          })
        ).to.be.rejectedWith(
          'Uniswap V3 factory configuration verification failed'
        );
      } finally {
        capture.restore();
      }
    });

    it('throws on Uniswap taker authorization mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ uniswapAuthorizedRouter: CURVE_TAKER }), {
            factory: FACTORY,
            uniswapTaker: UNISWAP_TAKER,
          })
        ).to.be.rejectedWith(
          'Uniswap V3 taker authorization verification failed'
        );
      } finally {
        capture.restore();
      }
    });

    it('throws on Uniswap owner mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ uniswapTakerOwner: CURVE_TAKER }), {
            factory: FACTORY,
            uniswapTaker: UNISWAP_TAKER,
          })
        ).to.be.rejectedWith('Uniswap V3 owner verification failed');
      } finally {
        capture.restore();
      }
    });

    it('throws on LI.FI factory-configuration mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ hasLifi: false }), {
            factory: FACTORY,
            lifiTaker: LIFI_TAKER,
          })
        ).to.be.rejectedWith('LI.FI factory configuration verification failed');
      } finally {
        capture.restore();
      }
    });

    it('throws on LI.FI taker authorization mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ lifiAuthorizedRouter: CURVE_TAKER }), {
            factory: FACTORY,
            lifiTaker: LIFI_TAKER,
          })
        ).to.be.rejectedWith('LI.FI taker authorization verification failed');
      } finally {
        capture.restore();
      }
    });

    it('throws on LI.FI owner mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ lifiTakerOwner: CURVE_TAKER }), {
            factory: FACTORY,
            lifiTaker: LIFI_TAKER,
          })
        ).to.be.rejectedWith('LI.FI owner verification failed');
      } finally {
        capture.restore();
      }
    });

    // B-S1: the descriptor loop gives Sushi (and any aggregator) the same
    // post-registration verification Uniswap/LI.FI had. Exercise that branch
    // directly so a regression dropping Sushi from the loop would fail here.
    it('passes when the Sushi taker configuration/authorization/owner match', async () => {
      const capture = captureConsole();
      try {
        await verifyDeployment(deployer(), {
          factory: FACTORY,
          sushiAggregatorTaker: SUSHI_TAKER,
        });
      } finally {
        capture.restore();
      }
      expect(capture.logs.join('\n')).to.include(
        'All verification checks passed'
      );
    });

    it('throws on Sushi factory-configuration mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ registeredSushi: CURVE_TAKER }), {
            factory: FACTORY,
            sushiAggregatorTaker: SUSHI_TAKER,
          })
        ).to.be.rejectedWith(
          'Sushi Aggregator factory configuration verification failed'
        );
      } finally {
        capture.restore();
      }
    });

    it('throws on Sushi taker authorization mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ sushiAuthorizedRouter: CURVE_TAKER }), {
            factory: FACTORY,
            sushiAggregatorTaker: SUSHI_TAKER,
          })
        ).to.be.rejectedWith(
          'Sushi Aggregator taker authorization verification failed'
        );
      } finally {
        capture.restore();
      }
    });

    it('throws on Sushi owner mismatch', async () => {
      const capture = captureConsole();
      try {
        await expect(
          verifyDeployment(deployer({ sushiTakerOwner: CURVE_TAKER }), {
            factory: FACTORY,
            sushiAggregatorTaker: SUSHI_TAKER,
          })
        ).to.be.rejectedWith('Sushi Aggregator owner verification failed');
      } finally {
        capture.restore();
      }
    });
  });

  describe('generateConfigUpdate output (labels + address lines)', () => {
    function run(addresses: DeploymentAddresses): string {
      const capture = captureConsole();
      try {
        generateConfigUpdate(addresses, 'my-config.ts', 'Base');
      } finally {
        capture.restore();
      }
      return capture.logs.join('\n');
    }

    it('emits the takers.router + contracts.* config block for every provider', () => {
      const output = run({
        factory: FACTORY,
        uniswapTaker: UNISWAP_TAKER,
        curveTaker: CURVE_TAKER,
        lifiTaker: LIFI_TAKER,
        sushiAggregatorTaker: SUSHI_TAKER,
      });

      expect(output).to.include('takers: {');
      expect(output).to.include(`  router: '${FACTORY}',`);
      expect(output).to.include('  contracts: {');
      expect(output).to.include(`    UniswapV3: '${UNISWAP_TAKER}',`);
      expect(output).to.include(`    Curve: '${CURVE_TAKER}',`);
      expect(output).to.include(`    Lifi: '${LIFI_TAKER}',`);
      expect(output).to.include(`    SushiAggregator: '${SUSHI_TAKER}',`);
    });

    it('emits the deployed-address summary lines with provider labels', () => {
      const output = run({
        factory: FACTORY,
        uniswapTaker: UNISWAP_TAKER,
        curveTaker: CURVE_TAKER,
        lifiTaker: LIFI_TAKER,
        sushiAggregatorTaker: SUSHI_TAKER,
      });

      expect(output).to.include(`🏭 TakerRouter: ${FACTORY}`);
      expect(output).to.include(`🦄 UniswapV3KeeperTaker: ${UNISWAP_TAKER}`);
      expect(output).to.include(`🌊 CurveKeeperTaker: ${CURVE_TAKER}`);
      expect(output).to.include(`🔁 LifiKeeperTaker: ${LIFI_TAKER}`);
      expect(output).to.include(
        `🍣 SushiAggregatorKeeperTaker: ${SUSHI_TAKER}`
      );
    });

    it('omits provider lines for providers that were not deployed', () => {
      const output = run({ factory: FACTORY, uniswapTaker: UNISWAP_TAKER });

      expect(output).to.include(`    UniswapV3: '${UNISWAP_TAKER}',`);
      expect(output).to.not.include('Curve:');
      expect(output).to.not.include('Lifi:');
      expect(output).to.not.include('SushiAggregator:');
      expect(output).to.not.include('CurveKeeperTaker:');
      expect(output).to.not.include('LifiKeeperTaker:');
      expect(output).to.not.include('SushiAggregatorKeeperTaker:');
    });

    it('prints LI.FI production canary gate steps when a LI.FI taker was deployed', () => {
      const output = run({ factory: FACTORY, lifiTaker: LIFI_TAKER });
      expect(output).to.include('Run the LI.FI route-shape gate');
      expect(output).to.include('Factory system deployment complete for Base');
    });

    it('prints the generic startup next-steps when no LI.FI taker was deployed', () => {
      const output = run({ factory: FACTORY, uniswapTaker: UNISWAP_TAKER });
      expect(output).to.include('2. Test with: yarn start --config my-config.ts');
      expect(output).to.include('3. Expected result: "Type: factory, Valid: true"');
    });
  });
});
