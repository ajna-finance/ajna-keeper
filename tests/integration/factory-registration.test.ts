import { expect } from 'chai';
import { Wallet, constants, providers, utils } from 'ethers';
import { network } from 'hardhat';
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

function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

async function fundSigner(address: string) {
  await network.provider.send('hardhat_setBalance', [
    address,
    utils.parseEther('10').toHexString(),
  ]);
}

describe('Factory taker registration', () => {
  it('rejects a zero Ajna pool factory at construction', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);

    let error: unknown;
    try {
      const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
        constants.AddressZero
      );
      await factory.deployed();
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    // Strict reason phrase: deploy-revert errors embed contract source, so a
    // bare substring can false-match identifiers that appear in the code.
    expect((error as Error).message).to.contain(
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

    let error: unknown;
    try {
      await factory.setTaker(LiquiditySource.ONEINCH, legacyTaker.address);
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain(
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

    let error: unknown;
    try {
      await factory.setTaker(LiquiditySource.SUSHISWAP, taker.address);
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain('Factory mismatch');
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

    let error: unknown;
    try {
      await factory.setTaker(LiquiditySource.LIFI, taker.address);
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain('Owner mismatch');
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

      const customErrorSelector = utils
        .id('CustomRecoveryError()')
        .slice(0, 10);

      let error: unknown;
      try {
        await factory.recoverFromTaker(
          LiquiditySource.SUSHISWAP,
          taker.address
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      // The raw custom-error selector must surface in the revert data
      // (previously flattened to the generic "Recovery failed" string).
      expect((error as Error).message).to.contain(customErrorSelector);
    });

    it('still bubbles string revert reasons', async () => {
      const { factory, taker } = await deployFactoryWithMockTaker();
      await taker.setRecoverMode(2); // revert("taker recovery reason")

      let error: unknown;
      try {
        await factory.recoverFromTaker(
          LiquiditySource.SUSHISWAP,
          taker.address
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.contain('taker recovery reason');
    });

    it('falls back to the generic reason for empty reverts', async () => {
      const { factory, taker } = await deployFactoryWithMockTaker();
      await taker.setRecoverMode(3); // revert with no data

      let error: unknown;
      try {
        await factory.recoverFromTaker(
          LiquiditySource.SUSHISWAP,
          taker.address
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.contain('Recovery failed');
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

    let error: unknown;
    try {
      await factory.setTaker(LiquiditySource.SUSHISWAP, taker.address);
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain('Pool factory mismatch');
  });
});
