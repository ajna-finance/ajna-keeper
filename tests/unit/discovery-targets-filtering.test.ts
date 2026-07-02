import { expect } from 'chai';
import sinon from 'sinon';
import {
  buildDiscoveredTakeTargets,
  clearSharedDiscoveryScans,
  ensurePoolLoaded,
} from '../../src/discovery/targets';
import { DISCOVERY_BASE_CONFIG } from './helpers/discovery-targets-fixture';

describe('Discovery Target Filtering', () => {
  afterEach(() => {
    sinon.restore();
    clearSharedDiscoveryScans();
  });

  it('applies allowPools and denyPools before grouping discovered take targets', async () => {
    const auctions = [
      {
        borrower: '0xBorrowerAllowed',
        kickTime: '1',
        debtRemaining: '2',
        collateralRemaining: '3',
        neutralPrice: '4',
        debt: '2',
        collateral: '3',
        pool: { id: '0x1111111111111111111111111111111111111111' },
      },
      {
        borrower: '0xBorrowerDeniedByAllowlist',
        kickTime: '1',
        debtRemaining: '2',
        collateralRemaining: '3',
        neutralPrice: '4',
        debt: '2',
        collateral: '3',
        pool: { id: '0x2222222222222222222222222222222222222222' },
      },
      {
        borrower: '0xBorrowerDeniedExplicitly',
        kickTime: '1',
        debtRemaining: '2',
        collateralRemaining: '3',
        neutralPrice: '4',
        debt: '2',
        collateral: '3',
        pool: { id: '0x3333333333333333333333333333333333333333' },
      },
    ];

    const allowTargets = await buildDiscoveredTakeTargets(
      {
        ...DISCOVERY_BASE_CONFIG,
        discovery: {
          ...DISCOVERY_BASE_CONFIG.discovery!,
          allowPools: ['0x1111111111111111111111111111111111111111'],
        },
      },
      auctions
    );
    const denyTargets = await buildDiscoveredTakeTargets(
      {
        ...DISCOVERY_BASE_CONFIG,
        discovery: {
          ...DISCOVERY_BASE_CONFIG.discovery!,
          denyPools: ['0x3333333333333333333333333333333333333333'],
        },
      },
      auctions
    );

    expect(allowTargets.map((target) => target.poolAddress)).to.deep.equal([
      '0x1111111111111111111111111111111111111111',
    ]);
    expect(denyTargets.map((target) => target.poolAddress)).to.deep.equal([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
    ]);
  });

  it('skips pool hydration while a failed pool remains in cooldown', async () => {
    const getPoolByAddress = sinon
      .stub()
      .throws(new Error('cooldown bypassed'));
    const hydrationCooldowns = new Map<string, number>([
      ['0x1111111111111111111111111111111111111111', Date.now() + 60_000],
    ]);

    const pool = await ensurePoolLoaded({
      ajna: {
        fungiblePoolFactory: {
          getPoolByAddress,
        },
      } as any,
      poolMap: new Map() as any,
      poolAddress: '0x1111111111111111111111111111111111111111',
      config: DISCOVERY_BASE_CONFIG,
      hydrationCooldowns,
    });

    expect(pool).to.equal(undefined);
    expect(getPoolByAddress.called).to.equal(false);
  });
});
