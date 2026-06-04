import { expect } from 'chai';
import {
  action,
  chainId,
  collateral,
  estimate,
  feeCollectionStep,
  quote,
  quoteToken,
  selector,
  spender,
  step,
  target,
  validate,
} from './helpers/lifi-validation-fixtures';

describe('LI.FI quote validation fee and included-step policy', () => {
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
      validate(
        quote({
          includedSteps: [
            step({
              estimate: estimate({
                approvalAddress: otherSpender,
              }),
            }),
          ],
        }),
        {
          approvalSpenderAllowlist: [spender, otherSpender],
          selectorAllowlist: {
            [target]: [selector],
          },
        }
      )
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
      validate(
        quote({
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
        { feeCostPolicy: 'reject_all' }
      )
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
});
