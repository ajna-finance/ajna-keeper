import { ethers } from 'ethers';
import { BigNumber } from 'ethers';
// Had to modify ABI plucked from Etherscan to resolve:
// duplicate definition - ETHTransferFailed()
// duplicate definition - InvalidMsgValue()
import genericRouterABI from '../abis/1inch-genericrouter.abi.json';
import {
  AjnaKeeperTaker,
  SwapDescriptionStructOutput,
} from '../../typechain-types/contracts/AjnaKeeperTaker';
import { logger } from '../logging';

export interface SwapCalldata {
  aggregationExecutor: string;
  swapDescription: SwapDescriptionStructOutput;
  encodedCalls: string;
}

export function decodeSwapCalldata(apiResponse: any): SwapCalldata {
  logger.debug('1inch API response received');
  const routerInterface = new ethers.utils.Interface(genericRouterABI);
  const decoded = routerInterface.decodeFunctionData('swap', apiResponse.data);
  return {
    aggregationExecutor: decoded.executor,
    swapDescription: decoded.desc,
    encodedCalls: decoded.data,
  };
}

export function convertSwapApiResponseToDetails(
  apiResponse: any
): AjnaKeeperTaker.OneInchSwapDetailsStruct {
  const swapCalldata: SwapCalldata = decodeSwapCalldata(apiResponse);
  logger.debug(
    `1inch swap decoded: executor=${swapCalldata.aggregationExecutor.slice(0, 10)}`
  );
  return {
    aggregationExecutor: swapCalldata.aggregationExecutor,
    swapDescription: swapCalldata.swapDescription,
    opaqueData: swapCalldata.encodedCalls,
  };
}

function normalizeAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    return ethers.utils.getAddress(value).toLowerCase();
  } catch {
    return undefined;
  }
}

function formatAddressValidationError(fieldName: string): string {
  return `1inch swap description ${fieldName} is not a valid address`;
}

export function validateOneInchSwapDetailsForAtomicTake(
  details: AjnaKeeperTaker.OneInchSwapDetailsStruct,
  expected: {
    srcToken: string;
    dstToken: string;
    dstReceiver: string;
    amount: BigNumber;
  }
): string | undefined {
  const desc = details.swapDescription;
  const expectedSrcToken = normalizeAddress(expected.srcToken);
  const actualSrcToken = normalizeAddress(desc.srcToken);
  if (!expectedSrcToken || !actualSrcToken) {
    return formatAddressValidationError('srcToken');
  }
  if (actualSrcToken !== expectedSrcToken) {
    return `1inch swap description srcToken ${desc.srcToken} does not match expected collateral ${expected.srcToken}`;
  }

  const expectedDstToken = normalizeAddress(expected.dstToken);
  const actualDstToken = normalizeAddress(desc.dstToken);
  if (!expectedDstToken || !actualDstToken) {
    return formatAddressValidationError('dstToken');
  }
  if (actualDstToken !== expectedDstToken) {
    return `1inch swap description dstToken ${desc.dstToken} does not match expected quote ${expected.dstToken}`;
  }

  const expectedDstReceiver = normalizeAddress(expected.dstReceiver);
  const actualDstReceiver = normalizeAddress(desc.dstReceiver);
  if (!expectedDstReceiver || !actualDstReceiver) {
    return formatAddressValidationError('dstReceiver');
  }
  if (actualDstReceiver !== expectedDstReceiver) {
    return `1inch swap description dstReceiver ${desc.dstReceiver} does not match keeper taker ${expected.dstReceiver}`;
  }

  let swapAmount: BigNumber;
  try {
    swapAmount = BigNumber.from(desc.amount);
  } catch (error) {
    return `1inch swap description amount is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (swapAmount.lte(0)) {
    return '1inch swap description amount must be greater than 0';
  }
  if (!swapAmount.eq(expected.amount)) {
    return `1inch swap description amount ${swapAmount.toString()} does not match requested collateral amount ${expected.amount.toString()}`;
  }

  return undefined;
}

export function encodeOneInchSwapDetailsBytes(
  details: AjnaKeeperTaker.OneInchSwapDetailsStruct
): string {
  return ethers.utils.defaultAbiCoder.encode(
    [
      '(address,(address,address,address,address,uint256,uint256,uint256),bytes)',
    ],
    [
      [
        details.aggregationExecutor,
        [
          details.swapDescription.srcToken,
          details.swapDescription.dstToken,
          details.swapDescription.srcReceiver,
          details.swapDescription.dstReceiver,
          details.swapDescription.amount,
          details.swapDescription.minReturnAmount,
          details.swapDescription.flags,
        ],
        details.opaqueData,
      ],
    ]
  );
}

export function convertSwapApiResponseToDetailsBytes(apiResponse: any): string {
  const details = convertSwapApiResponseToDetails(apiResponse);
  logger.debug('1inch swap details encoded');
  return encodeOneInchSwapDetailsBytes(details);
}
