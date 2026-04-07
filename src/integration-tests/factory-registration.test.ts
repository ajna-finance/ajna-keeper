import { expect } from 'chai';
import { Wallet, constants, providers, utils } from 'ethers';
import { network } from 'hardhat';
import { AjnaKeeperTakerFactory__factory } from '../../typechain-types/factories/contracts/factories';
import { SushiSwapKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import { LiquiditySource } from '../config-types';

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
  it('rejects takers authorized for a different factory', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    const otherAccount = Wallet.createRandom();
    await fundSigner(owner.address);

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      constants.AddressZero
    );
    await factory.deployed();

    const taker = await new SushiSwapKeeperTaker__factory(owner).deploy(
      constants.AddressZero,
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

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      constants.AddressZero
    );
    await factory.deployed();

    const taker = await new SushiSwapKeeperTaker__factory(owner).deploy(
      constants.AddressZero,
      factory.address
    );
    await taker.deployed();

    await factory.setTaker(LiquiditySource.SUSHISWAP, taker.address);

    expect(await factory.takerContracts(LiquiditySource.SUSHISWAP)).to.equal(
      taker.address
    );
  });
});
