// src/dex/universal-router.ts
// FIXED: Now mirrors working SushiSwap patterns for decimal handling and conservative approach
import { BigNumber, Signer, ethers, providers } from 'ethers';
import { logger } from '../logging';
import { NonceTracker } from '../nonce';
import { weiToDecimaled, withTimeout } from '../utils';
import { getTokenFromAddress } from './uniswap';
import { deriveSwapMinimumOut } from './swap-min-out';
import { getDecimalsErc20 } from '../erc20';
import { defaultDexContractServices, DexContractServices } from './contracts';

// ABIs
const ERC20_ABI = [
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address token, address owner, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];

const POOL_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// Command constants
const V3_SWAP_EXACT_IN = '0x00';

type TokenDetails = Awaited<ReturnType<typeof getTokenFromAddress>>;

export interface UniversalRouterDeps
  extends Pick<DexContractServices, 'makeContract' | 'getDecimals'> {
  getToken(
    chainId: number,
    provider: providers.Provider,
    tokenAddress: string
  ): Promise<TokenDetails>;
  queueTransaction<T>(
    signer: Signer,
    txFunction: (nonce: number) => Promise<T>
  ): Promise<T>;
  nowMs(): number;
}

export type UniversalRouterSwapResult =
  | {
      success: true;
      kind: 'executed';
      receipt: providers.TransactionReceipt;
    }
  | { success: true; kind: 'noop'; reason: 'identical_tokens' }
  | { success: false; error: string };

export type UniversalRouterSwapper = (
  signer: Signer,
  tokenAddress: string,
  amount: BigNumber,
  targetTokenAddress: string,
  slippageBasisPoints: number,
  universalRouterAddress: string,
  permit2Address: string,
  feeTier: number,
  poolFactoryAddress: string,
  quoterV2Address?: string
) => Promise<UniversalRouterSwapResult>;

const defaultUniversalRouterDeps: UniversalRouterDeps = {
  makeContract: defaultDexContractServices.makeContract,
  getDecimals: getDecimalsErc20,
  getToken: getTokenFromAddress,
  queueTransaction: NonceTracker.queueTransaction,
  nowMs: Date.now,
};

export function createUniversalRouterSwapper(
  deps: Partial<UniversalRouterDeps> = {}
): UniversalRouterSwapper {
  const resolvedDeps: UniversalRouterDeps = {
    ...defaultUniversalRouterDeps,
    ...deps,
  };

  return async function swapWithUniversalRouter(
    signer,
    tokenAddress,
    amount,
    targetTokenAddress,
    slippageBasisPoints,
    universalRouterAddress,
    permit2Address,
    feeTier,
    poolFactoryAddress,
    quoterV2Address
  ) {
    return await swapWithUniversalRouterUsingContracts(
      resolvedDeps,
      signer,
      tokenAddress,
      amount,
      targetTokenAddress,
      slippageBasisPoints,
      universalRouterAddress,
      permit2Address,
      feeTier,
      poolFactoryAddress,
      quoterV2Address
    );
  };
}

/**
 * FIXED: Swaps tokens using Uniswap's Universal Router with proper decimal handling
 * Now mirrors the working SushiSwap patterns for conservative operation
 */
