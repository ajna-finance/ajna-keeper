import { BigNumber } from 'ethers';
import { validateLifiQuote } from '../../../src/dex/lifi';
import type { ValidateLifiQuoteParams } from '../../../src/dex/lifi';

export const chainId = 8453;
export const collateral = '0x1111111111111111111111111111111111111111';
export const quoteToken = '0x2222222222222222222222222222222222222222';
export const taker = '0x3333333333333333333333333333333333333333';
export const target = '0x4444444444444444444444444444444444444444';
export const spender = '0x5555555555555555555555555555555555555555';
export const selector = '0xabcdef12';
export const fromAmount = BigNumber.from('1000000');

export function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function action(overrides: Record<string, unknown> = {}) {
  return {
    fromToken: { address: collateral, chainId },
    toToken: { address: quoteToken, chainId },
    fromAmount: fromAmount.toString(),
    fromChainId: chainId,
    toChainId: chainId,
    fromAddress: taker,
    toAddress: taker,
    ...overrides,
  };
}

export function estimate(overrides: Record<string, unknown> = {}) {
  return {
    approvalAddress: spender,
    fromAmount: fromAmount.toString(),
    toAmount: '2000000',
    toAmountMin: '1900000',
    feeCosts: [],
    ...overrides,
  };
}

export function transactionRequest(overrides: Record<string, unknown> = {}) {
  return {
    to: target,
    data: `${selector}00000000`,
    value: '0x0',
    from: taker,
    chainId,
    ...overrides,
  };
}

export function step(overrides: Record<string, unknown> = {}) {
  return {
    type: 'swap',
    tool: 'uniswap',
    action: action(),
    estimate: estimate(),
    ...overrides,
  };
}

export function feeCollectionStep(overrides: Record<string, unknown> = {}) {
  return {
    type: 'protocol',
    tool: 'feeCollection',
    action: {
      fromToken: { address: collateral, chainId },
      toToken: { address: collateral, chainId },
      fromAmount: fromAmount.toString(),
      fromChainId: chainId,
      toChainId: chainId,
      fromAddress: spender,
      toAddress: spender,
    },
    estimate: {
      approvalAddress: '0x7777777777777777777777777777777777777777',
      fromAmount: fromAmount.toString(),
      toAmount: '999000',
      toAmountMin: '999000',
      feeCosts: [
        {
          included: true,
          amount: '1000',
          token: { address: collateral, chainId },
          name: 'LIFI Fixed Fee',
        },
      ],
    },
    ...overrides,
  };
}

export function quote(overrides: Record<string, unknown> = {}) {
  return {
    ...step(),
    includedSteps: [step()],
    transactionRequest: transactionRequest(),
    ...overrides,
  };
}

export function validate(
  candidate: unknown = quote(),
  overrides: Partial<Omit<ValidateLifiQuoteParams, 'quote'>> = {}
) {
  return validateLifiQuote({
    quote: candidate,
    chainId,
    fromToken: collateral,
    toToken: quoteToken,
    fromAmount,
    takerAddress: taker,
    exchangePolicy: { kind: 'concrete_allowlist', filters: { allowExchanges: ['uniswap'] } },
    callTargetAllowlist: [target],
    approvalSpenderAllowlist: [spender],
    selectorAllowlist: {
      [target]: [selector],
    },
    nowMs: 1234,
    ...overrides,
  });
}
