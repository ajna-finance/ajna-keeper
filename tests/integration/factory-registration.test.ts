import { expect } from 'chai';
import { Wallet, constants } from 'ethers';
import { AjnaKeeperTaker__factory } from '../../typechain-types/factories/contracts';
import { AjnaKeeperTakerFactory__factory } from '../../typechain-types/factories/contracts/factories';
import {
  LifiKeeperTaker__factory,
  SushiSwapKeeperTaker__factory,
} from '../../typechain-types/factories/contracts/takers';
import {
  MockConfigurableTaker__factory,
  MockPoolDeployer__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { LiquiditySource } from '../../src/config';
import {
  expectRevertContaining,
  fundSigner,
  getProvider,
} from './helpers/mock-taker-base';

describe('Factory taker registration', () => {
  it('rejects a zero Ajna pool factory at construction', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);

    await expectRevertContaining(
      new AjnaKeeperTakerFactory__factory(owner).deploy(constants.AddressZero),
      "reverted with reason string 'Zero pool factory'"
    );
  });

  it('rejects the legacy direct 1inch taker with a clear incompatibility error', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();

    const legacyTaker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await legacyTaker.deployed();

    await expectRevertContaining(
      factory.setTaker(LiquiditySource.ONEINCH, legacyTaker.address),
      'LegacyDirectOneInchTakerUnsupported'
    );
  });

  it('rejects takers authorized for a different factory', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    const otherAccount = Wallet.createRandom();
    await fundSigner(owner.address);

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();

    const taker = await new SushiSwapKeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      otherAccount.address
    );
    await taker.deployed();

    await expectRevertContaining(
      factory.setTaker(LiquiditySource.SUSHISWAP, taker.address),
      'Factory mismatch'
    );
  });

  it('accepts takers authorized for the registering factory', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();

    const taker = await new SushiSwapKeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      factory.address
    );
    await taker.deployed();

    await factory.setTaker(LiquiditySource.SUSHISWAP, taker.address);

    expect(await factory.takerContracts(LiquiditySource.SUSHISWAP)).to.equal(
      taker.address
    );
  });

  it('rejects takers owned by a different keeper authority', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    const otherOwner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);
    await fundSigner(otherOwner.address);

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();

    const taker = await new LifiKeeperTaker__factory(otherOwner).deploy(
      poolDeployer.address,
      factory.address
    );
    await taker.deployed();

    await expectRevertContaining(
      factory.setTaker(LiquiditySource.LIFI, taker.address),
      'Owner mismatch'
    );
  });

  describe('recoverFromTaker error bubbling', () => {
    async function deployFactoryWithMockTaker() {
      const owner = Wallet.createRandom().connect(getProvider());
      await fundSigner(owner.address);

      const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
      await poolDeployer.deployed();

      const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
        poolDeployer.address
      );
      await factory.deployed();

      const taker = await new MockConfigurableTaker__factory(owner).deploy(
        poolDeployer.address,
        factory.address,
        LiquiditySource.SUSHISWAP
      );
      await taker.deployed();
      await factory.setTaker(LiquiditySource.SUSHISWAP, taker.address);

      return { owner, factory, taker };
    }

    it('bubbles taker custom errors raw instead of flattening them', async () => {
      const { factory, taker } = await deployFactoryWithMockTaker();
      await taker.setRecoverMode(1); // revert CustomRecoveryError()

      // Hardhat can only decode this name because the factory re-reverted the
      // taker's raw 4-byte error data intact (previously flattened to the
      // generic "Recovery failed" string, which carries no error data at all).
      await expectRevertContaining(
        factory.recoverFromTaker(LiquiditySource.SUSHISWAP, taker.address),
        "reverted with custom error 'CustomRecoveryError()'"
      );
    });

    it('still bubbles string revert reasons', async () => {
      const { factory, taker } = await deployFactoryWithMockTaker();
      await taker.setRecoverMode(2); // revert("taker recovery reason")

      await expectRevertContaining(
        factory.recoverFromTaker(LiquiditySource.SUSHISWAP, taker.address),
        'taker recovery reason'
      );
    });

    it('falls back to the generic reason for empty reverts', async () => {
      const { factory, taker } = await deployFactoryWithMockTaker();
      await taker.setRecoverMode(3); // revert with no data

      await expectRevertContaining(
        factory.recoverFromTaker(LiquiditySource.SUSHISWAP, taker.address),
        'Recovery failed'
      );
    });

    it('emits TokenRecovered when recovery succeeds', async () => {
      const { factory, taker } = await deployFactoryWithMockTaker();

      const receipt = await (
        await factory.recoverFromTaker(LiquiditySource.SUSHISWAP, taker.address)
      ).wait();

      const recovered = receipt.events?.find(
        (e) => e.event === 'TokenRecovered'
      );
      expect(recovered, 'expected a TokenRecovered event').to.not.equal(
        undefined
      );
    });
  });

  it('enumerates a taker registered at the last liquidity source value', async () => {
    // Guards the compile-time-derived LAST_LIQUIDITY_SOURCE bound: a taker at
    // the final enum value must appear in getConfiguredTakers.
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();

    const taker = await new MockConfigurableTaker__factory(owner).deploy(
      poolDeployer.address,
      factory.address,
      LiquiditySource.LIFI
    );
    await taker.deployed();
    await factory.setTaker(LiquiditySource.LIFI, taker.address);

    const [sources, takers] = await factory.getConfiguredTakers();
    expect(sources.length).to.equal(1);
    expect(sources[0]).to.equal(LiquiditySource.LIFI);
    expect(takers[0]).to.equal(taker.address);
    expect(await factory.hasConfiguredTaker(LiquiditySource.LIFI)).to.equal(
      true
    );
  });

  it('rejects takers bound to a different Ajna pool factory', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    const otherAjnaFactory = Wallet.createRandom();
    await fundSigner(owner.address);

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();

    const taker = await new SushiSwapKeeperTaker__factory(owner).deploy(
      otherAjnaFactory.address,
      factory.address
    );
    await taker.deployed();

    await expectRevertContaining(
      factory.setTaker(LiquiditySource.SUSHISWAP, taker.address),
      'Pool factory mismatch'
    );
  });
});
