import { expect } from 'chai';
import { BigNumber, Wallet, constants, providers, utils } from 'ethers';
import { network } from 'hardhat';
import { AjnaKeeperTaker__factory } from '../../typechain-types/factories/contracts';
import {
  CurveKeeperTaker__factory,
  SushiSwapKeeperTaker__factory,
  UniswapV3KeeperTaker__factory,
} from '../../typechain-types/factories/contracts/takers';
import {
  MockAtomicSwapPool__factory,
  MockCurveSwapPool__factory,
  MockERC20__factory,
  MockOneInchUnderdeliveryRouter__factory,
  MockPoolDeployer__factory,
  MockSushiSwapRouter__factory,
  MockSwapRouter__factory,
} from '../../typechain-types/factories/contracts/mocks';

const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
const COLLATERAL_AMOUNT = utils.parseEther('10');
const QUOTE_AMOUNT_DUE = utils.parseEther('5');
const QUOTE_TOKEN_SCALE = BigNumber.from(1);
const DEADLINE = 4_102_444_800;
const ZERO_FACTORY = constants.AddressZero;

const ONE_INCH_DETAILS_TYPE =
  '(address,(address,address,address,address,uint256,uint256,uint256),bytes)';
const ONE_INCH_CALLBACK_DATA_TYPE = '(uint8,address,bytes)';
const UNISWAP_DETAILS_TYPE = '(address,address,uint24,uint256,uint256)';
const SUSHI_DETAILS_TYPE = '(address,address,uint24,uint256,uint256)';
const CURVE_DETAILS_TYPE =
  '(address,address,address,uint8,uint8,uint8,uint256,uint256)';

function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

async function expectCustomError(tx: Promise<unknown>, errorName: string) {
  let caught: unknown;
  try {
    await tx;
  } catch (error) {
    caught = error;
  }

  expect(caught).to.be.instanceOf(Error);
  expect((caught as Error).message).to.contain(errorName);
}

