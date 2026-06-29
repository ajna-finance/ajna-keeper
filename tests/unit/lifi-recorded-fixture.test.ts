import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { BigNumber } from 'ethers';
import { validateLifiQuote } from '../../src/dex/lifi';

// Real recorded li.quest /v1/quote response (Base same-chain WETH->USDC),
// captured keyless and committed at tests/fixtures/lifi-aggregator/. Unlike the
// synthetic fixture (src/dex/lifi/fixtures, placeholder addresses), this exercises
// validateLifiQuote against the ACTUAL LI.FI response shape -- a route through the
// LI.FI Diamond with a source-token feeCollection step. It catches a
// validator-vs-reality normalization drift (renamed/moved field, changed calldata
// head) that the synthetic tests, which construct their input to match the
// validator, cannot. No network at test time; the snapshot is deterministic.
const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'tests',
  'fixtures',
  'lifi-aggregator',
  'base-weth-usdc.json'
);

interface LifiRecordedFixture {
  synthetic: boolean;
  request: {
    chainId: number;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    fromAddress: string;
  };
  response: any;
  expected: {
    quoteAmountRaw: string;
    routeMinOutRaw: string;
    srcToken: string;
    dstToken: string;
    dstReceiver: string;
    transactionTarget: string;
    approvalSpender: string;
    selector: string;
    txValue: string;
    tool: string;
  };
}

function loadFixture(): LifiRecordedFixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

function clonedResponse(): any {
  return JSON.parse(JSON.stringify(loadFixture().response));
}

// Validate the recorded response with allowlists pinned to the recorded route's
// real target/spender/selector (mirroring how the Sushi fixture pins to its
// reviewed PROVEN constants). The expected.* values are the reviewed LI.FI
// Diamond addresses + selector, so a response whose shape drifted to a different
// target/selector would miss the allowlist and fail here.
function validateRecorded(
  response: any,
  overrides: Record<string, unknown> = {}
): any {
  const fx = loadFixture();
  const target = fx.expected.transactionTarget;
  return validateLifiQuote({
    quote: response,
    chainId: fx.request.chainId,
    fromToken: fx.request.fromToken,
    toToken: fx.request.toToken,
    fromAmount: BigNumber.from(fx.request.fromAmount),
    takerAddress: fx.request.fromAddress,
    exchangePolicy: {
      kind: 'concrete_allowlist',
      filters: { allowExchanges: [fx.expected.tool] },
    },
    callTargetAllowlist: [target],
    approvalSpenderAllowlist: [fx.expected.approvalSpender],
    selectorAllowlist: { [target]: [fx.expected.selector] },
    feeCostPolicy: 'included_only',
    nowMs: 1234,
    ...overrides,
  } as any);
}

describe('LI.FI recorded-response fixture (real li.quest /quote, Base WETH->USDC)', () => {
  it('is a real recorded capture, not synthetic', () => {
    expect(loadFixture().synthetic).to.equal(false);
  });

  it('normalizes the real response to the expected ApprovedLifiQuote', () => {
    const fx = loadFixture();
    const approved = validateRecorded(fx.response);

    expect(approved.quoteAmountRaw.toString()).to.equal(
      fx.expected.quoteAmountRaw
    );
    expect(approved.routeMinOutRaw.toString()).to.equal(
      fx.expected.routeMinOutRaw
    );
    expect(approved.routeMinOutRaw.lte(approved.quoteAmountRaw)).to.equal(true);
    expect(approved.srcToken).to.equal(fx.expected.srcToken);
    expect(approved.dstToken).to.equal(fx.expected.dstToken);
    expect(approved.dstReceiver).to.equal(fx.expected.dstReceiver);
    expect(approved.transactionTarget).to.equal(fx.expected.transactionTarget);
    expect(approved.approvalSpender).to.equal(fx.expected.approvalSpender);
    expect(approved.selector).to.equal(fx.expected.selector);
    expect(approved.tool).to.equal(fx.expected.tool);
    expect(approved.quotedAtMs).to.equal(1234);
  });

  it('rejects the real response if the output token is tampered', () => {
    const tampered = clonedResponse();
    tampered.action.toToken.address =
      '0x0000000000000000000000000000000000000bad';
    expect(() => validateRecorded(tampered)).to.throw();
  });

  it('rejects the real response if the call target is not allow-listed', () => {
    const tampered = clonedResponse();
    tampered.transactionRequest.to =
      '0x000000000000000000000000000000000000beef';
    expect(() => validateRecorded(tampered)).to.throw();
  });
});
