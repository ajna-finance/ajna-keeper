import { expect } from 'chai';
import { BigNumber, constants, ethers, providers, utils, Wallet } from 'ethers';
import { network } from 'hardhat';
import { AjnaKeeperTaker__factory } from '../../typechain-types/factories/contracts';
import { MockAllowanceCheckingPool__factory, MockERC20__factory, MockPoolDeployer__factory } from '../../typechain-types/factories/contracts/mocks';

const WAD = ethers.constants.WeiPerEther;
const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);

function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

describe('AjnaKeeperTaker quote approval rounding', () => {
  it('rounds quote approval up for non-18-decimal quote tokens', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await network.provider.send('hardhat_setBalance', [
      owner.address,
      utils.parseEther('10').toHexString(),
    ]);

    const collateralToken = await new MockERC20__factory(owner).deploy(
      'Mock Collateral',
      'MCOLL',
      18
    );
    await collateralToken.deployed();

    const quoteToken = await new MockERC20__factory(owner).deploy(
      'Mock Quote',
      'MQUOTE',
      6
    );
    await quoteToken.deployed();

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const maxAmount = WAD;
    const auctionPrice = WAD.add(1);
    const quoteTokenScale = BigNumber.from(10).pow(12);
    const pool = await new MockAllowanceCheckingPool__factory(owner).deploy(
      collateralToken.address,
      quoteToken.address,
      quoteTokenScale,
      auctionPrice
    );
    await pool.deployed();

    await poolDeployer.setDeployedPool(
      ERC20_NON_SUBSET_HASH,
      collateralToken.address,
      quoteToken.address,
      pool.address
    );

    const keeperTaker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await keeperTaker.deployed();

    const quoteDueWad = maxAmount.mul(auctionPrice).add(WAD.sub(1)).div(WAD);
    const expectedQuoteApproval = quoteDueWad
      .add(quoteTokenScale.sub(1))
      .div(quoteTokenScale);
    const flooredApproval = quoteDueWad.div(quoteTokenScale);

    expect(expectedQuoteApproval.sub(flooredApproval).eq(1)).to.be.true;

    await quoteToken.mint(keeperTaker.address, expectedQuoteApproval.add(5));

    await keeperTaker.takeWithAtomicSwap(
      pool.address,
      constants.AddressZero,
      auctionPrice,
      maxAmount,
      1,
      constants.AddressZero,
      '0x'
    );

    expect((await quoteToken.balanceOf(pool.address)).eq(expectedQuoteApproval))
      .to.be.true;
    expect((await quoteToken.balanceOf(keeperTaker.address)).isZero()).to.be
      .true;
  });

  it('rejects unregistered pools before granting quote allowance', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await network.provider.send('hardhat_setBalance', [
      owner.address,
      utils.parseEther('10').toHexString(),
    ]);

    const collateralToken = await new MockERC20__factory(owner).deploy(
      'Mock Collateral',
      'MCOLL',
      18
    );
    await collateralToken.deployed();

    const quoteToken = await new MockERC20__factory(owner).deploy(
      'Mock Quote',
      'MQUOTE',
      6
    );
    await quoteToken.deployed();

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const quoteTokenScale = BigNumber.from(10).pow(12);
    const auctionPrice = WAD;
    const invalidPool = await new MockAllowanceCheckingPool__factory(owner).deploy(
      collateralToken.address,
      quoteToken.address,
      quoteTokenScale,
      auctionPrice
    );
    await invalidPool.deployed();

    const keeperTaker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await keeperTaker.deployed();

    await quoteToken.mint(keeperTaker.address, BigNumber.from(1_000_000));

    let error: unknown;
    try {
      await keeperTaker.takeWithAtomicSwap(
        invalidPool.address,
        constants.AddressZero,
        auctionPrice,
        WAD,
        1,
        constants.AddressZero,
        '0x'
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain('InvalidPool');
    expect((await quoteToken.balanceOf(invalidPool.address)).isZero()).to.be.true;
    expect((await quoteToken.balanceOf(keeperTaker.address)).eq(1_000_000)).to.be.true;
  });
});
