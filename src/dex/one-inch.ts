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

const ONE_INCH_ATOMIC_TAKE_ALLOWED_FLAGS = BigNumber.from(0);

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

function parseOneInchSwapDescriptionUint(
  value: unknown,
  fieldName: string
): { value?: BigNumber; error?: string } {
  if (BigNumber.isBigNumber(value)) {
    if (value.lt(0)) {
      return {
        error: `1inch swap description ${fieldName} is invalid: expected non-negative uint`,
      };
    }
    if (value.gt(ethers.constants.MaxUint256)) {
      return {
        error: `1inch swap description ${fieldName} exceeds uint256`,
      };
    }
    return { value };
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return {
        error: `1inch swap description ${fieldName} is invalid: expected non-negative safe integer`,
      };
    }
    return { value: BigNumber.from(value) };
  }

  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d*)$|^0x[0-9a-fA-F]+$/.test(value)
  ) {
    return {
      error: `1inch swap description ${fieldName} is invalid: expected decimal or hex uint string`,
    };
  }

  try {
    const parsed = BigNumber.from(value);
    if (parsed.gt(ethers.constants.MaxUint256)) {
      return {
        error: `1inch swap description ${fieldName} exceeds uint256`,
      };
    }
    return { value: parsed };
  } catch (error) {
    return {
      error: `1inch swap description ${fieldName} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function validateOneInchSwapDetailsForAtomicTake(
  details: AjnaKeeperTaker.OneInchSwapDetailsStruct,
  expected: {
    srcToken: string;
    dstToken: string;
    srcReceiver: string;
    dstReceiver: string;
    amount: BigNumber;
    // undefined means permissive monitoring mode; [] is an explicit deny-all
    // and returns a clear validation error if programmatic config bypasses schema validation.
    aggregationExecutors?: string[];
  }
): string | undefined {
  const desc = details.swapDescription;
  const aggregationExecutor = normalizeAddress(details.aggregationExecutor);
  if (!aggregationExecutor) {
    return '1inch aggregationExecutor is not a valid address';
  }
  if (aggregationExecutor === ethers.constants.AddressZero.toLowerCase()) {
    return '1inch aggregationExecutor cannot be the zero address';
  }
  if (expected.aggregationExecutors !== undefined) {
    if (expected.aggregationExecutors.length === 0) {
      return '1inch aggregationExecutor allowlist is empty';
    }
    const allowedAggregationExecutors = new Set<string>();
    for (const executor of expected.aggregationExecutors) {
      const normalizedExecutor = normalizeAddress(executor);
      if (!normalizedExecutor) {
        return `configured 1inch aggregationExecutor allowlist contains invalid address ${executor}`;
      }
      allowedAggregationExecutors.add(normalizedExecutor);
    }
    if (!allowedAggregationExecutors.has(aggregationExecutor)) {
      return `1inch aggregationExecutor ${details.aggregationExecutor} is not in the configured allowlist`;
    }
  }

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

  const expectedSrcReceiver = normalizeAddress(expected.srcReceiver);
  const actualSrcReceiver = normalizeAddress(desc.srcReceiver);
  if (!expectedSrcReceiver || !actualSrcReceiver) {
    return formatAddressValidationError('srcReceiver');
  }
  if (
    actualSrcReceiver !== expectedSrcReceiver &&
    actualSrcReceiver !== aggregationExecutor
  ) {
    return `1inch swap description srcReceiver ${desc.srcReceiver} does not match configured router ${expected.srcReceiver} or aggregationExecutor ${details.aggregationExecutor}`;
  }

  const expectedDstReceiver = normalizeAddress(expected.dstReceiver);
  const actualDstReceiver = normalizeAddress(desc.dstReceiver);
  if (!expectedDstReceiver || !actualDstReceiver) {
    return formatAddressValidationError('dstReceiver');
  }
  if (actualDstReceiver !== expectedDstReceiver) {
    return `1inch swap description dstReceiver ${desc.dstReceiver} does not match keeper taker ${expected.dstReceiver}`;
  }

  const parsedSwapAmount = parseOneInchSwapDescriptionUint(
    desc.amount,
    'amount'
  );
  if (!parsedSwapAmount.value) {
    return parsedSwapAmount.error;
  }
  const swapAmount = parsedSwapAmount.value;
  if (swapAmount.lte(0)) {
    return '1inch swap description amount must be greater than 0';
  }
  if (!swapAmount.eq(expected.amount)) {
    return `1inch swap description amount ${swapAmount.toString()} does not match requested collateral amount ${expected.amount.toString()}`;
  }

  const parsedMinReturnAmount = parseOneInchSwapDescriptionUint(
    desc.minReturnAmount,
    'minReturnAmount'
  );
  if (!parsedMinReturnAmount.value) {
    return parsedMinReturnAmount.error;
  }
  const minReturnAmount = parsedMinReturnAmount.value;
  if (minReturnAmount.lte(0)) {
    return '1inch swap description minReturnAmount must be greater than 0';
  }

  const parsedFlags = parseOneInchSwapDescriptionUint(desc.flags, 'flags');
  if (!parsedFlags.value) {
    return parsedFlags.error;
  }
  const flags = parsedFlags.value;
  if (!flags.eq(ONE_INCH_ATOMIC_TAKE_ALLOWED_FLAGS)) {
    return `1inch swap description flags ${flags.toString()} are not supported for atomic takes`;
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
