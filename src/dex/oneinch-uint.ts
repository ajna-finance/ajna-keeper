import { BigNumber, constants, utils } from 'ethers';
import { getErrorMessage } from '../utils';

export function normalizeAddressForComparison(
  value: unknown
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    return utils.getAddress(value).toLowerCase();
  } catch {
    return undefined;
  }
}

export type OneInchUintParseResult =
  | { success: true; value: BigNumber }
  | { success: false; error: string };

export interface OneInchUintParseOptions {
  fieldName: string;
  allowHexString?: boolean;
  emptyAsZero?: boolean;
  requireString?: boolean;
  invalidStringError?: string;
  invalidNumberError?: string;
  negativeBigNumberError?: string;
}

export function parseOneInchUint(
  value: unknown,
  options: OneInchUintParseOptions
): OneInchUintParseResult {
  const {
    fieldName,
    allowHexString = false,
    emptyAsZero = false,
    requireString = false,
    invalidStringError,
    invalidNumberError,
    negativeBigNumberError,
  } = options;
  const invalidStringMessage =
    invalidStringError ??
    `${fieldName} must be a ${allowHexString ? 'decimal or hex ' : 'decimal '}uint string`;

  if (value === undefined || value === null || value === '') {
    if (emptyAsZero) {
      return { success: true, value: constants.Zero };
    }
    return { success: false, error: invalidStringMessage };
  }

  if (requireString && typeof value !== 'string') {
    return { success: false, error: invalidStringMessage };
  }

  if (BigNumber.isBigNumber(value)) {
    if (value.lt(0)) {
      return {
        success: false,
        error:
          negativeBigNumberError ?? `${fieldName} must be a non-negative uint`,
      };
    }
    if (value.gt(constants.MaxUint256)) {
      return { success: false, error: `${fieldName} exceeds uint256` };
    }
    return { success: true, value };
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return {
        success: false,
        error:
          invalidNumberError ??
          `${fieldName} must be a non-negative safe integer`,
      };
    }
    return { success: true, value: BigNumber.from(value) };
  }

  const stringPattern = allowHexString
    ? /^(0|[1-9]\d*)$|^0x[0-9a-fA-F]+$/
    : /^(0|[1-9]\d*)$/;
  if (typeof value !== 'string' || !stringPattern.test(value)) {
    return { success: false, error: invalidStringMessage };
  }

  try {
    const parsed = BigNumber.from(value);
    if (parsed.gt(constants.MaxUint256)) {
      return { success: false, error: `${fieldName} exceeds uint256` };
    }
    return { success: true, value: parsed };
  } catch (error) {
    return {
      success: false,
      error: `${fieldName} is invalid: ${getErrorMessage(error)}`,
    };
  }
}
