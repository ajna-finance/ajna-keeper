import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import {
  buildLifiQuoteUrl,
  normalizeLifiSelectorAllowlistRecord,
  validateLifiQuote,
} from '../../src/dex/lifi';
import currentSameChainFeeCollectionFixture from '../../src/dex/lifi/fixtures/current-same-chain-fee-collection.json';

describe('LI.FI quote validation', () => {
  const chainId = 8453;
  const collateral = '0x1111111111111111111111111111111111111111';
  const quoteToken = '0x2222222222222222222222222222222222222222';
  const taker = '0x3333333333333333333333333333333333333333';
  const target = '0x4444444444444444444444444444444444444444';
  const spender = '0x5555555555555555555555555555555555555555';
  const selector = '0xabcdef12';
  const fromAmount = BigNumber.from('1000000');

  function cloneFixture<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function action(overrides: Record<string, unknown> = {}) {
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

  function estimate(overrides: Record<string, unknown> = {}) {
    return {
      approvalAddress: spender,
      fromAmount: fromAmount.toString(),
      toAmount: '2000000',
      toAmountMin: '1900000',
      feeCosts: [],
      ...overrides,
    };
  }

  function transactionRequest(overrides: Record<string, unknown> = {}) {
    return {
      to: target,
      data: `${selector}00000000`,
      value: '0x0',
      from: taker,
      chainId,
      ...overrides,
    };
  }

  function step(overrides: Record<string, unknown> = {}) {
    return {
      type: 'swap',
      tool: 'uniswap',
      action: action(),
      estimate: estimate(),
      ...overrides,
    };
  }

  function feeCollectionStep(overrides: Record<string, unknown> = {}) {
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

  function quote(overrides: Record<string, unknown> = {}) {
    return {
      ...step(),
      includedSteps: [step()],
      transactionRequest: transactionRequest(),
      ...overrides,
    };
  }

  function validate(candidate: unknown = quote()) {
    return validateLifiQuote({
      quote: candidate,
      chainId,
      fromToken: collateral,
      toToken: quoteToken,
      fromAmount,
      takerAddress: taker,
      allowedExchangeTools: ['uniswap'],
      callTargetAllowlist: [target],
      approvalSpenderAllowlist: [spender],
      selectorAllowlist: {
        [target]: [selector],
      },
      nowMs: 1234,
    });
  }

  it('accepts a same-chain swap with allowlisted target, spender, and selector', () => {
    const approved = validate();

    expect(approved.quoteAmountRaw.toString()).to.equal('2000000');
    expect(approved.routeMinOutRaw.toString()).to.equal('1900000');
    expect(approved.amountInTokenUnits.toString()).to.equal(
      fromAmount.toString()
    );
    expect(approved.srcToken).to.equal(collateral);
    expect(approved.dstToken).to.equal(quoteToken);
    expect(approved.dstReceiver).to.equal(taker);
    expect(approved.transactionTarget).to.equal(target);
    expect(approved.approvalSpender).to.equal(spender);
    expect(approved.selector).to.equal(selector);
    expect(approved.tool).to.equal('uniswap');
    expect(approved.quotedAtMs).to.equal(1234);
  });

  it('accepts a lifi wrapper around one same-chain included swap', () => {
    const approved = validate(
      quote({
        type: 'lifi',
        tool: 'lifi',
      })
    );

    expect(approved.topLevelTool).to.equal('lifi');
    expect(approved.tool).to.equal('uniswap');
  });

  it('accepts current LI.FI same-chain shape with source-token feeCollection metadata', () => {
    const approved = validate(
      cloneFixture(currentSameChainFeeCollectionFixture)
    );

    expect(approved.topLevelTool).to.equal('uniswap');
    expect(approved.tool).to.equal('uniswap');
    expect(approved.feeCosts).to.deep.equal([
      {
        source: 'top_level',
        token: collateral,
        amount: '1000',
        included: true,
        name: 'LIFI Fixed Fee',
      },
      {
        source: 'included_fee_collection_step',
        token: collateral,
        amount: '1000',
        included: true,
        name: 'LIFI Fixed Fee',
      },
    ]);
  });

  it('rejects source-token fee costs that do not match the feeCollection source-token delta', () => {
    const candidate = cloneFixture(currentSameChainFeeCollectionFixture);
    candidate.estimate.feeCosts[0].amount = '999';

    expect(() => validate(candidate)).to.throw(
      'LI.FI source-token feeCosts amount must match feeCollection source-token delta'
    );
  });

  it('rejects lifi wrappers with unexpected top-level tools', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'protocol',
        })
      )
    ).to.throw('LI.FI quote.tool is not allowlisted');
  });

  it('rejects lifi wrappers without an explicit non-empty top-level tool', () => {
    for (const tool of [undefined, '   ']) {
      expect(() =>
        validate(
          quote({
            type: 'lifi',
            tool,
          })
        )
      ).to.throw('LI.FI quote.tool must be a non-empty string');
    }
  });

  it('rejects top-level steps that are not same-chain swaps or reviewed lifi wrappers', () => {
    expect(() =>
      validate(
        quote({
          type: 'cross',
        })
      )
    ).to.throw('LI.FI quote type must be swap or lifi');

    expect(() =>
      validate(
        quote({
          type: 'protocol',
          tool: 'feeCollection',
        })
      )
    ).to.throw('LI.FI quote type must be swap or lifi');
  });

  it('rejects lifi wrappers with zero included steps', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'lifi',
          includedSteps: [],
        })
      )
    ).to.throw(
      'LI.FI quote.includedSteps must contain one swap step and optional feeCollection step'
    );
  });

  it('rejects routes with multiple included steps', () => {
    expect(() =>
      validate(
        quote({
          includedSteps: [step(), step()],
        })
      )
    ).to.throw(
      'LI.FI quote.includedSteps must contain one swap step and optional feeCollection step'
    );
  });

  it('rejects included cross or unsupported protocol executable steps', () => {
    expect(() =>
      validate(
        quote({
          includedSteps: [step({ type: 'cross' })],
        })
      )
    ).to.throw('LI.FI included swap step.type must be swap');

    expect(() =>
      validate(
        quote({
          includedSteps: [step({ type: 'protocol', tool: 'customProtocol' })],
        })
      )
    ).to.throw('LI.FI included swap step.type must be swap');
  });

  it('rejects feeCollection steps outside the approved leading position', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'lifi',
          includedSteps: [step(), feeCollectionStep()],
        })
      )
    ).to.throw(
      'LI.FI quote.includedSteps must contain one swap step and optional feeCollection step'
    );
  });

  it('rejects included steps with nested includedSteps metadata', () => {
    expect(() =>
      validate(
        quote({
          includedSteps: [step({ includedSteps: [step()] })],
        })
      )
    ).to.throw('LI.FI quote.includedSteps[0] cannot contain nested steps');
  });

  it('rejects nonzero native value calldata', () => {
    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({ value: '1' }),
        })
      )
    ).to.throw('LI.FI transactionRequest.value must be zero');
  });

  it('rejects native-token placeholders for route assets', () => {
    const nativePlaceholder = '0x0000000000000000000000000000000000000000';

    expect(() =>
      validate(
        quote({
          action: action({
            fromToken: { address: nativePlaceholder, chainId },
          }),
        })
      )
    ).to.throw(
      'LI.FI quote.action.fromToken.address cannot be native token placeholder'
    );
    expect(() =>
      validate(
        quote({
          action: action({
            toToken: { address: nativePlaceholder, chainId },
          }),
        })
      )
    ).to.throw(
      'LI.FI quote.action.toToken.address cannot be native token placeholder'
    );
  });

  it('rejects route token address mismatches', () => {
    const otherToken = '0x6666666666666666666666666666666666666666';

    expect(() =>
      validate(
        quote({
          action: action({
            fromToken: { address: otherToken, chainId },
          }),
        })
      )
    ).to.throw('LI.FI quote.action.fromToken.address mismatch');

    expect(() =>
      validate(
        quote({
          action: action({
            toToken: { address: otherToken, chainId },
          }),
        })
      )
    ).to.throw('LI.FI quote.action.toToken.address mismatch');

    expect(() =>
      validate(
        quote({
          includedSteps: [
            step({
              action: action({
                fromToken: { address: otherToken, chainId },
              }),
            }),
          ],
        })
      )
    ).to.throw('LI.FI included swap step.action.fromToken.address mismatch');

    expect(() =>
      validate(
        quote({
          includedSteps: [
            step({
              action: action({
                toToken: { address: otherToken, chainId },
              }),
            }),
          ],
        })
      )
    ).to.throw('LI.FI included swap step.action.toToken.address mismatch');
  });

  it('rejects action chain mismatches', () => {
    expect(() =>
      validate(
        quote({
          action: action({ fromChainId: chainId + 1 }),
        })
      )
    ).to.throw('LI.FI quote.action.fromChainId mismatch');

    expect(() =>
      validate(
        quote({
          action: action({ toChainId: chainId + 1 }),
        })
      )
    ).to.throw('LI.FI quote.action.toChainId mismatch');

    expect(() =>
      validate(
        quote({
          includedSteps: [
            step({
              action: action({ fromChainId: chainId + 1 }),
            }),
          ],
        })
      )
    ).to.throw('LI.FI included swap step.action.fromChainId mismatch');

    expect(() =>
      validate(
        quote({
          includedSteps: [
            step({
              action: action({ toChainId: chainId + 1 }),
            }),
          ],
        })
      )
    ).to.throw('LI.FI included swap step.action.toChainId mismatch');
  });

  it('rejects top-level sender and receiver mismatches', () => {
    const otherAddress = '0x6666666666666666666666666666666666666666';

    expect(() =>
      validate(
        quote({
          action: action({ fromAddress: otherAddress }),
        })
      )
    ).to.throw('LI.FI quote.action.fromAddress mismatch');
    expect(() =>
      validate(
        quote({
          action: action({ toAddress: otherAddress }),
        })
      )
    ).to.throw('LI.FI quote.action.toAddress mismatch');
    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({ from: otherAddress }),
        })
      )
    ).to.throw('LI.FI transactionRequest.from mismatch');
  });

  it('rejects zero approval spenders before approving a route', () => {
    expect(() =>
      validate(
        quote({
          estimate: estimate({
            approvalAddress: '0x0000000000000000000000000000000000000000',
          }),
        })
      )
    ).to.throw('LI.FI approvalAddress cannot be zero address');
  });

  it('rejects unlisted transaction targets and approval spenders', () => {
    const otherAddress = '0x6666666666666666666666666666666666666666';

    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({ to: otherAddress }),
        })
      )
    ).to.throw('LI.FI transactionRequest.to is not allowlisted');

    expect(() =>
      validate(
        quote({
          estimate: estimate({ approvalAddress: otherAddress }),
        })
      )
    ).to.throw('LI.FI approvalAddress is not allowlisted');
  });

  it('rejects unknown selectors for allowlisted targets', () => {
    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({
            data: '0xdeadbeef00000000',
          }),
        })
      )
    ).to.throw('LI.FI transaction selector is not allowlisted');
  });

  it('rejects malformed selector allowlist entries before approving a route', () => {
    expect(() =>
      validateLifiQuote({
        quote: quote(),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {
          [target]: ['0xabc'],
        },
      })
    ).to.throw('LI.FI selector allowlist entry is invalid');
  });

  it('rejects malformed address allowlists before approving a route', () => {
    expect(() =>
      validateLifiQuote({
        quote: quote(),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target, target],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {
          [target]: [selector],
        },
      })
    ).to.throw('LI.FI callTargetAllowlist cannot contain duplicate addresses');

    expect(() =>
      validateLifiQuote({
        quote: quote(),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target],
        approvalSpenderAllowlist: [spender, spender],
        selectorAllowlist: {
          [target]: [selector],
        },
      })
    ).to.throw(
      'LI.FI approvalSpenderAllowlist cannot contain duplicate addresses'
    );

    expect(() =>
      validateLifiQuote({
        quote: quote(),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: ['0x0000000000000000000000000000000000000000'],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {
          [target]: [selector],
        },
      })
    ).to.throw('LI.FI callTargetAllowlist cannot contain zero address');
  });

  it('rejects zero transaction targets before approving a route', () => {
    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({
            to: '0x0000000000000000000000000000000000000000',
          }),
        })
      )
    ).to.throw('LI.FI transactionRequest.to cannot be zero address');
  });

  it('rejects duplicate selector allowlist entries before approving a route', () => {
    expect(() =>
      validateLifiQuote({
        quote: quote(),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {
          [target]: ['0xabcdef12', '0xabcdef12'],
        },
      })
    ).to.throw('LI.FI selector allowlist for');
  });

  it('rejects selector policies that do not exactly cover call targets', () => {
    const otherTarget = '0x6666666666666666666666666666666666666666';
    expect(() =>
      normalizeLifiSelectorAllowlistRecord(
        {
          [target]: [selector],
        },
        {
          callTargetAllowlist: [target, otherTarget],
          requireCallTargetCoverage: true,
          requireNonEmpty: true,
        }
      )
    ).to.throw(
      'LI.FI selector allowlist must include selectors for every configured LI.FI call target'
    );

    expect(() =>
      normalizeLifiSelectorAllowlistRecord(
        {
          [target]: [selector],
          [otherTarget]: [selector],
        },
        {
          callTargetAllowlist: [target],
          requireCallTargetCoverage: true,
          requireNonEmpty: true,
        }
      )
    ).to.throw(
      `LI.FI selector allowlist.${otherTarget} is not present in callTargetAllowlist`
    );

    expect(() =>
      validateLifiQuote({
        quote: quote(),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target, otherTarget],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {
          [target]: [selector],
        },
      })
    ).to.throw(
      'LI.FI selector allowlist must include selectors for every configured LI.FI call target'
    );

    expect(() =>
      validateLifiQuote({
        quote: quote(),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {
          [target]: [selector],
          [otherTarget]: [selector],
        },
      })
    ).to.throw(
      `LI.FI selector allowlist.${otherTarget} is not present in callTargetAllowlist`
    );
  });

  it('rejects allowlisted targets without selector policy', () => {
    expect(() =>
      validateLifiQuote({
        quote: quote(),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {},
      })
    ).to.throw('LI.FI selector allowlist must be non-empty');
  });

  it('accepts explicit false destinationCall fields', () => {
    const approved = validate(
      quote({
        action: action({
          destinationCall: false,
        }),
        includedSteps: [
          step({
            action: action({
              destinationCall: false,
            }),
          }),
        ],
      })
    );

    expect(approved.selector).to.equal(selector);
  });

  it('rejects destinationCall on the top-level step', () => {
    expect(() =>
      validate(
        quote({
          action: action({ destinationCall: true }),
        })
      )
    ).to.throw('LI.FI quote.action.destinationCall is not supported');
  });

  it('rejects destinationCall on the included step', () => {
    expect(() =>
      validate(
        quote({
          includedSteps: [
            step({
              action: action({ destinationCall: true }),
            }),
          ],
        })
      )
    ).to.throw(
      'LI.FI included swap step.action.destinationCall is not supported'
    );
  });

  it('rejects destinationCall on the leading feeCollection step', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'uniswap',
          includedSteps: [
            feeCollectionStep({
              action: {
                ...feeCollectionStep().action,
                destinationCall: true,
              },
            }),
            step({
              action: action({
                fromAmount: '999000',
                fromAddress: spender,
                toAddress: spender,
              }),
              estimate: estimate({ fromAmount: '999000' }),
            }),
          ],
        })
      )
    ).to.throw(
      'LI.FI included feeCollection step.action.destinationCall is not supported'
    );
  });

  it('rejects noncanonical feeCollection protocol tool aliases', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'uniswap',
          includedSteps: [
            feeCollectionStep({ tool: 'fee_collection' }),
            step({
              action: action({
                fromAmount: '999000',
                fromAddress: spender,
                toAddress: spender,
              }),
              estimate: estimate({ fromAmount: '999000' }),
            }),
          ],
        })
      )
    ).to.throw(
      'LI.FI quote.includedSteps must contain one swap step and optional feeCollection step'
    );
  });

  it('rejects lifi wrappers with feeCollection but no executable swap', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'lifi',
          includedSteps: [step({ type: 'protocol', tool: 'feeCollection' })],
        })
      )
    ).to.throw('LI.FI included swap step.type must be swap');
  });

  it('rejects nested lifi steps', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'lifi',
          includedSteps: [step({ type: 'lifi', tool: 'lifi' })],
        })
      )
    ).to.throw('LI.FI included swap step.type must be swap');
  });

  it('rejects included swap steps without an allowlisted tool', () => {
    expect(() =>
      validate(
        quote({
          includedSteps: [step({ tool: undefined })],
        })
      )
    ).to.throw('LI.FI included swap step.tool is not allowlisted');
  });

  it('rejects broad filter keywords as concrete allowed exchange tools', () => {
    for (const tool of ['all', 'default', 'none', '[]']) {
      expect(() =>
        validateLifiQuote({
          quote: quote({ tool }),
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount,
          takerAddress: taker,
          allowedExchangeTools: [tool],
          callTargetAllowlist: [target],
          approvalSpenderAllowlist: [spender],
          selectorAllowlist: {
            [target]: [selector],
          },
        })
      ).to.throw(
        'LI.FI allowedExchangeTools cannot include broad filter keyword'
      );
    }
  });

  it('rejects feeCollection as an operator exchange filter', () => {
    expect(() =>
      validateLifiQuote({
        quote: quote({
          tool: 'feeCollection',
          includedSteps: [step({ tool: 'feeCollection' })],
        }),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['feeCollection'],
        callTargetAllowlist: [target],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {
          [target]: [selector],
        },
      })
    ).to.throw(
      'LI.FI allowedExchangeTools cannot include unsupported tool feeCollection'
    );
  });

  it('rejects transaction requests without calldata', () => {
    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({ data: undefined }),
        })
      )
    ).to.throw('LI.FI transactionRequest.data must be a non-empty string');
  });

  it('rejects malformed odd-length transaction calldata', () => {
    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({ data: `${selector}0` }),
        })
      )
    ).to.throw('LI.FI transactionRequest.data must contain calldata');
  });

  it('rejects transaction requests for a different chain', () => {
    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({ chainId: 1 }),
        })
      )
    ).to.throw('LI.FI transactionRequest.chainId mismatch');
  });

  it('rejects transaction requests without an explicit chain id', () => {
    expect(() =>
      validate(
        quote({
          transactionRequest: transactionRequest({ chainId: undefined }),
        })
      )
    ).to.throw('LI.FI transactionRequest.chainId is required');
  });

  it('rejects top-level fromAmount mismatches', () => {
    expect(() =>
      validate(
        quote({
          action: action({ fromAmount: fromAmount.add(1).toString() }),
        })
      )
    ).to.throw('LI.FI quote.action.fromAmount mismatch');
  });

  it('rejects route min-out greater than quoted output', () => {
    expect(() =>
      validate(
        quote({
          estimate: estimate({
            toAmount: '1900000',
            toAmountMin: '2000000',
          }),
        })
      )
    ).to.throw('LI.FI quote.estimate.toAmountMin cannot exceed toAmount');
  });

  it('rejects included step approval spenders outside the allowlist', () => {
    expect(() =>
      validate(
        quote({
          includedSteps: [
            step({
              estimate: estimate({
                approvalAddress: '0x6666666666666666666666666666666666666666',
              }),
            }),
          ],
        })
      )
    ).to.throw('LI.FI included swap step approvalAddress is not allowlisted');
  });

  it('rejects lifi-wrapper included swap approval spenders outside the allowlist without feeCollection', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'lifi',
          includedSteps: [
            step({
              estimate: estimate({
                approvalAddress: '0x6666666666666666666666666666666666666666',
              }),
            }),
          ],
        })
      )
    ).to.throw('LI.FI included swap step approvalAddress is not allowlisted');
  });

  it('rejects included step approval spenders that conflict with the top-level approval spender', () => {
    const otherSpender = '0x6666666666666666666666666666666666666666';

    expect(() =>
      validateLifiQuote({
        quote: quote({
          includedSteps: [
            step({
              estimate: estimate({
                approvalAddress: otherSpender,
              }),
            }),
          ],
        }),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target],
        approvalSpenderAllowlist: [spender, otherSpender],
        selectorAllowlist: {
          [target]: [selector],
        },
      })
    ).to.throw(
      'LI.FI included swap step approvalAddress conflicts with top-level approvalAddress'
    );
  });

  it('rejects included step output floors below the top-level min output', () => {
    expect(() =>
      validate(
        quote({
          includedSteps: [
            step({
              estimate: estimate({
                toAmount: '2000000',
                toAmountMin: '1800000',
              }),
            }),
          ],
        })
      )
    ).to.throw(
      'LI.FI included step.estimate.toAmountMin conflicts with top-level min output'
    );
  });

  it('rejects source-token fee costs without a feeCollection step under included_only policy', () => {
    expect(() =>
      validate(
        quote({
          estimate: estimate({
            feeCosts: [
              {
                included: true,
                amount: '1',
                token: { address: collateral, chainId },
              },
            ],
          }),
        })
      )
    ).to.throw(
      'LI.FI feeCosts must be charged in the expected output token or approved source-token feeCollection metadata'
    );
  });

  it('rejects source-token fee costs on the executable swap even with a feeCollection step', () => {
    expect(() =>
      validate(
        quote({
          type: 'lifi',
          tool: 'uniswap',
          includedSteps: [
            feeCollectionStep(),
            step({
              action: action({
                fromAmount: '999000',
                fromAddress: spender,
                toAddress: spender,
              }),
              estimate: estimate({
                approvalAddress: '0x8888888888888888888888888888888888888888',
                fromAmount: '999000',
                feeCosts: [
                  {
                    included: true,
                    amount: '1',
                    token: { address: collateral, chainId },
                  },
                ],
              }),
            }),
          ],
        })
      )
    ).to.throw(
      'LI.FI feeCosts must be charged in the expected output token or approved source-token feeCollection metadata'
    );
  });

  it('rejects fee costs when feeCostPolicy is reject_all', () => {
    expect(() =>
      validateLifiQuote({
        quote: quote({
          estimate: estimate({
            feeCosts: [
              {
                included: true,
                amount: '1',
                token: { address: quoteToken, chainId },
              },
            ],
          }),
        }),
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount,
        takerAddress: taker,
        allowedExchangeTools: ['uniswap'],
        callTargetAllowlist: [target],
        approvalSpenderAllowlist: [spender],
        selectorAllowlist: {
          [target]: [selector],
        },
        feeCostPolicy: 'reject_all',
      })
    ).to.throw('LI.FI feeCosts are not allowed by feeCostPolicy=reject_all');
  });

  it('rejects fee costs that are not included in the output floor', () => {
    expect(() =>
      validate(
        quote({
          estimate: estimate({
            feeCosts: [
              {
                included: false,
                amount: '1',
                token: { address: quoteToken, chainId },
              },
            ],
          }),
        })
      )
    ).to.throw('LI.FI feeCosts must be included in toAmountMin');
  });

  it('rejects fee costs with a token chain id that differs from the route chain', () => {
    expect(() =>
      validate(
        quote({
          estimate: estimate({
            feeCosts: [
              {
                included: true,
                amount: '1',
                token: { address: quoteToken, chainId: chainId + 1 },
              },
            ],
          }),
        })
      )
    ).to.throw('LI.FI feeCosts token chainId mismatch');
  });

  it('accepts included output-token fee costs', () => {
    const approved = validate(
      quote({
        estimate: estimate({
          feeCosts: [
            {
              included: true,
              amount: '1',
              token: { address: quoteToken, chainId },
              name: 'integrator fee',
            },
          ],
        }),
      })
    );

    expect(approved.routeMinOutRaw.toString()).to.equal('1900000');
    expect(approved.feeCosts).to.deep.equal([
      {
        source: 'top_level',
        token: quoteToken,
        amount: '1',
        included: true,
        name: 'integrator fee',
      },
    ]);
  });

  it('builds callback-safe quote requests', () => {
    const url = new URL(
      buildLifiQuoteUrl({
        config: {
          mode: 'canary',
          apiBaseUrl: 'https://li.quest/v1/',
          allowExchanges: ['Uniswap'],
          defaultSlippage: 0.005,
        },
        request: {
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount: fromAmount.toString(),
          fromAddress: taker,
          toAddress: taker,
        },
      })
    );

    expect(url.origin + url.pathname).to.equal('https://li.quest/v1/quote');
    expect(url.searchParams.get('fromChain')).to.equal(String(chainId));
    expect(url.searchParams.get('toChain')).to.equal(String(chainId));
    expect(url.searchParams.get('skipSimulation')).to.equal('true');
    expect(url.searchParams.get('allowDestinationCall')).to.equal('false');
    expect(url.searchParams.get('denyBridges')).to.equal('all');
    expect(url.searchParams.get('allowExchanges')).to.equal('uniswap');
  });

  it('rejects unsafe LI.FI quote request shapes before building URLs', () => {
    const base = {
      config: {
        mode: 'canary' as const,
        apiBaseUrl: 'https://li.quest/v1/',
        allowExchanges: ['uniswap'],
        defaultSlippage: 0.005,
      },
      request: {
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount: fromAmount.toString(),
        fromAddress: taker,
        toAddress: taker,
      },
    };

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: { ...base.request, chainId: 0 },
      })
    ).to.throw('LI.FI request.chainId must be a positive integer');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: { ...base.request, fromToken: 'not-an-address' },
      })
    ).to.throw('LI.FI request.fromToken must be an address');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          toToken: ethers.constants.AddressZero,
        },
      })
    ).to.throw('LI.FI request.toToken cannot be zero address');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: { ...base.request, fromAmount: '0' },
      })
    ).to.throw(
      'LI.FI request.fromAmount must be a positive decimal integer string'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: { ...base.request, fromAmount: '1.5' },
      })
    ).to.throw(
      'LI.FI request.fromAmount must be a positive decimal integer string'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          toAddress: '0x6666666666666666666666666666666666666666',
        },
      })
    ).to.throw(
      'LI.FI request.fromAddress and toAddress must both be the taker address'
    );

    const lowerCollateral = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const lowerQuoteToken = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const lowerTaker = '0xcccccccccccccccccccccccccccccccccccccccc';
    const url = new URL(
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          fromToken: lowerCollateral,
          toToken: lowerQuoteToken,
          fromAddress: lowerTaker,
          toAddress: lowerTaker,
        },
      })
    );
    expect(url.searchParams.get('fromToken')).to.equal(
      ethers.utils.getAddress(lowerCollateral)
    );
    expect(url.searchParams.get('toToken')).to.equal(
      ethers.utils.getAddress(lowerQuoteToken)
    );
    expect(url.searchParams.get('fromAddress')).to.equal(
      ethers.utils.getAddress(lowerTaker)
    );
    expect(url.searchParams.get('toAddress')).to.equal(
      ethers.utils.getAddress(lowerTaker)
    );
  });

  it('normalizes request-level exchange filter overrides before building quote requests', () => {
    const url = new URL(
      buildLifiQuoteUrl({
        config: {
          mode: 'canary',
          apiBaseUrl: 'https://li.quest/v1/',
          allowExchanges: ['sushiswap'],
          defaultSlippage: 0.005,
        },
        request: {
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount: fromAmount.toString(),
          fromAddress: taker,
          toAddress: taker,
          allowExchanges: ['Uniswap'],
          preferExchanges: ['KyberSwap'],
        },
      })
    );

    expect(url.searchParams.get('allowExchanges')).to.equal('uniswap');
    expect(url.searchParams.get('preferExchanges')).to.equal('kyberswap');
  });

  it('rejects duplicate request-level exchange filters across allow and prefer', () => {
    expect(() =>
      buildLifiQuoteUrl({
        config: {
          mode: 'canary',
          apiBaseUrl: 'https://li.quest/v1/',
          defaultSlippage: 0.005,
        },
        request: {
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount: fromAmount.toString(),
          fromAddress: taker,
          toAddress: taker,
          allowExchanges: ['Uniswap'],
          preferExchanges: ['uniswap'],
        },
      })
    ).to.throw(
      'LI.FI exchange filter uniswap cannot appear in both allowExchanges and preferExchanges'
    );
  });

  it('validates LI.FI integrator values before building quote requests', () => {
    const base = {
      config: {
        mode: 'canary' as const,
        apiBaseUrl: 'https://li.quest/v1/',
        allowExchanges: ['uniswap'],
        defaultSlippage: 0.005,
        integrator: 'ajna.keeper-01',
      },
      request: {
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount: fromAmount.toString(),
        fromAddress: taker,
        toAddress: taker,
      },
    };

    const configUrl = new URL(buildLifiQuoteUrl(base));
    expect(configUrl.searchParams.get('integrator')).to.equal('ajna.keeper-01');

    const requestUrl = new URL(
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          integrator: 'ajna_override',
        },
      })
    );
    expect(requestUrl.searchParams.get('integrator')).to.equal('ajna_override');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        config: {
          ...base.config,
          integrator: 'x'.repeat(24),
        },
      })
    ).to.throw(
      'dex.lifi.integrator must be 1-23 characters and contain only letters, numbers, hyphens, underscores, or dots'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          integrator: 'ajna keeper',
        },
      })
    ).to.throw(
      'LI.FI request.integrator must be 1-23 characters and contain only letters, numbers, hyphens, underscores, or dots'
    );
  });

  it('rejects unsafe request-level LI.FI slippage and price-impact overrides', () => {
    const base = {
      config: {
        mode: 'canary' as const,
        apiBaseUrl: 'https://li.quest/v1/',
        allowExchanges: ['uniswap'],
        defaultSlippage: 0.005,
        maxPriceImpact: 0.01,
      },
      request: {
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount: fromAmount.toString(),
        fromAddress: taker,
        toAddress: taker,
      },
    };

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          slippage: 0,
        },
      })
    ).to.throw(
      'dex.lifi.defaultSlippage must be greater than 0 and at most 0.5'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          maxPriceImpact: Number.POSITIVE_INFINITY,
        },
      })
    ).to.throw(
      'dex.lifi.maxPriceImpact must be greater than 0 and at most 0.5'
    );

    const url = new URL(
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          maxPriceImpact: 0.02,
        },
      })
    );
    expect(url.searchParams.get('maxPriceImpact')).to.equal('0.02');
  });

  it('rejects fee-collection exchange filters in quote requests', () => {
    expect(() =>
      buildLifiQuoteUrl({
        config: {
          mode: 'canary',
          apiBaseUrl: 'https://li.quest/v1/',
          allowExchanges: ['feeCollection'],
          defaultSlippage: 0.005,
        },
        request: {
          chainId,
          fromToken: collateral,
          toToken: quoteToken,
          fromAmount: fromAmount.toString(),
          fromAddress: taker,
          toAddress: taker,
        },
      })
    ).to.throw(
      'dex.lifi.allowExchanges cannot use unsupported LI.FI filter keyword'
    );
  });

  it('rejects request-level broad and unsupported exchange filter overrides', () => {
    const base = {
      config: {
        mode: 'canary' as const,
        apiBaseUrl: 'https://li.quest/v1/',
        allowExchanges: ['uniswap'],
        defaultSlippage: 0.005,
      },
      request: {
        chainId,
        fromToken: collateral,
        toToken: quoteToken,
        fromAmount: fromAmount.toString(),
        fromAddress: taker,
        toAddress: taker,
      },
    };

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          allowExchanges: ['all'],
        },
      })
    ).to.throw('dex.lifi.allowExchanges cannot use broad LI.FI filter keyword');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          allowExchanges: ['none'],
        },
      })
    ).to.throw('dex.lifi.allowExchanges cannot use broad LI.FI filter keyword');

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          preferExchanges: ['[]'],
        },
      })
    ).to.throw(
      'dex.lifi.preferExchanges cannot use broad LI.FI filter keyword'
    );

    expect(() =>
      buildLifiQuoteUrl({
        ...base,
        request: {
          ...base.request,
          denyExchanges: ['feeCollection'],
        },
      })
    ).to.throw(
      'dex.lifi.denyExchanges cannot use unsupported LI.FI filter keyword'
    );
  });
});
