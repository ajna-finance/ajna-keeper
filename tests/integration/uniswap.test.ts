import { Token } from '@uniswap/sdk-core';
import IUniswapV3PoolABI from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import { abi as UniswapABI } from '@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json';
import { FeeAmount, Pool as UniswapV3Pool } from '@uniswap/v3-sdk';
import { Contract, ethers, Signer } from 'ethers';
import ERC20_ABI from '../../src/abis/erc20.abi.json';
import { MAINNET_CONFIG } from './test-config';
import {
  getProvider,
  impersonateSigner,
  resetHardhat,
  setBalance,
} from './test-utils';
import { addLiquidity } from './uniswap-helpers';
import { expect } from 'chai';
import sinon from 'sinon';
import { getPoolInfo, swapToWeth } from '../../src/dex/uniswap';
import { getBalanceOfErc20 } from '../../src/erc20';
import { NonceTracker } from '../../src/nonce';

const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const NONFUNGIBLE_POSITION_MANAGER_ADDRESS =
  '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

let uniswapRouter: Contract;

describe('Uniswap V3 Integration Tests', function () {
  let wbtcSigner: Signer;
  let wethSigner: Signer;
  let wbtcSignerAddress: string;
  let wethSignerAddress: string;

  before(async () => {
    await resetHardhat();

    // Impersonate signers
    wbtcSigner = await impersonateSigner(
      MAINNET_CONFIG.WBTC_USDC_POOL.collateralWhaleAddress
    );
    wethSigner = await impersonateSigner(
      MAINNET_CONFIG.SOL_WETH_POOL.collateralWhaleAddress
    );
    wbtcSignerAddress = await wbtcSigner.getAddress();
    wethSignerAddress = await wethSigner.getAddress();

    // Add balance to signers
    await setBalance(wbtcSignerAddress, '0x10000000000000000000000000');
    await setBalance(wethSignerAddress, '0x10000000000000000000000000');

    uniswapRouter = new Contract(UNISWAP_V3_ROUTER, UniswapABI, wbtcSigner);
  });

  it('Should add liquidity to the pool', async function () {
    // Add liquidity to pool, (only for testing purposes)
    const wbtcContract = new Contract(
      MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress,
      ERC20_ABI,
      wbtcSigner
    );
    const wethContract = new Contract(
      MAINNET_CONFIG.SOL_WETH_POOL.quoteAddress,
      ERC20_ABI,
      wethSigner
    );

    const amountToSend = ethers.utils.parseUnits('100', 18);
    const approveTx = await wethContract
      .connect(wethSigner)
      .approve(wbtcSignerAddress, amountToSend);
    await approveTx.wait();

    const tx = await wethContract
      .connect(wethSigner)
      .transfer(wbtcSignerAddress, amountToSend, { gasLimit: 100000 });
    await tx.wait();

    await wbtcContract
      .connect(wbtcSigner)
      .approve(
        NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
        ethers.utils.parseUnits('1', 8),
        { gasLimit: 3000000 }
      );
    await wethContract
      .connect(wbtcSigner)
      .approve(
        NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
        ethers.utils.parseUnits('20', 18),
        { gasLimit: 3000000 }
      );

    const status = await addLiquidity({
      signer: wbtcSigner,
      tokenA: wbtcContract,
      tokenB: wethContract,
      amountA: ethers.utils.parseUnits('1', 8),
      amountB: ethers.utils.parseUnits('20', 18),
      fee: FeeAmount.MEDIUM,
    });

    expect(status).to.equal(1);
  });

  it('Should fetch pool info correctly', async function () {
    const provider = getProvider();
    const chainId = (await provider.getNetwork()).chainId;

    const wbtctoken = new Token(
      chainId,
      MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress,
      8,
      'WBTC',
      'Wrapped Bitcoin'
    );

    const wethToken = new Token(
      chainId,
      MAINNET_CONFIG.SOL_WETH_POOL.quoteAddress,
      18,
      'WETH',
      'Wrapped Ether'
    );

    const poolAddress = UniswapV3Pool.getAddress(
      wbtctoken,
      wethToken,
      FeeAmount.MEDIUM
    );

    const poolContract = new Contract(
      poolAddress,
      IUniswapV3PoolABI.abi,
      provider
    );

    const poolInfoFromApi = await getPoolInfo(poolContract);

    const { liquidity, sqrtPriceX96, tick } = poolInfoFromApi;

    expect(liquidity.toString()).to.equal('42631052882170131');
    expect(sqrtPriceX96.toString()).to.equal(
      '45439762258452960921888508325218226'
    );
    expect(tick.toString()).to.equal('265204');
  });

  it('Should perform a swap on Uniswap V3', async function () {
    const provider = getProvider();
    const chainId = (await provider.getNetwork()).chainId;

    const wbtcToken = new Token(
      chainId,
      MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress,
      8,
      'WBTC',
      'Wrapped Bitcoin'
    );

    const tokenToSwapBalanceBefore = await getBalanceOfErc20(
      wbtcSigner,
      MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress
    );
    const wethBalanceBefore = await getBalanceOfErc20(
      wbtcSigner,
      MAINNET_CONFIG.WETH_ADDRESS
    );
    const amountToSwap = ethers.BigNumber.from('10000000');

    await swapToWeth(
      wbtcSigner,
      wbtcToken.address,
      amountToSwap,
      FeeAmount.MEDIUM,
      1,
      {
        wethAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      }
    );

    const tokenToSwapBalanceAfter = await getBalanceOfErc20(
      wbtcSigner,
      MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress
    );
    const wethBalanceAfter = await getBalanceOfErc20(
      wbtcSigner,
      MAINNET_CONFIG.WETH_ADDRESS
    );
    const amountSpent = tokenToSwapBalanceBefore.sub(tokenToSwapBalanceAfter);
    expect(
      amountSpent.eq(amountToSwap),
      'Amount spent should equal the amount to spend'
    ).to.be.true;
    expect(wethBalanceAfter.gt(wethBalanceBefore), 'User should gain WETH').to
      .be.true;
  });

  // P0-5 reward-swap money-safety: pin defect #1 at the real call site by
  // decoding the amountOutMinimum actually submitted to the SwapRouter. The pre-
  // fix legacy path floored it to ~0.01% of the INPUT amount (no MEV protection);
  // the fix derives it from the real output quote * (1 - slippage). We capture
  // the live exactInputSingle calldata (no swap mock — a pass-through spy on
  // queueTransaction just grabs the receipt) and assert the floor is a real
  // fraction of the realized WETH output, in OUTPUT units.
  it('submits an amountOutMinimum derived from the output quote, not the input amount or a near-zero floor', async function () {
    const provider = getProvider();
    const chainId = (await provider.getNetwork()).chainId;
    const wbtcToken = new Token(
      chainId,
      MAINNET_CONFIG.WBTC_USDC_POOL.collateralAddress,
      8,
      'WBTC',
      'Wrapped Bitcoin'
    );

    const realQueue = NonceTracker.queueTransaction.bind(NonceTracker);
    const receipts: any[] = [];
    const queueSpy = sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (s: any, fn: any) => {
        const r = await realQueue(s, fn);
        receipts.push(r);
        return r;
      });

    const wethBalanceBefore = await getBalanceOfErc20(
      wbtcSigner,
      MAINNET_CONFIG.WETH_ADDRESS
    );
    const amountToSwap = ethers.BigNumber.from('10000000'); // 0.1 WBTC (8dp)
    const slippage = 1; // 1%

    try {
      await swapToWeth(
        wbtcSigner,
        wbtcToken.address,
        amountToSwap,
        FeeAmount.MEDIUM,
        slippage,
        {
          wethAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          uniswapV3Router: UNISWAP_V3_ROUTER,
        }
      );
    } finally {
      queueSpy.restore();
    }

    const wethReceived = (
      await getBalanceOfErc20(wbtcSigner, MAINNET_CONFIG.WETH_ADDRESS)
    ).sub(wethBalanceBefore);
    expect(wethReceived.gt(0), 'swap should have produced WETH').to.be.true;

    // Decode the exactInputSingle call among the queued txs (approval txs won't
    // decode against this selector and are skipped).
    const iface = new ethers.utils.Interface(UniswapABI);
    let submittedMinOut: ethers.BigNumber | undefined;
    for (const r of receipts) {
      const tx = await provider.getTransaction(r.transactionHash);
      try {
        const decoded = iface.decodeFunctionData('exactInputSingle', tx.data);
        submittedMinOut = ethers.BigNumber.from(
          decoded.params?.amountOutMinimum ?? decoded[0].amountOutMinimum
        );
        break;
      } catch {
        // not the swap call
      }
    }
    expect(
      submittedMinOut !== undefined,
      'should have decoded an exactInputSingle amountOutMinimum'
    ).to.be.true;
    const minOut = submittedMinOut!;

    // The swap succeeded, so the realized output cleared the floor.
    expect(minOut.lte(wethReceived), 'floor must not exceed realized output').to
      .be.true;
    // >= 90% of the realized WETH proves the floor is the quote*(1-slippage)
    // value (in OUTPUT units), NOT the pre-fix ~0.01%-of-input near-zero floor.
    expect(
      minOut.gte(wethReceived.mul(90).div(100)),
      `amountOutMinimum ${minOut.toString()} should be >= 90% of realized WETH ${wethReceived.toString()} (quote-derived, not near-zero/input-denominated)`
    ).to.be.true;
  });
});
