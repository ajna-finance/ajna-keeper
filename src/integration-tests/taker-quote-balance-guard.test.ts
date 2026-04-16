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
  MockPermit2__factory,
  MockPoolDeployer__factory,
  MockSushiSwapRouter__factory,
  MockSwapRouter__factory,
  MockUniversalRouter__factory,
} from '../../typechain-types/factories/contracts/mocks';

const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
const COLLATERAL_AMOUNT = utils.parseEther('10');
const QUOTE_AMOUNT_DUE = utils.parseEther('5');
const QUOTE_TOKEN_SCALE = BigNumber.from(1);
const DEADLINE = 4_102_444_800;
const ZERO_FACTORY = constants.AddressZero;

const ONE_INCH_DETAILS_TYPE = '(address,(address,address,address,address,uint256,uint256,uint256),bytes)';
const ONE_INCH_CALLBACK_DATA_TYPE = '(uint8,address,bytes)';
const UNISWAP_DETAILS_TYPE = '(address,address,address,uint24,uint256,uint256)';
const SUSHI_DETAILS_TYPE = '(address,address,uint24,uint256,uint256)';
const CURVE_DETAILS_TYPE = '(address,address,address,uint8,uint8,uint8,uint256,uint256)';

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

  it('rejects legacy 1inch routes that redirect output away from the taker', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } = await deployBase();
    const taker = await new AjnaKeeperTaker__factory(owner).deploy(poolDeployer.address);
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);

    const router = await new MockSwapRouter__factory(owner).deploy(0, 1);
    await router.deployed();

    const oneInchDetails = utils.defaultAbiCoder.encode(
      [ONE_INCH_DETAILS_TYPE],
      [[
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
      ]]
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

  it('rejects legacy 1inch swaps that rely on preexisting quote balance', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } = await deployBase();
    const taker = await new AjnaKeeperTaker__factory(owner).deploy(poolDeployer.address);
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const router = await new MockSwapRouter__factory(owner).deploy(0, 1);
    await router.deployed();

    const oneInchDetails = utils.defaultAbiCoder.encode(
      [ONE_INCH_DETAILS_TYPE],
      [[
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
      ]]
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

  it('rejects uniswap callbacks that do not increase quote balance', async () => {
    const { owner, collateralToken, quoteToken, poolDeployer, pool } = await deployBase();
    const taker = await new UniswapV3KeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      ZERO_FACTORY
    );
    await taker.deployed();

    await collateralToken.mint(taker.address, COLLATERAL_AMOUNT);
    await quoteToken.mint(taker.address, QUOTE_AMOUNT_DUE);

    const permit2 = await new MockPermit2__factory(owner).deploy();
    await permit2.deployed();
    const router = await new MockUniversalRouter__factory(owner).deploy(
      permit2.address,
      quoteToken.address,
      0
    );
    await router.deployed();

    const callbackData = utils.defaultAbiCoder.encode(
      [UNISWAP_DETAILS_TYPE],
      [[router.address, permit2.address, quoteToken.address, 500, 0, DEADLINE]]
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
    const { owner, collateralToken, quoteToken, poolDeployer, pool } = await deployBase();
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
    const { owner, collateralToken, quoteToken, poolDeployer, pool } = await deployBase();
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
      [[
        curvePool.address,
        collateralToken.address,
        quoteToken.address,
        0,
        0,
        1,
        0,
        DEADLINE,
      ]]
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
