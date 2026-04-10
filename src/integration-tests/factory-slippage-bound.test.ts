import './subgraph-mock';
import { AjnaSDK, FungiblePool, Provider } from '@ajna-finance/sdk';
import { expect } from 'chai';
import { BigNumber, Contract, Wallet, ethers, utils } from 'ethers';
import ERC20_ABI from '../abis/erc20.abi.json';
import { LiquiditySource } from '../config';
import { SECONDS_PER_DAY } from '../constants';
import { getLoansToKick, kick } from '../kick';
import { depositQuoteToken, drawDebt } from './loan-helpers';
import {
  makeGetHighestMeaningfulBucket,
  makeGetLiquidationsFromSdk,
  makeGetLoansFromSdk,
  overrideGetHighestMeaningfulBucket,
  overrideGetLiquidations,
  overrideGetLoans,
} from './subgraph-mock';
import { MAINNET_CONFIG, USER1_MNEMONIC } from './test-config';
import {
  getProvider,
  impersonateSigner,
  increaseTime,
  resetHardhat,
  setBalance,
} from './test-utils';
import { NonceTracker } from '../nonce';
import { configureAjna } from '../config';
import {
  computeFactoryAmountOutMinimum,
  takeLiquidationFactory,
} from '../take/factory';
import { arrayFromAsync } from '../utils';
import { AjnaKeeperTakerFactory__factory } from '../../typechain-types/factories/contracts/factories';
import { SushiSwapKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import { MockSushiSwapRouter__factory } from '../../typechain-types/factories/contracts/mocks';

const FORK_INTEGRATION_TIMEOUT_MS = 300_000;
const WAD = ethers.constants.WeiPerEther;

function computeQuoteAmountDueRaw(
  collateral: BigNumber,
  auctionPrice: BigNumber,
  quoteScale: BigNumber
): BigNumber {
  const wadDue = collateral.mul(auctionPrice).add(WAD.sub(1)).div(WAD);
  return wadDue.add(quoteScale).sub(1).div(quoteScale);
}

async function getChainDeadline(provider: Provider, ttlSeconds: number = 1800) {
  const latestBlock = await provider.getBlock('latest');
  return latestBlock.timestamp + ttlSeconds;
}

describe('Factory slippage bound', function () {
  this.timeout(FORK_INTEGRATION_TIMEOUT_MS);

  let provider: Provider;
  let pool: FungiblePool;
  let signer: Wallet;
  let borrower: string;
  let quoteToken: Contract;
  let snapshotId: string;

  async function setupLiquidationScenario(): Promise<void> {
    await depositQuoteToken({
      pool,
      owner: MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress,
      amount: 1,
      price: 0.07,
    });

    await drawDebt({
      pool,
      owner: MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress,
      amountToBorrow: 0.9,
      collateralToPledge: 14,
    });

    await increaseTime(SECONDS_PER_DAY * 365 * 2);
    borrower = MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress;

    const loansToKick = await arrayFromAsync(
      getLoansToKick({
        pool,
        poolConfig: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig,
        config: {
          subgraphUrl: '',
          coinGeckoApiKey: '',
        },
      })
    );
    const kickSigner = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2
    );
    await setBalance(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress2,
      utils.parseEther('100').toHexString()
    );

    await kick({
      pool,
      signer: kickSigner as any,
      loanToKick: loansToKick[0],
      config: { dryRun: false },
    });

    await increaseTime(SECONDS_PER_DAY);
  }

  async function deployFactorySystem() {
    const factory = await new AjnaKeeperTakerFactory__factory(signer).deploy(
      MAINNET_CONFIG.AJNA_CONFIG.erc20PoolFactory
    );
    await factory.deployed();

    const sushiTaker = await new SushiSwapKeeperTaker__factory(signer).deploy(
      MAINNET_CONFIG.AJNA_CONFIG.erc20PoolFactory,
      factory.address
    );
    await sushiTaker.deployed();

    await factory.setTaker(LiquiditySource.SUSHISWAP, sushiTaker.address);

    return { factory, sushiTaker };
  }

  before(async () => {
    await resetHardhat();
    NonceTracker.clearNonces();

    provider = getProvider();
    configureAjna(MAINNET_CONFIG.AJNA_CONFIG);

    const ajna = new AjnaSDK(provider);
    pool = await ajna.fungiblePoolFactory.getPoolByAddress(
      MAINNET_CONFIG.SOL_WETH_POOL.poolConfig.address
    );

    overrideGetLoans(makeGetLoansFromSdk(pool));
    overrideGetLiquidations(makeGetLiquidationsFromSdk(pool));
    overrideGetHighestMeaningfulBucket(makeGetHighestMeaningfulBucket(pool));

    signer = Wallet.fromMnemonic(USER1_MNEMONIC).connect(provider);
    await setBalance(signer.address, utils.parseEther('100').toHexString());

    quoteToken = new Contract(pool.quoteAddress, ERC20_ABI, provider);

    await setupLiquidationScenario();
    snapshotId = await provider.send('evm_snapshot', []);
  });

  beforeEach(async () => {
    await provider.send('evm_revert', [snapshotId]);
    snapshotId = await provider.send('evm_snapshot', []);
    NonceTracker.clearNonces();
  });

  it('rejects a manipulated factory route below the encoded minimum', async () => {
    const { factory } = await deployFactorySystem();
    const liquidationStatus = await pool.getLiquidation(borrower).getStatus();
    const quoteScale = await pool.contract.quoteTokenScale();
    const quoteAmountDueRaw = computeQuoteAmountDueRaw(
      liquidationStatus.collateral,
      liquidationStatus.price,
      quoteScale
    );
    const quotedAmountRaw = quoteAmountDueRaw.mul(120).div(100);
    const manipulatedOutputRaw = quoteAmountDueRaw.mul(110).div(100);

    const mockRouter = await new MockSushiSwapRouter__factory(signer).deploy(
      manipulatedOutputRaw
    );
    await mockRouter.deployed();

    const quoteWhale = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress
    );
    await setBalance(
      MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress,
      utils.parseEther('100').toHexString()
    );
    await quoteToken
      .connect(quoteWhale)
      .transfer(mockRouter.address, quotedAmountRaw.mul(2));

    const expectedAmountOutMinimum = await computeFactoryAmountOutMinimum({
      pool,
      liquidation: {
        collateral: liquidationStatus.collateral,
        auctionPrice: liquidationStatus.price,
      },
      quoteEvaluation: {
        isTakeable: true,
        quoteAmountRaw: quotedAmountRaw,
      },
      liquiditySource: LiquiditySource.SUSHISWAP,
      config: {
        sushiswapRouterOverrides: {
          defaultSlippage: 1.0,
        },
      },
      marketPriceFactor: 0.95,
    });

    expect(manipulatedOutputRaw.gt(quoteAmountDueRaw)).to.be.true;
    expect(manipulatedOutputRaw.lt(expectedAmountOutMinimum)).to.be.true;

    const initialQuoteBalance = await quoteToken.balanceOf(signer.address);

    await takeLiquidationFactory({
      pool,
      poolConfig: {
        name: MAINNET_CONFIG.SOL_WETH_POOL.poolConfig.name,
        take: {
          liquiditySource: LiquiditySource.SUSHISWAP,
          marketPriceFactor: 0.95,
        },
      } as any,
      signer,
      liquidation: {
        borrower,
        hpbIndex: 0,
        collateral: liquidationStatus.collateral,
        auctionPrice: liquidationStatus.price,
        isTakeable: true,
        isArbTakeable: false,
        externalTakeQuoteEvaluation: {
          isTakeable: true,
          quoteAmountRaw: quotedAmountRaw,
          quoteAmount: Number(utils.formatEther(quotedAmountRaw)),
          collateralAmount: Number(utils.formatEther(liquidationStatus.collateral)),
        },
      },
      config: {
        dryRun: false,
        keeperTakerFactory: factory.address,
        sushiswapRouterOverrides: {
          swapRouterAddress: mockRouter.address,
          defaultFeeTier: 500,
          defaultSlippage: 1.0,
        },
      },
    });

    const finalQuoteBalance = await quoteToken.balanceOf(signer.address);
    const finalLiquidation = await pool.getLiquidation(borrower).getStatus();

    expect(finalQuoteBalance.eq(initialQuoteBalance)).to.be.true;
    expect(finalLiquidation.collateral.eq(liquidationStatus.collateral)).to.be.true;
  });

  it('would still clear with the legacy weak minimum of one wei', async () => {
    const { factory } = await deployFactorySystem();
    const liquidationStatus = await pool.getLiquidation(borrower).getStatus();
    const quoteScale = await pool.contract.quoteTokenScale();
    const quoteAmountDueRaw = computeQuoteAmountDueRaw(
      liquidationStatus.collateral,
      liquidationStatus.price,
      quoteScale
    );
    const manipulatedOutputRaw = quoteAmountDueRaw.mul(110).div(100);

    const mockRouter = await new MockSushiSwapRouter__factory(signer).deploy(
      manipulatedOutputRaw
    );
    await mockRouter.deployed();

    const quoteWhale = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress
    );
    await setBalance(
      MAINNET_CONFIG.SOL_WETH_POOL.quoteWhaleAddress,
      utils.parseEther('100').toHexString()
    );
    await quoteToken
      .connect(quoteWhale)
      .transfer(mockRouter.address, manipulatedOutputRaw.mul(2));

    const initialQuoteBalance = await quoteToken.balanceOf(signer.address);
    const deadline = await getChainDeadline(provider);
    const weakSwapDetails = ethers.utils.defaultAbiCoder.encode(
      ['uint24', 'uint256', 'uint256'],
      [500, BigNumber.from(1), deadline]
    );

    const tx = await factory.takeWithAtomicSwap(
      pool.poolAddress,
      borrower,
      liquidationStatus.price,
      liquidationStatus.collateral,
      LiquiditySource.SUSHISWAP,
      mockRouter.address,
      weakSwapDetails
    );
    await tx.wait();

    const finalQuoteBalance = await quoteToken.balanceOf(signer.address);
    const finalLiquidation = await pool.getLiquidation(borrower).getStatus();

    expect(finalQuoteBalance.gt(initialQuoteBalance)).to.be.true;
    expect(finalLiquidation.collateral.lt(liquidationStatus.collateral)).to.be.true;
  });
});
