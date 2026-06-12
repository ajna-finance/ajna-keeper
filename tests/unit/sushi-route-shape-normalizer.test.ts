// Packet 2A offline normalizer tests over the recorded Sushi fixtures.
//
// Proves every committed successful raw fixture re-normalizes into the
// recorded proposed ApprovedCalldataAggregatorQuote fields, that the
// committed ambiguous/malformed fixtures fail closed, that tampered
// execution fields fail closed, and that failed quote attempts classify
// onto the shared Packet 2A/3A failure union. No network access.
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import {
  ProviderSuccessResult,
  RouteShapeArtifact,
} from '../../tools/external-take-evidence/evidence-schema';
import {
  SushiQuoteRequestContext,
  classifySushiQuoteFailure,
  normalizeSushiV7Response,
} from '../../tools/external-take-evidence/sushi-route-normalizer';

const FIXTURES_DIR = path.join(
  __dirname,
  '..',
  '..',
  'tools',
  'external-take-evidence',
  'fixtures'
);

interface RawFixtureFile {
  capturedAt: string;
  expectedNormalization: 'success' | 'fail_closed';
  expectedClassification?: string;
  synthetic: boolean;
  request: {
    chainId: number;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    maxSlippage: number;
    sender: string;
    recipient?: string;
  };
  httpStatus: number;
  response: unknown;
}

function loadArtifact(): RouteShapeArtifact {
  return JSON.parse(
    fs.readFileSync(
      path.join(FIXTURES_DIR, 'sushi-route-shape.artifact.json'),
      'utf8'
    )
  );
}

function loadFixture(relPath: string): RawFixtureFile {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, relPath), 'utf8')
  );
}

function contextOf(fixture: RawFixtureFile): SushiQuoteRequestContext {
  return {
    chainId: fixture.request.chainId,
    tokenIn: fixture.request.tokenIn,
    tokenOut: fixture.request.tokenOut,
    amountIn: fixture.request.amountIn,
    maxSlippage: fixture.request.maxSlippage,
    sender: fixture.request.sender,
    ...(fixture.request.recipient
      ? { recipient: fixture.request.recipient }
      : {}),
    requestedAt: fixture.capturedAt,
  };
}

function leftPad64(hex: string): string {
  let out = hex;
  while (out.length < 64) {
    out = '0' + out;
  }
  return out;
}

function withHeadWord(data: string, index: number, word64: string): string {
  const start = 10 + index * 64;
  return data.slice(0, start) + word64 + data.slice(start + 64);
}

function addressWord(address: string): string {
  return leftPad64(address.toLowerCase().slice(2));
}

function amountWord(amount: BigNumber): string {
  return leftPad64(amount.toHexString().slice(2));
}

function cloneResponse(fixture: RawFixtureFile): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture.response));
}