async function swapWithUniversalRouterUsingContracts(
  deps: UniversalRouterDeps,
  signer: Signer,
  tokenAddress: string,
  amount: BigNumber,
  targetTokenAddress: string,
  slippageBasisPoints: number,
  universalRouterAddress: string,
  permit2Address: string,
  feeTier: number,
  poolFactoryAddress: string,
  quoterV2Address?: string
): Promise<UniversalRouterSwapResult> {
  // VALIDATION: Same as SushiSwap with additional factory validation
  if (!universalRouterAddress) {
    throw new Error(
      'Universal Router address must be provided via configuration'
    );
  }
  if (!feeTier) {
    throw new Error('Fee tier must be provided via configuration');
  }
  if (slippageBasisPoints === undefined) {
    throw new Error('Slippage must be provided via configuration');
  }
  if (!permit2Address) {
    throw new Error('Permit2 address must be provided via configuration');
  }
  if (!signer || !tokenAddress || !amount) {
    throw new Error('Invalid parameters provided to swap');
  }
  if (!poolFactoryAddress) {
    throw new Error('poolFactoryAddress must be provided via configuration');
  }

  const provider = signer.provider;
  if (!provider) {
    throw new Error('No provider available, skipping swap');
  }

  const network = await provider.getNetwork();
  const chainId = network.chainId;
  const signerAddress = await signer.getAddress();

  logger.info(`Chain ID: ${chainId}, Signer: ${signerAddress}`);
  logger.info(`Using Universal Router at: ${universalRouterAddress}`);

  // Get token details - FIXED: Proper decimal handling like SushiSwap
  const tokenToSwap = await deps.getToken(chainId, provider, tokenAddress);
  const targetToken = await deps.getToken(
    chainId,
    provider,
    targetTokenAddress
  );

  if (tokenToSwap.address.toLowerCase() === targetToken.address.toLowerCase()) {
    logger.info('Tokens are identical, no swap necessary');
    return { success: true, kind: 'noop', reason: 'identical_tokens' };
  }

  // FIXED: Get actual decimals from contracts (like SushiSwap)
  const inputDecimals = await deps.getDecimals(signer, tokenAddress);
  const outputDecimals = await deps.getDecimals(signer, targetTokenAddress);

  logger.debug(
    `Token decimals: ${tokenToSwap.symbol}=${inputDecimals}, ${targetToken.symbol}=${outputDecimals}`
  );

  // Get contract instances
  const tokenContract = deps.makeContract(tokenAddress, ERC20_ABI, signer);
  const permit2Contract = deps.makeContract(
    permit2Address,
    PERMIT2_ABI,
    signer
  );
  const universalRouter = deps.makeContract(
    universalRouterAddress,
    UNIVERSAL_ROUTER_ABI,
    signer
  );
  const factoryContract = deps.makeContract(
    poolFactoryAddress,
    POOL_FACTORY_ABI,
    provider
  );

  try {
    // STEP 1: Verify pool exists (from SushiSwap production pattern)
    const poolAddress = await factoryContract.getPool(
      tokenAddress,
      targetTokenAddress,
      feeTier
    );
    if (poolAddress === '0x0000000000000000000000000000000000000000') {
      logger.warn(
        `No direct Uniswap pool exists for ${tokenToSwap.symbol}/${targetToken.symbol} with fee ${feeTier}`
      );
      // Continue anyway as Universal Router may find a path through other pools
    } else {
      logger.info(
        `Found Uniswap pool at ${poolAddress} for ${tokenToSwap.symbol}/${targetToken.symbol}`
      );
    }

    // STEP 2: derive amountOutMin from a REAL output quote + operator slippage,
    // and FAIL CLOSED before granting ANY approval. A missing or reverting
    // quoter must abort here, never AFTER a Permit2/router approval is already
    // mined (which would leave a persistent allowance with no swap). The old
    // ordering granted approvals first; surfaced-defects #2: the prior floor was
    // derived from the INPUT amount (wrong units), making the guard illusory.
    if (!quoterV2Address) {
      throw new Error(
        'Universal Router reward swap requires uniswap.quoterV2Address to derive a safe minimum-out from a real output quote; refusing to swap without one (fail closed).'
      );
    }
    const quoter = deps.makeContract(quoterV2Address, QUOTER_V2_ABI, provider);
    const quoteResult = await quoter.callStatic.quoteExactInputSingle({
      tokenIn: tokenAddress,
      tokenOut: targetTokenAddress,
      amountIn: amount,
      fee: feeTier,
      sqrtPriceLimitX96: 0,
    });
    const quotedOut = BigNumber.from(quoteResult.amountOut ?? quoteResult[0]);
    const amountOutMin = deriveSwapMinimumOut({
      expectedOutputRaw: quotedOut,
      slippagePercent: slippageBasisPoints / 100,
    });
    logger.info(
      `Input ${weiToDecimaled(amount, inputDecimals)} ${tokenToSwap.symbol}; quoted out ${weiToDecimaled(quotedOut, outputDecimals)} ${targetToken.symbol}; minOut (${slippageBasisPoints / 100}% slippage) ${weiToDecimaled(amountOutMin, outputDecimals)}`
    );

    // STEP 3: Check and approve Permit2 allowance. MaxUint256 here is the
    // canonical Permit2 pattern: Permit2 is an immutable, audited singleton and
    // the actual pull authority is the BOUNDED per-router allowance + expiration
    // granted in STEP 4 below, not this token->Permit2 approval.
    const permit2Allowance = await tokenContract.allowance(
      signerAddress,
      permit2Address
    );
    logger.info(
      `Current Permit2 allowance: ${weiToDecimaled(permit2Allowance, inputDecimals)} ${tokenToSwap.symbol}`
    );

    if (permit2Allowance.lt(amount)) {
      logger.info(`Approving Permit2 to spend ${tokenToSwap.symbol}`);
      await deps.queueTransaction(signer, async (nonce) => {
        const approveTx = await tokenContract.approve(
          permit2Address,
          ethers.constants.MaxUint256,
          { nonce }
        );
        logger.info(`Permit2 approval transaction sent: ${approveTx.hash}`);
        const receipt = await approveTx.wait();
        logger.info(`Permit2 approval confirmed!`);
        return receipt;
      });
    } else {
      logger.info(
        `Permit2 already has sufficient allowance for ${tokenToSwap.symbol}`
      );
    }

    // STEP 4: Check and approve Universal Router via Permit2 (bounded to `amount`
    // with a 24h expiration — this is the real spend authority).
    const { amount: routerAllowance, expiration } =
      await permit2Contract.allowance(
        tokenAddress,
        signerAddress,
        universalRouterAddress
      );

    logger.info(
      `Current Universal Router allowance via Permit2: ${weiToDecimaled(routerAllowance, inputDecimals)} ${tokenToSwap.symbol} (expires: ${new Date(expiration * 1000).toLocaleString()})`
    );

    const nowSeconds = Math.floor(deps.nowMs() / 1000);
    if (routerAllowance.lt(amount) || expiration <= nowSeconds) {
      logger.info(
        `Approving Universal Router via Permit2 for ${tokenToSwap.symbol}`
      );
      // Set expiration to 24 hours from now
      const newExpiration = nowSeconds + 86400;
      await deps.queueTransaction(signer, async (nonce) => {
        const permit2Tx = await permit2Contract.approve(
          tokenAddress,
          universalRouterAddress,
          amount,
          newExpiration,
          { nonce }
        );
        logger.info(
          `Universal Router approval transaction sent: ${permit2Tx.hash}`
        );
        const receipt = await permit2Tx.wait();
        logger.info(`Universal Router approval confirmed!`);
        return receipt;
      });
    } else {
      logger.info(
        `Universal Router already has sufficient allowance via Permit2 for ${tokenToSwap.symbol}`
      );
    }

    // STEP 5: Prepare the swap command. amountOutMin was derived fail-closed in
    // STEP 2, before any approval was granted.
    logger.debug(
      `Swapping token: ${tokenToSwap.symbol}, amount: ${weiToDecimaled(amount, inputDecimals)} to ${targetToken.symbol}`
    );

    const commands = V3_SWAP_EXACT_IN; // Single command for V3_SWAP_EXACT_IN

    // Encode the path (tokenIn -> fee -> tokenOut)
    const path = ethers.utils.solidityPack(
      ['address', 'uint24', 'address'],
      [tokenAddress, feeTier, targetTokenAddress]
    );

    // Encode the inputs for V3_SWAP_EXACT_IN
    // Parameters: recipient, amountIn, amountOutMin, path, payerIsUser
    const inputs = [
      ethers.utils.defaultAbiCoder.encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        [signerAddress, amount, amountOutMin, path, true] // true means tokens come from msg.sender via Permit2
      ),
    ];

    // STEP 6: Execute the swap (same gas strategy as SushiSwap)
    const deadline = Math.floor(deps.nowMs() / 1000) + 1800; // 30 minutes

    // Get gas price and estimate gas (mirrors SushiSwap pattern)
    const gasPrice = await provider.getGasPrice();
    const highGasPrice = gasPrice.mul(115).div(100); // 15% higher
    logger.info(
      `Using gas price: ${ethers.utils.formatUnits(highGasPrice, 'gwei')} gwei (15% higher than current)`
    );

    // Execute the swap using our queued transaction system (same as SushiSwap)
    const receipt = await deps.queueTransaction<providers.TransactionReceipt>(
      signer,
      async (nonce) => {
        const swapTx = await universalRouter.execute(
          commands,
          inputs,
          deadline,
          {
            nonce,
            gasLimit: 1000000, // Generous gas limit for Universal Router
            gasPrice: highGasPrice,
          }
        );

        logger.info(`Uniswap swap transaction sent: ${swapTx.hash}`);

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
      `Uniswap swap successful for token: ${tokenToSwap.symbol}, amount: ${weiToDecimaled(amount, inputDecimals)} to ${targetToken.symbol}`
    );

    return { success: true, kind: 'executed', receipt };
  } catch (error: any) {
    logger.error(`Uniswap swap failed for token: ${tokenAddress}: ${error}`);
    return { success: false, error: error.toString() };
  }
}

export const swapWithUniversalRouter = createUniversalRouterSwapper();
