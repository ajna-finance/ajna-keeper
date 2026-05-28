import { BigNumber, ethers } from 'ethers';
import { LifiFeeCostPolicy } from '../../config';
import { ApprovedLifiFeeCost, LifiFeeCost } from './schema';

function asFeeCosts(params: {
  value: unknown;
  fieldName: string;
  source: ApprovedLifiFeeCost['source'];
}): Array<LifiFeeCost & { source: ApprovedLifiFeeCost['source'] }> {
  if (params.value === undefined) {
    return [];
  }
  if (!Array.isArray(params.value)) {
    throw new Error(`${params.fieldName} must be an array`);
  }
  return (params.value as LifiFeeCost[]).map((feeCost) => ({
    ...feeCost,
    source: params.source,
  }));
}

function isDecimalInteger(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

export function validateLifiFeeCosts(params: {
  topLevelFeeCosts: unknown;
  feeCollectionStepFeeCosts: unknown;
  executableSwapStepFeeCosts: unknown;
  expectedSourceToken: string;
  expectedOutputToken: string;
  expectedChainId: number;
  expectedSourceTokenFeeRaw?: BigNumber;
  allowSourceTokenFees?: boolean;
  feeCostPolicy: LifiFeeCostPolicy;
}): ApprovedLifiFeeCost[] {
  const feeCosts = [
    ...asFeeCosts({
      value: params.topLevelFeeCosts,
      fieldName: 'LI.FI top-level feeCosts',
      source: 'top_level',
    }),
    ...asFeeCosts({
      value: params.feeCollectionStepFeeCosts,
      fieldName: 'LI.FI included feeCollection step feeCosts',
      source: 'included_fee_collection_step',
    }),
    ...asFeeCosts({
      value: params.executableSwapStepFeeCosts,
      fieldName: 'LI.FI included executable swap step feeCosts',
      source: 'included_swap_step',
    }),
  ];

  if (params.feeCostPolicy === 'reject_all' && feeCosts.length > 0) {
    throw new Error(
      'LI.FI feeCosts are not allowed by feeCostPolicy=reject_all'
    );
  }

  const expectedSourceToken = ethers.utils
    .getAddress(params.expectedSourceToken)
    .toLowerCase();
  const expectedOutputToken = ethers.utils
    .getAddress(params.expectedOutputToken)
    .toLowerCase();
  const expectedSourceTokenFeeRaw = params.expectedSourceTokenFeeRaw;
  const approvedFeeCosts: ApprovedLifiFeeCost[] = [];
  for (const feeCost of feeCosts) {
    if (feeCost.included !== true) {
      throw new Error('LI.FI feeCosts must be included in toAmountMin');
    }
    if (!isDecimalInteger(feeCost.amount)) {
      throw new Error('LI.FI feeCosts amount must be a decimal integer string');
    }
    const tokenAddress = feeCost.token?.address;
    if (
      typeof tokenAddress !== 'string' ||
      !ethers.utils.isAddress(tokenAddress)
    ) {
      throw new Error('LI.FI feeCosts token address is invalid');
    }
    const normalizedToken = ethers.utils.getAddress(tokenAddress).toLowerCase();
    const tokenChainId = feeCost.token?.chainId;
    if (
      tokenChainId !== undefined &&
      (typeof tokenChainId !== 'number' ||
        !Number.isInteger(tokenChainId) ||
        tokenChainId <= 0)
    ) {
      throw new Error(
        'LI.FI feeCosts token chainId must be a positive integer'
      );
    }
    if (tokenChainId !== undefined && tokenChainId !== params.expectedChainId) {
      throw new Error('LI.FI feeCosts token chainId mismatch');
    }
    const isOutputToken = normalizedToken === expectedOutputToken;
    const isAllowedSourceToken =
      params.allowSourceTokenFees === true &&
      expectedSourceTokenFeeRaw !== undefined &&
      normalizedToken === expectedSourceToken &&
      (feeCost.source === 'top_level' ||
        feeCost.source === 'included_fee_collection_step');
    if (!isOutputToken && !isAllowedSourceToken) {
      throw new Error(
        'LI.FI feeCosts must be charged in the expected output token or approved source-token feeCollection metadata for included_only policy'
      );
    }
    if (
      isAllowedSourceToken &&
      !BigNumber.from(feeCost.amount).eq(expectedSourceTokenFeeRaw)
    ) {
      throw new Error(
        'LI.FI source-token feeCosts amount must match feeCollection source-token delta'
      );
    }
    approvedFeeCosts.push({
      source: feeCost.source,
      token: ethers.utils.getAddress(tokenAddress),
      amount: feeCost.amount,
      included: true,
      ...(typeof feeCost.name === 'string' ? { name: feeCost.name } : {}),
    });
  }
  return approvedFeeCosts;
}