describe('Sushi v7 route-shape normalizer (Packet 2A, offline fixtures)', () => {
  const artifact = loadArtifact();

  describe('recorded successful routes', () => {
    for (const row of artifact.rows) {
      for (const result of row.providerResults) {
        if (result.outcome !== 'success') {
          continue;
        }
        const success = result as ProviderSuccessResult;
        it(`${row.chainName}(${row.chainId}) normalizes to the recorded fields`, () => {
          const fixture = loadFixture(success.rawFixturePath);
          const normalization = normalizeSushiV7Response(
            fixture.response,
            contextOf(fixture)
          );
          expect(
            normalization.ok,
            normalization.ok ? '' : normalization.reason
          ).to.equal(true);
          if (normalization.ok) {
            expect(normalization.normalized).to.deep.equal(success.normalized);
          }
        });

        it(`${row.chainName}(${row.chainId}) provides every required execution field`, () => {
          const normalized = success.normalized;
          expect(normalized.txTarget).to.match(/^0x[0-9a-f]{40}$/);
          expect(normalized.approvalSpender).to.match(/^0x[0-9a-f]{40}$/);
          expect(normalized.callDataSelector).to.match(/^0x[0-9a-f]{8}$/);
          expect(normalized.txValue).to.equal('0');
          expect(normalized.chainId).to.equal(row.chainId);
          expect(normalized.inputToken).to.equal(
            row.pair.tokenIn.address.toLowerCase()
          );
          expect(normalized.outputToken).to.equal(
            row.pair.tokenOut.address.toLowerCase()
          );
          expect(normalized.amountIn).to.equal(row.amountIn);
          expect(normalized.recipient).to.match(/^0x[0-9a-f]{40}$/);
          expect(BigNumber.from(normalized.expectedAmountOut).gt(0)).to.equal(
            true
          );
          expect(BigNumber.from(normalized.minimumAmountOut).gt(0)).to.equal(
            true
          );
          expect(
            BigNumber.from(normalized.minimumAmountOut).lte(
              BigNumber.from(normalized.expectedAmountOut)
            )
          ).to.equal(true);
          expect(normalized.callData.slice(0, 10)).to.equal(
            normalized.callDataSelector
          );
        });
      }
    }
  });

  describe('committed fail-closed fixtures', () => {
    it('rejects the real ambiguous Polygon wrapped-native response shape', () => {
      const fixture = loadFixture(
        'raw/sushi-v7-polygon-wpol-usdc-ambiguous-shape.json'
      );
      expect(fixture.synthetic).to.equal(false);
      const normalization = normalizeSushiV7Response(
        fixture.response,
        contextOf(fixture)
      );
      expect(normalization.ok).to.equal(false);
      if (!normalization.ok) {
        expect(normalization.reason).to.include('unproven response shape');
      }
    });

    it('rejects the synthetic malformed fixture missing tx.data', () => {
      const fixture = loadFixture(
        'raw/sushi-v7-synthetic-malformed-missing-txdata.json'
      );
      expect(fixture.synthetic).to.equal(true);
      const normalization = normalizeSushiV7Response(
        fixture.response,
        contextOf(fixture)
      );
      expect(normalization.ok).to.equal(false);
    });
  });

  describe('tampered execution fields fail closed', () => {
    const baseFixture = loadFixture('raw/sushi-v7-ethereum-weth-usdc.json');
    const ctx = contextOf(baseFixture);

    function dataOf(response: Record<string, unknown>): string {
      return (response.tx as Record<string, unknown>).data as string;
    }

    function setData(
      response: Record<string, unknown>,
      data: string
    ): Record<string, unknown> {
      (response.tx as Record<string, unknown>).data = data;
      return response;
    }

    it('rejects a non-Success status', () => {
      const response = cloneResponse(baseFixture);
      response.status = 'NoWay';
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
    });

    it('rejects an unproven selector', () => {
      const response = cloneResponse(baseFixture);
      setData(response, '0xdeadbeef' + dataOf(response).slice(10));
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.reason).to.include('unproven response shape');
      }
    });

    it('rejects a rewritten recipient', () => {
      const response = cloneResponse(baseFixture);
      setData(
        response,
        withHeadWord(
          dataOf(response),
          2,
          addressWord('0x2222222222222222222222222222222222222222')
        )
      );
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.reason).to.include('recipient');
      }
    });

    it('rejects a rewritten output token', () => {
      const response = cloneResponse(baseFixture);
      setData(
        response,
        withHeadWord(
          dataOf(response),
          3,
          addressWord('0x3333333333333333333333333333333333333333')
        )
      );
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.reason).to.include('tokenOut');
      }
    });

    it('rejects a zero minimum output', () => {
      const response = cloneResponse(baseFixture);
      setData(
        response,
        withHeadWord(dataOf(response), 4, amountWord(BigNumber.from(0)))
      );
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.reason).to.include('minimum output is zero');
      }
    });

    it('rejects a minimum output above the expected output', () => {
      const response = cloneResponse(baseFixture);
      const assumed = BigNumber.from(response.assumedAmountOut as string);
      setData(response, withHeadWord(dataOf(response), 4, amountWord(assumed.mul(2))));
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.reason).to.include('exceeds expected');
      }
    });

    it('rejects a minimum output below the slippage floor', () => {
      const response = cloneResponse(baseFixture);
      const assumed = BigNumber.from(response.assumedAmountOut as string);
      setData(response, withHeadWord(dataOf(response), 4, amountWord(assumed.div(2))));
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.reason).to.include('below the slippage floor');
      }
    });

    it('rejects a non-zero tx.value for an ERC20 input', () => {
      const response = cloneResponse(baseFixture);
      (response.tx as Record<string, unknown>).value = '1';
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.reason).to.include('tx.value');
      }
    });

    it('rejects a response whose amountIn drifts from the request', () => {
      const response = cloneResponse(baseFixture);
      response.amountIn = '999';
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
    });

    it('rejects token metadata that contradicts the requested pair', () => {
      const response = cloneResponse(baseFixture);
      response.tokenTo = 0;
      const result = normalizeSushiV7Response(response, ctx);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.reason).to.include('token metadata');
      }
    });
  });

  describe('failure classification onto the shared union', () => {
    it('classifies the committed invalid-token 422 capture as no_route', () => {
      const fixture = loadFixture('raw/sushi-v7-base-invalid-token-422.json');
      const classified = classifySushiQuoteFailure(
        fixture.httpStatus,
        fixture.response
      );
      expect(classified.classification).to.equal('no_route');
      expect(classified.classification).to.equal(
        fixture.expectedClassification
      );
    });

    it('classifies the committed unsupported-chain 404 capture as unsupported_chain', () => {
      const fixture = loadFixture('raw/sushi-v7-unsupported-chain-404.json');
      const classified = classifySushiQuoteFailure(
        fixture.httpStatus,
        fixture.response
      );
      expect(classified.classification).to.equal('unsupported_chain');
      expect(classified.classification).to.equal(
        fixture.expectedClassification
      );
    });

    it('classifies credential rejections, rate limits, and transport errors', () => {
      expect(classifySushiQuoteFailure(401, {}).classification).to.equal(
        'missing_credentials'
      );
      expect(classifySushiQuoteFailure(429, {}).classification).to.equal(
        'rate_limited'
      );
      expect(classifySushiQuoteFailure(503, {}).classification).to.equal(
        'transient_error'
      );
      expect(
        classifySushiQuoteFailure(undefined, null, 'socket hang up')
          .classification
      ).to.equal('transient_error');
      expect(
        classifySushiQuoteFailure(200, 'not json at all').classification
      ).to.equal('malformed_response');
      expect(
        classifySushiQuoteFailure(200, { status: 'NoWay' }).classification
      ).to.equal('no_route');
    });
  });
});
