// src/dex/curve-router.ts
// Simplified Curve integration for Base L2 - follows the V3 router-module pattern
import { BigNumber, Signer, providers, ethers } from 'ethers';
import { logger } from '../logging';
import { NonceTracker } from '../nonce';
import { getErrorMessage, weiToDecimaled, withTimeout } from '../utils';
import { getTokenFromAddress } from './uniswap';
import { deriveSwapMinimumOut } from './swap-min-out';
import { defaultDexContractServices, DexContractServices } from './contracts';
import { CurvePoolSelection, getCurvePoolAbi } from './curve-pool-selection';

// ABIs - Based on working test scripts
const ERC20_ABI = [
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

type TokenDetails = Awaited<ReturnType<typeof getTokenFromAddress>>;

export interface CurveRouterDeps
  extends Pick<DexContractServices, 'makeContract'> {
  getToken(
    chainId: number,
    provider: providers.Provider,
    tokenAddress: string
  ): Promise<TokenDetails>;
  queueTransaction<T>(
    signer: Signer,
    txFunction: (nonce: number) => Promise<T>
  ): Promise<T>;
}

export type CurveRouterSwapResult =
  | { success: true; receipt?: providers.TransactionReceipt }
  | { success: false; error: string };

export type CurveRouterSwapper = (
  signer: Signer,
  tokenAddress: string,
  amount: BigNumber,
  targetTokenAddress: string,
  slippagePercentage: number,
  selectedPool: CurvePoolSelection,
  defaultSlippage?: number
) => Promise<CurveRouterSwapResult>;

const defaultCurveRouterDeps: CurveRouterDeps = {
  makeContract: defaultDexContractServices.makeContract,
  getToken: getTokenFromAddress,
  queueTransaction: (signer, txFunction) =>
    NonceTracker.queueTransaction(signer, txFunction),
};

export function createCurveRouterSwapper(
  deps: Partial<CurveRouterDeps> = {}
): CurveRouterSwapper {
  const resolvedDeps: CurveRouterDeps = {
    ...defaultCurveRouterDeps,
    ...deps,
  };

  return async function swapWithCurveRouter(
    signer,
    tokenAddress,
    amount,
    targetTokenAddress,
    slippagePercentage,
    selectedPool,
    defaultSlippage
  ) {
    return await swapWithCurveRouterUsingContracts(
      resolvedDeps,
      signer,
      tokenAddress,
      amount,
      targetTokenAddress,
      slippagePercentage,
      selectedPool,
      defaultSlippage
    );
  };
}

/**
 * Swaps tokens using Curve pools - Simplified for Base L2
 * Based on the V3 router-module pattern and working curve test scripts
 */
async function swapWithCurveRouterUsingContracts(
  deps: CurveRouterDeps,
  signer: Signer,
  tokenAddress: string,
  amount: BigNumber,
  targetTokenAddress: string,
  slippagePercentage: number, // dex-router passes percentage, not basis points
  selectedPool: CurvePoolSelection,
  defaultSlippage?: number
): Promise<CurveRouterSwapResult> {
  // Selections come from CurvePoolSelector with these fields populated; a
  // firing guard indicates a selector/caller bug, not missing configuration.
  const poolAddress = selectedPool?.address;
  const poolType = selectedPool?.poolType;
  if (!poolAddress || !poolType) {
    throw new Error('Curve pool selection is missing address or pool type');
  }
  if (slippagePercentage === undefined) {
    // Fall back to the operator's configured curve defaultSlippage rather than
    // silently dropping it (audit Pass-1: the param was passed but never used).
    if (defaultSlippage === undefined) {
      throw new Error(
        'Slippage must be provided via configuration (per-pool slippage or curve defaultSlippage)'
      );
    }
    slippagePercentage = defaultSlippage;
  }
  if (!signer || !tokenAddress || !amount) {
    throw new Error('Invalid parameters provided to swap');
  }

  const provider = signer.provider;
  if (!provider) {
    throw new Error('No provider available, skipping swap');
  }

  const network = await provider.getNetwork();
  const chainId = network.chainId;
  const signerAddress = await signer.getAddress();

  logger.info(`Chain ID: ${chainId}, Signer: ${signerAddress}`);
  logger.info(`Using Curve pool at: ${poolAddress} (type: ${poolType})`);

  // Get token details - same pattern as SushiSwap
  const tokenToSwap = await deps.getToken(chainId, provider, tokenAddress);
  const targetToken = await deps.getToken(
    chainId,
    provider,
    targetTokenAddress
  );

  if (tokenToSwap.address.toLowerCase() === targetToken.address.toLowerCase()) {
    logger.info('Tokens are identical, no swap necessary');
    return { success: true };
  }

  // Get contract instances with ABI selection based on pool type
  const tokenContract = deps.makeContract(tokenAddress, ERC20_ABI, signer);
  const poolContract = deps.makeContract(
    poolAddress,
    getCurvePoolAbi(poolType),
    signer
  );

  try {
    const { tokenInIndex, tokenOutIndex } = selectedPool;

    logger.info(
      `Found token indices: ${tokenToSwap.symbol}@${tokenInIndex}, ${targetToken.symbol}@${tokenOutIndex}`
    );

    // STEP 2: Get quote using pool-specific ABI (pattern from test scripts)
    logger.info(
      `Requesting quote for ${weiToDecimaled(amount, tokenToSwap.decimals)} ${tokenToSwap.symbol}...`
    );

    const minAmountOut: BigNumber = await poolContract.get_dy(
      tokenInIndex,
      tokenOutIndex,
      amount
    );

    const minAmountOutFormatted = weiToDecimaled(
      minAmountOut,
      targetToken.decimals
    );

    // STEP 3: derive the output floor from the get_dy quote + operator slippage
    // via the shared helper, so a zero/degenerate quote fails closed and the
    // slippage is range-checked (parity with the Uniswap/Universal Router reward
    // paths — surfaced-defects #1/#2 siblings).
    const minAmountOutWithSlippage = deriveSwapMinimumOut({
      expectedOutputRaw: minAmountOut,
      slippagePercent: slippagePercentage,
    });
    const minAmountOutWithSlippageFormatted = weiToDecimaled(
      minAmountOutWithSlippage,
      targetToken.decimals
    );

    logger.info(
      `Quote received: ~${minAmountOutFormatted} ${targetToken.symbol}`
    );
    logger.info(
      `Minimum output with ${slippagePercentage}% slippage: ${minAmountOutWithSlippageFormatted} ${targetToken.symbol}`
    );

    // STEP 4: Approve token spending (same pattern as SushiSwap, simplified for L2)
    const currentAllowance = await tokenContract.allowance(
      signerAddress,
      poolAddress
    );
    logger.info(
      `Current Curve pool allowance: ${weiToDecimaled(currentAllowance, tokenToSwap.decimals)} ${tokenToSwap.symbol}`
    );

    if (!currentAllowance.eq(amount)) {
      logger.info(`Approving Curve pool to spend ${tokenToSwap.symbol}`);
      // Reconcile the allowance to EXACTLY `amount` whenever it differs — both
      // when it is too LOW and when a prior swap that did not pull left a stale
      // LARGER allowance to this untrusted pool (Codex Pass-3 MEDIUM: the old
      // `lt(amount)` guard skipped the over-allowance case). USDT-safe:
      // approval-strict tokens revert on a non-zero -> non-zero approve, so reset
      // a residual non-zero allowance to 0 first. Mirrors the take-path
      // _safeApproveWithReset (audit Pass-2/3 / Codex).
      if (currentAllowance.gt(0)) {
        await deps.queueTransaction(signer, async (nonce) => {
          const resetTx = await tokenContract.approve(poolAddress, 0, {
            nonce,
          });
          const receipt = await resetTx.wait();
          logger.info(`Curve allowance reset to 0 before re-approval`);
          return receipt;
        });
      }
      await deps.queueTransaction(signer, async (nonce) => {
        // Bound the approval to the exact swap `amount` rather than MaxUint256:
        // the configured Curve pool is NOT a trusted singleton, and the
        // exact-input exchange() pulls exactly `amount`, so this leaves ~0
        // residual allowance instead of a persistent unlimited one
        // (audit defect #5 / Codex Pass-1 MEDIUM).
        const approveTx = await tokenContract.approve(poolAddress, amount, {
          nonce,
        });
        logger.info(`Curve approval transaction sent: ${approveTx.hash}`);
        const receipt = await approveTx.wait();
        logger.info(`Curve approval confirmed!`);
        return receipt;
      });
    } else {
      logger.info(
        `Curve pool already approved for exactly the ${tokenToSwap.symbol} swap amount`
      );
    }

    // STEP 5: Execute swap with pool-specific parameters (pattern from test scripts)
    logger.info(`Executing swap on Curve ${poolType} pool...`);

    // Gas pricing strategy (same as SushiSwap)
    const gasPrice = await provider.getGasPrice();
    const highGasPrice = gasPrice.mul(115).div(100); // 15% higher
    logger.info(
      `Using gas price: ${ethers.utils.formatUnits(highGasPrice, 'gwei')} gwei (15% higher than current)`
    );

    // Execute swap using NonceTracker (same pattern as SushiSwap)
    const receipt = await deps.queueTransaction<providers.TransactionReceipt>(
      signer,
      async (nonce) => {
        const swapTx = await poolContract.exchange(
          tokenInIndex,
          tokenOutIndex,
          amount,
          minAmountOutWithSlippage,
          {
            nonce,
            gasLimit: 800000,
            gasPrice: highGasPrice,
          }
        );

        logger.info(`Curve transaction sent: ${swapTx.hash}`);

        logger.info(`Waiting for transaction confirmation...`);
        return await withTimeout<providers.TransactionReceipt>(
          swapTx.wait(),
          120000,
          'Transaction confirmation'
        );
      }
    );

    logger.info(`Transaction confirmed: ${receipt.transactionHash}`);
    logger.info(`Gas used: ${receipt.gasUsed.toString()}`);
    logger.info(
      `Curve swap successful for token: ${tokenToSwap.symbol}, amount: ${weiToDecimaled(amount, tokenToSwap.decimals)} to ${targetToken.symbol}`
    );

    return { success: true, receipt };
  } catch (error: unknown) {
    logger.error(`Curve swap failed for token: ${tokenAddress}: ${error}`);
    return { success: false, error: getErrorMessage(error) };
  }
}

export const swapWithCurveRouter = createCurveRouterSwapper();