describe('Taker quote balance guards', () => {
  async function deployBase() {
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
      18
    );
    await quoteToken.deployed();

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    const pool = await new MockAtomicSwapPool__factory(owner).deploy(
      collateralToken.address,
      quoteToken.address,
      QUOTE_TOKEN_SCALE
    );
    await pool.deployed();

    await poolDeployer.setDeployedPool(
      ERC20_NON_SUBSET_HASH,
      collateralToken.address,
      quoteToken.address,
      pool.address
    );

    return { owner, collateralToken, quoteToken, poolDeployer, pool };
  }

  it('rejects 1inch atomic routes that redirect output away from the taker', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);

    const router = await new MockSwapRouter__factory(owner).deploy(0, 1);
    await router.deployed();

    const oneInchDetails = utils.defaultAbiCoder.encode(
      [ONE_INCH_DETAILS_TYPE],
      [
        [
          router.address,
          [
            collateralToken.address,
            quoteToken.address,
            router.address,
            owner.address,
            COLLATERAL_AMOUNT,
            0,
            0,
          ],
          '0x',
        ],
      ]
    );
    const callbackData = utils.defaultAbiCoder.encode(
      [ONE_INCH_CALLBACK_DATA_TYPE],
      [[1, router.address, oneInchDetails]]
    );

    await expectCustomError(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InvalidSwapDetails'
    );
  });

  it('rejects 1inch atomic swaps that rely on preexisting quote balance', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const router = await new MockSwapRouter__factory(owner).deploy(0, 1);
    await router.deployed();

    const oneInchDetails = utils.defaultAbiCoder.encode(
      [ONE_INCH_DETAILS_TYPE],
      [
        [
          router.address,
          [
            collateralToken.address,
            quoteToken.address,
            router.address,
            taker.address,
            COLLATERAL_AMOUNT,
            0,
            0,
          ],
          '0x',
        ],
      ]
    );
    const callbackData = utils.defaultAbiCoder.encode(
      [ONE_INCH_CALLBACK_DATA_TYPE],
      [[1, router.address, oneInchDetails]]
    );

    await expectCustomError(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects 1inch atomic swaps that underdeliver versus the scaled minReturnAmount', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new AjnaKeeperTaker__factory(owner).deploy(
      poolDeployer.address
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);

    const router = await new MockOneInchUnderdeliveryRouter__factory(
      owner
    ).deploy(QUOTE_AMOUNT_DUE);
    await router.deployed();
    await quoteToken.mint(router.address, QUOTE_AMOUNT_DUE);

    const quotedCollateralAmount = COLLATERAL_AMOUNT.mul(2);
    const quotedMinReturnAmount = utils.parseEther('12');
    const oneInchDetails = utils.defaultAbiCoder.encode(
      [ONE_INCH_DETAILS_TYPE],
      [
        [
          router.address,
          [
            collateralToken.address,
            quoteToken.address,
            router.address,
            taker.address,
            quotedCollateralAmount,
            quotedMinReturnAmount,
            0,
          ],
          '0x',
        ],
      ]
    );
    const callbackData = utils.defaultAbiCoder.encode(
      [ONE_INCH_CALLBACK_DATA_TYPE],
      [[1, router.address, oneInchDetails]]
    );

    await expectCustomError(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('executes uniswap callbacks through direct SwapRouter02 custody', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    const router = await new MockSushiSwapRouter__factory(owner).deploy(
      QUOTE_AMOUNT_DUE
    );
    await router.deployed();
    await quoteToken.mint(router.address, QUOTE_AMOUNT_DUE);

    const callbackData = utils.defaultAbiCoder.encode(
      [UNISWAP_DETAILS_TYPE],
      [[router.address, quoteToken.address, 500, QUOTE_AMOUNT_DUE, DEADLINE]]
    );

    await pool.callAtomicSwapCallback(
      taker.address,
      COLLATERAL_AMOUNT,
      QUOTE_AMOUNT_DUE,
      callbackData
    );

    expect(
      (await collateralToken.balanceOf(router.address)).eq(COLLATERAL_AMOUNT)
    ).to.equal(true);
    expect(
      (await quoteToken.balanceOf(taker.address)).eq(QUOTE_AMOUNT_DUE)
    ).to.equal(true);
    expect(
      (await collateralToken.allowance(taker.address, router.address)).eq(0)
    ).to.equal(true);
  });

  it('executes full uniswap takes with direct SwapRouter02 and resets allowances', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    await pool.setQuoteAmountDue(QUOTE_AMOUNT_DUE);
    await collateralToken.mint(pool.address, COLLATERAL_AMOUNT);

    const router = await new MockSushiSwapRouter__factory(owner).deploy(
      QUOTE_AMOUNT_DUE
    );
    await router.deployed();
    await quoteToken.mint(router.address, QUOTE_AMOUNT_DUE);

    const swapDetails = utils.defaultAbiCoder.encode(
      [UNISWAP_DETAILS_TYPE],
      [[router.address, quoteToken.address, 500, QUOTE_AMOUNT_DUE, DEADLINE]]
    );

    await taker.takeWithAtomicSwap(
      pool.address,
      owner.address,
      utils.parseEther('1'),
      COLLATERAL_AMOUNT,
      2,
      router.address,
      swapDetails
    );

    expect((await pool.takeCount()).eq(1)).to.equal(true);
    expect(
      (await collateralToken.balanceOf(router.address)).eq(COLLATERAL_AMOUNT)
    ).to.equal(true);
    expect((await quoteToken.balanceOf(pool.address)).eq(QUOTE_AMOUNT_DUE)).to
      .be.true;
    expect(
      (await collateralToken.allowance(taker.address, router.address)).eq(0)
    ).to.equal(true);
    expect((await quoteToken.allowance(taker.address, pool.address)).eq(0)).to
      .equal(true);
  });

  it('rejects full uniswap takes when the router argument differs from encoded details', async () => {
    const { owner, quoteToken, poolDeployer, pool } = await deployBase();
    const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    const router = await new MockSushiSwapRouter__factory(owner).deploy(
      QUOTE_AMOUNT_DUE
    );
    await router.deployed();
    const otherRouter = await new MockSushiSwapRouter__factory(owner).deploy(
      QUOTE_AMOUNT_DUE
    );
    await otherRouter.deployed();

    const swapDetails = utils.defaultAbiCoder.encode(
      [UNISWAP_DETAILS_TYPE],
      [[router.address, quoteToken.address, 500, QUOTE_AMOUNT_DUE, DEADLINE]]
    );

    await expectCustomError(
      taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        utils.parseEther('1'),
        COLLATERAL_AMOUNT,
        2,
        otherRouter.address,
        swapDetails
      ),
      'Router mismatch'
    );

    expect((await pool.takeCount()).eq(0)).to.equal(true);
    expect((await quoteToken.allowance(taker.address, pool.address)).eq(0)).to
      .equal(true);
  });

  it('rejects full uniswap takes with expired deadlines', async () => {
    const { owner, quoteToken, poolDeployer, pool } = await deployBase();
    const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    const router = await new MockSushiSwapRouter__factory(owner).deploy(
      QUOTE_AMOUNT_DUE
    );
    await router.deployed();

    const swapDetails = utils.defaultAbiCoder.encode(
      [UNISWAP_DETAILS_TYPE],
      [[router.address, quoteToken.address, 500, QUOTE_AMOUNT_DUE, 1]]
    );

    await expectCustomError(
      taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        utils.parseEther('1'),
        COLLATERAL_AMOUNT,
        2,
        router.address,
        swapDetails
      ),
      'Expired deadline'
    );

    expect((await pool.takeCount()).eq(0)).to.equal(true);
    expect((await quoteToken.allowance(taker.address, pool.address)).eq(0)).to
      .equal(true);
  });

  it('rejects full uniswap takes with zero amountOutMinimum', async () => {
    const { owner, quoteToken, poolDeployer, pool } = await deployBase();
    const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    const router = await new MockSushiSwapRouter__factory(owner).deploy(
      QUOTE_AMOUNT_DUE
    );
    await router.deployed();

    const swapDetails = utils.defaultAbiCoder.encode(
      [UNISWAP_DETAILS_TYPE],
      [[router.address, quoteToken.address, 500, 0, DEADLINE]]
    );

    await expectCustomError(
      taker.takeWithAtomicSwap(
        pool.address,
        owner.address,
        utils.parseEther('1'),
        COLLATERAL_AMOUNT,
        2,
        router.address,
        swapDetails
      ),
      'Invalid minimum amount'
    );

    expect((await pool.takeCount()).eq(0)).to.equal(true);
    expect((await quoteToken.allowance(taker.address, pool.address)).eq(0)).to
      .equal(true);
  });

  it('rejects uniswap callbacks that target anything other than pool quote', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    const router = await new MockSushiSwapRouter__factory(owner).deploy(
      QUOTE_AMOUNT_DUE
    );
    await router.deployed();

    const callbackData = utils.defaultAbiCoder.encode(
      [UNISWAP_DETAILS_TYPE],
      [[router.address, collateralToken.address, 500, QUOTE_AMOUNT_DUE, DEADLINE]]
    );

    await expectCustomError(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InvalidSwapDetails'
    );

    expect((await collateralToken.balanceOf(router.address)).eq(0)).to.equal(
      true
    );
    expect((await quoteToken.balanceOf(taker.address)).eq(0)).to.equal(true);
  });

  it('rejects uniswap callbacks that do not increase quote balance', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const router = await new MockSushiSwapRouter__factory(owner).deploy(0);
    await router.deployed();

    const callbackData = utils.defaultAbiCoder.encode(
      [UNISWAP_DETAILS_TYPE],
      [[router.address, quoteToken.address, 500, 1, DEADLINE]]
    );

    await expectCustomError(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects sushiswap callbacks that do not increase quote balance', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new SushiSwapKeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const router = await new MockSushiSwapRouter__factory(owner).deploy(0);
    await router.deployed();

    const callbackData = utils.defaultAbiCoder.encode(
      [SUSHI_DETAILS_TYPE],
      [[router.address, quoteToken.address, 500, 0, DEADLINE]]
    );

    await expectCustomError(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });

  it('rejects curve callbacks that trust forged return values without quote balance increase', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } =
      await deployBase();
    const taker = await new CurveKeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const curvePool = await new MockCurveSwapPool__factory(owner).deploy(
      collateralToken.address,
      1
    );
    await curvePool.deployed();

    const callbackData = utils.defaultAbiCoder.encode(
      [CURVE_DETAILS_TYPE],
      [
        [
          curvePool.address,
          collateralToken.address,
          quoteToken.address,
          0,
          0,
          1,
          0,
          DEADLINE,
        ],
      ]
    );

    await expectCustomError(
      pool.callAtomicSwapCallback(
        taker.address,
        COLLATERAL_AMOUNT,
        QUOTE_AMOUNT_DUE,
        callbackData
      ),
      'InsufficientQuoteReceived'
    );
  });
});
