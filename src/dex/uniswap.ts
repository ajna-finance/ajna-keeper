import {
  CurrencyAmount,
  SWAP_ROUTER_02_ADDRESSES,
  V3_CORE_FACTORY_ADDRESSES,
  Token,
  WETH9,
} from '@uniswap/sdk-core';
import IUniswapV3PoolABI from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json';
import { abi as UniswapABI } from '@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json';
import {
  FeeAmount,
  Tick,
  TickListDataProvider,
  TickMath,
  Pool as UniswapV3Pool,
} from '@uniswap/v3-sdk';
import { deriveSwapMinimumOut } from './swap-min-out';
import {
  BigNumber,
  Contract,
  ethers,
  providers,
  Signer,
  constants,
} from 'ethers';
import ERC20_ABI from '../abis/erc20.abi.json';
import { logger } from '../logging';
import { NonceTracker } from '../nonce';
import { weiToDecimaled } from '../utils';
import { approveErc20, getAllowanceOfErc20 } from '../erc20';
import { UniswapV3Overrides } from '../config';

interface PoolInfo {
  sqrtPriceX96: BigNumber;
  liquidity: BigNumber;
  tick: number;
}

const Uniswap = {
  getPoolInfo,
  swapToWeth,
};

export async function getPoolInfo(poolContract: Contract): Promise<PoolInfo> {
  const [liquidity, slot0] = await Promise.all([
    poolContract.liquidity(),
    poolContract.slot0(),
  ]);

  return {
    liquidity: liquidity,
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
  };
}

export async function getWethToken(
  chainId: number,
  provider: providers.Provider,
  overrideAddress?: string
) {
  if (overrideAddress) {
    return await getTokenFromAddress(chainId, provider, overrideAddress);
  } else if (WETH9[chainId]) {
    return WETH9[chainId];
  }
  throw new Error('You must provide an address in the config for wethAddress.');
}

export async function getTokenFromAddress(
  chainId: number,
  provider: providers.Provider,
  tokenAddress: string
) {
  const contract = new Contract(tokenAddress, ERC20_ABI, provider);
  const [symbol, name, decimals] = await Promise.all([
    contract.symbol(),
    contract.name(),
    contract.decimals(),
  ]);
  if (!decimals) {
    throw new Error(
      `Could not get details for token at address: ${tokenAddress}`
    );
  }
  return new Token(chainId, tokenAddress, decimals, symbol, name);
}

export async function swapToWeth(
  signer: Signer,
  tokenAddress: string,
  amount: BigNumber,
  feeAmount: FeeAmount,
  slippagePercent: number,
  uniswapOverrides?: UniswapV3Overrides
) {
  if (!signer || !tokenAddress || !amount) {
    throw new Error('Invalid parameters provided to swapToWeth');
  }
  const provider = signer.provider;
  if (!provider) {
    throw new Error('No provider available, skipping swap');
  }

  const network = await provider.getNetwork();
  const chainId = network.chainId;

  const tokenToSwap = await getTokenFromAddress(
    chainId,
    provider,
    tokenAddress
  );
  const weth = await getWethToken(
    chainId,
    provider,
    uniswapOverrides?.wethAddress
  );
  const uniswapV3Router =
    uniswapOverrides?.uniswapV3Router ?? SWAP_ROUTER_02_ADDRESSES(chainId);
  const v3CoreFactorAddress = V3_CORE_FACTORY_ADDRESSES[chainId];

  if (
    tokenToSwap.symbol === weth.symbol ||
    tokenToSwap.address === weth.address
  ) {
    logger.info('Collected tokens are already WETH, no swap necessary');
    return;
  }

  const currentAllowance = await getAllowanceOfErc20(
    signer,
    tokenAddress,
    uniswapV3Router
  );
  if (currentAllowance.lt(amount)) {
    try {
      logger.debug(`Approving Uniswap for token: ${tokenToSwap.symbol}`);
      await approveErc20(signer, tokenAddress, uniswapV3Router, amount);
      logger.info(
        `Uniswap approval successful for token ${tokenToSwap.symbol}`
      );
    } catch (error) {
      logger.error(
        `Failed to approve Uniswap swap for token: ${tokenToSwap.symbol}.`,
        error
      );
      throw error;
    }
  } else {
    logger.info(`Token ${tokenToSwap.symbol} already has sufficient allowance`);
  }

  const poolAddress = UniswapV3Pool.getAddress(
    tokenToSwap,
    weth,
    feeAmount,
    undefined,
    v3CoreFactorAddress
  );

  const poolContract = new Contract(
    poolAddress,
    IUniswapV3PoolABI.abi,
    provider
  );

  try {
    await poolContract.slot0();
  } catch {
    throw new Error(
      `Pool does not exist for ${tokenToSwap.symbol}/${weth.symbol}, fee: ${feeAmount / 10000}%`
    );
  }

  const poolInfo = await Uniswap.getPoolInfo(poolContract);

  const tickSpacing = await poolContract.tickSpacing();
  const roundTick = Math.round(poolInfo.tick / tickSpacing) * tickSpacing;
  const initialTick = {
    index: roundTick,
    liquidityNet: BigInt(0).toString(),
    liquidityGross: BigInt(0).toString(),
  };
  const ticks = [new Tick(initialTick)];
  const tickDataProvider = new TickListDataProvider(ticks, tickSpacing);

  const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(roundTick);

  const pool = new UniswapV3Pool(
    tokenToSwap,
    weth,
    feeAmount,
    sqrtPriceX96.toString(),
    poolInfo.liquidity.toString(),
    roundTick,
    tickDataProvider
  );

  const inputAmount = CurrencyAmount.fromRawAmount(
    tokenToSwap,
    amount.toString()
  );
  const quote = await pool.getOutputAmount(inputAmount);
  const expectedOutputAmount = quote[0];

  // Derive amountOutMinimum from the QUOTED output and the OPERATOR's slippage
  // (was hardcoded 0.5% + a 0.01%-of-input near-zero floor — surfaced-defects #1).
  const minOut = deriveSwapMinimumOut({
    expectedOutputRaw: BigNumber.from(expectedOutputAmount.quotient.toString()),
    inputRaw: amount,
    slippagePercent,
  });

  const swapRouter = new Contract(uniswapV3Router, UniswapABI, signer);
  const recipient = await signer.getAddress();

  const currentBlock = await provider.getBlock('latest');
  const currentBlockTimestamp = currentBlock.timestamp;

  const signerAddress = await signer.getAddress();

  logger.debug(
    `Swapping to WETH for token: ${tokenToSwap.symbol}, amount: ${weiToDecimaled(amount, tokenToSwap.decimals)}`
  );

  try {
    await NonceTracker.queueTransaction(signer, async (nonce: number) => {
      const tx = await swapRouter.exactInputSingle(
        {
          tokenIn: tokenToSwap.address,
          tokenOut: weth.address,
          fee: feeAmount,
          recipient: recipient,
          deadline: currentBlockTimestamp + 60 * 60 * 60,
          amountIn: amount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: ethers.constants.Zero,
        },
        { nonce: nonce.toString() }
      );
      return await tx.wait();
    });

    logger.info(
      `Swap to WETH successful for token: ${tokenToSwap.symbol}, amount: ${weiToDecimaled(amount, tokenToSwap.decimals)}`
    );
  } catch (error) {
    logger.error(`Swap to WETH failed for token: ${tokenAddress}`, error);
    throw error;
  }
}

export default Uniswap;
