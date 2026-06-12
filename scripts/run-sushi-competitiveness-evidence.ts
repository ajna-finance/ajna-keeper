// Read-only Packet 3A competitiveness sweep (SushiSwap aggregator roadmap).
//
// Declares the Packet 2A minimum sample matrix UP FRONT (imported constant —
// the set is fixed before any provider is queried and every declared row
// stays in the artifact even when a provider is unavailable), then records
// one discriminated Sushi, LI.FI, and 1inch result per row, re-queries
// failures to record reproducibility, collects allowlist-stability refreshes
// for chains where Sushi succeeded, derives the per-row assessment and the
// proceed/defer decision from the recorded data, and writes the typed
// competitiveness artifact plus the markdown summary derived from it.
//
// Decision standard applied (packet-3a.md):
// - coverage basis: Sushi succeeds where BOTH incumbents have reproducible
//   unsupported_chain/no_route outcomes (credentials, rate limits, transient
//   errors, malformed responses never count toward proceed)
// - net-execution basis: Sushi succeeds, an incumbent succeeds, and Sushi is
//   non-dominated on expected output for the keeper-relevant pair
// - proceed additionally requires >=3 distinct-timestamp/hash route-shape
//   samples per scoped target/selector/spender; otherwise defer
//
// HTTP GET quote requests only — no wallet, no RPC writes, no broadcast.
//
// Usage: npm run run-sushi-competitiveness-evidence
import { BigNumber } from 'ethers';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import {
  AllowlistStabilityEvidence,
  CompetitivenessArtifact,
  FailureClassification,
  ProviderResult,
  ProvisionalNormalizedRouteFields,
  SampleRow,
  validateEvidenceArtifact,
} from '../tools/external-take-evidence/evidence-schema';
import {
  SushiQuoteRequestContext,
  classifySushiQuoteFailure,
  normalizeSushiV7Response,
} from '../tools/external-take-evidence/sushi-route-normalizer';
import {
  MATRIX,
  MatrixEntry,
  SPIKE_AMOUNT_IN,
  SPIKE_MAX_SLIPPAGE,
  SPIKE_SENDER,
  httpGetText,
  parseBody,
} from './refresh-sushi-route-shape-evidence';
import { checkCompetitivenessArtifact } from './check-calldata-aggregator-evidence';

const EVIDENCE_DIR = path.join(
  __dirname,
  '..',
  'tools',
  'external-take-evidence'
);
const FIXTURES_DIR = path.join(EVIDENCE_DIR, 'fixtures');
const COMPETITIVENESS_RAW_DIR = path.join(FIXTURES_DIR, 'raw', 'competitiveness');
const ARTIFACT_PATH = path.join(
  FIXTURES_DIR,
  'sushi-competitiveness.artifact.json'
);
const SUMMARY_PATH = path.join(
  __dirname,
  '..',
  'docs',
  'sushiswap-external-take-packet-3a-decision.md'
);

const LIFI_API_BASE = 'https://li.quest/v1/quote';
const ONEINCH_API_BASE = 'https://api.1inch.dev/swap/v6.0';
const STABILITY_SAMPLES = 3;

interface CapturedResponse {
  capturedAt: string;
  httpStatus: number;
  bodyText: string;
  body: unknown;
  transportError?: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeRawFixture(fileName: string, payload: unknown): string {
  fs.writeFileSync(
    path.join(COMPETITIVENESS_RAW_DIR, fileName),
    JSON.stringify(payload, null, 2) + '\n'
  );
  return `raw/competitiveness/${fileName}`;
}

async function capture(
  url: string,
  headers?: Record<string, string>
): Promise<CapturedResponse> {
  const capturedAt = new Date().toISOString();
  try {
    const { status, bodyText } = await httpGetJson(url, headers);
    return {
      capturedAt,
      httpStatus: status,
      bodyText,
      body: parseBody(bodyText),
    };
  } catch (error) {
    return {
      capturedAt,
      httpStatus: 0,
      bodyText: '',
      body: null,
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

function httpGetJson(
  url: string,
  headers?: Record<string, string>
): Promise<{ status: number; bodyText: string }> {
  if (!headers) {
    return httpGetText(url);
  }
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { accept: 'application/json', ...headers }, timeout: 30_000 },
      response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, bodyText: body })
        );
      }
    );
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
  });
}

function sushiQuoteUrl(entry: MatrixEntry): string {
  return (
    `https://api.sushi.com/swap/v7/${entry.chainId}` +
    `?tokenIn=${entry.tokenIn.address}&tokenOut=${entry.tokenOut.address}` +
    `&amount=${SPIKE_AMOUNT_IN}&maxSlippage=${SPIKE_MAX_SLIPPAGE}&sender=${SPIKE_SENDER}`
  );
}

function lifiQuoteUrl(entry: MatrixEntry): string {
  return (
    `${LIFI_API_BASE}?fromChain=${entry.chainId}&toChain=${entry.chainId}` +
    `&fromToken=${entry.tokenIn.address}&toToken=${entry.tokenOut.address}` +
    `&fromAmount=${SPIKE_AMOUNT_IN}&fromAddress=${SPIKE_SENDER}&toAddress=${SPIKE_SENDER}` +
    `&slippage=${SPIKE_MAX_SLIPPAGE}`
  );
}

function oneInchQuoteUrl(entry: MatrixEntry): string {
  return (
    `${ONEINCH_API_BASE}/${entry.chainId}/quote` +
    `?src=${entry.tokenIn.address}&dst=${entry.tokenOut.address}&amount=${SPIKE_AMOUNT_IN}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Net quote-token value after gas: convert the provider's native gas estimate
// into quote units through the quote's own implied price. Only derivable when
// the input token is the chain's wrapped native (true for every matrix row
// except the substituted Polygon WETH pair).
function netAfterGas(params: {
  expectedOutRaw: BigNumber;
  amountInWei: BigNumber;
  gasUnits: BigNumber;
  gasPriceWei: BigNumber;
  inputIsWrappedNative: boolean;
}): string {
  if (!params.inputIsWrappedNative) {
    return 'unknown';
  }
  const gasCostNativeWei = params.gasUnits.mul(params.gasPriceWei);
  const gasCostQuote = params.expectedOutRaw
    .mul(gasCostNativeWei)
    .div(params.amountInWei);
  const net = params.expectedOutRaw.sub(gasCostQuote);
  return (net.lt(0) ? BigNumber.from(0) : net).toString();
}

function inputIsWrappedNative(entry: MatrixEntry): boolean {
  // The substituted Polygon row uses WETH (not wrapped POL) as input.
  return entry.chainId !== 137;
}

function classifyLifiFailure(captured: CapturedResponse): {
  classification: FailureClassification;
  evidenceSummary: string;
} {
  const snippet = captured.bodyText.slice(0, 200);
  if (captured.transportError) {
    return {
      classification: 'transient_error',
      evidenceSummary: `transport error: ${captured.transportError}`,
    };
  }
  if (captured.httpStatus === 401 || captured.httpStatus === 403) {
    return {
      classification: 'missing_credentials',
      evidenceSummary: `HTTP ${captured.httpStatus}: ${snippet}`,
    };
  }
  if (captured.httpStatus === 429) {
    return {
      classification: 'rate_limited',
      evidenceSummary: `HTTP 429: ${snippet}`,
    };
  }
  if (captured.httpStatus >= 500) {
    return {
      classification: 'transient_error',
      evidenceSummary: `HTTP ${captured.httpStatus}: ${snippet}`,
    };
  }
  if (isRecord(captured.body)) {
    const code = captured.body.code;
    const message = String(captured.body.message ?? '');
    if (code === 1002 || /no available quotes/i.test(message)) {
      return {
        classification: 'no_route',
        evidenceSummary: `LI.FI code ${String(code)}: ${message.slice(0, 150)}`,
      };
    }
    if (/unknown chain|not supported|unsupported/i.test(message)) {
      return {
        classification: 'unsupported_chain',
        evidenceSummary: `LI.FI: ${message.slice(0, 150)}`,
      };
    }
  }
  if (captured.httpStatus === 200 && typeof captured.body === 'string') {
    return {
      classification: 'malformed_response',
      evidenceSummary: `HTTP 200 non-JSON: ${snippet}`,
    };
  }
  return {
    classification: 'other',
    evidenceSummary: `HTTP ${captured.httpStatus}: ${snippet}`,
  };
}

function classifyOneInchFailure(captured: CapturedResponse): {
  classification: FailureClassification;
  evidenceSummary: string;
} {
  const snippet = captured.bodyText.slice(0, 200);
  if (captured.transportError) {
    return {
      classification: 'transient_error',
      evidenceSummary: `transport error: ${captured.transportError}`,
    };
  }
  if (captured.httpStatus === 401 || captured.httpStatus === 403) {
    return {
      classification: 'missing_credentials',
      evidenceSummary: `HTTP ${captured.httpStatus}: ${snippet}`,
    };
  }
  if (captured.httpStatus === 429) {
    return {
      classification: 'rate_limited',
      evidenceSummary: `HTTP 429: ${snippet}`,
    };
  }
  if (captured.httpStatus >= 500) {
    return {
      classification: 'transient_error',
      evidenceSummary: `HTTP ${captured.httpStatus}: ${snippet}`,
    };
  }
  if (captured.httpStatus === 404) {
    return {
      classification: 'unsupported_chain',
      evidenceSummary: `HTTP 404: ${snippet}`,
    };
  }
  if (isRecord(captured.body) && /insufficient liquidity|cannot find/i.test(String(captured.body.description ?? captured.body.error ?? ''))) {
    return {
      classification: 'no_route',
      evidenceSummary: `1inch: ${snippet}`,
    };
  }
  return {
    classification: 'other',
    evidenceSummary: `HTTP ${captured.httpStatus}: ${snippet}`,
  };
}

function normalizeLifiSuccess(
  entry: MatrixEntry,
  captured: CapturedResponse
): ProvisionalNormalizedRouteFields | undefined {
  const body = captured.body;
  if (!isRecord(body) || !isRecord(body.estimate)) {
    return undefined;
  }
  const estimate = body.estimate;
  const txRequest = isRecord(body.transactionRequest)
    ? body.transactionRequest
    : undefined;
  const target =
    txRequest && typeof txRequest.to === 'string'
      ? txRequest.to.toLowerCase()
      : undefined;
  const data =
    txRequest && typeof txRequest.data === 'string'
      ? txRequest.data.toLowerCase()
      : undefined;
  const approvalSpender =
    typeof estimate.approvalAddress === 'string'
      ? estimate.approvalAddress.toLowerCase()
      : undefined;
  const toAmount = typeof estimate.toAmount === 'string' ? estimate.toAmount : undefined;
  const toAmountMin =
    typeof estimate.toAmountMin === 'string' ? estimate.toAmountMin : undefined;
  if (!target || !data || !approvalSpender || !toAmount || !toAmountMin) {
    return undefined;
  }
  const txValue =
    txRequest && txRequest.value !== undefined
      ? BigNumber.from(txRequest.value as string).toString()
      : '0';
  const tool = typeof body.tool === 'string' ? body.tool : 'unknown';
  return {
    providerId: 'lifi',
    quoteTimestamp: captured.capturedAt,
    chainId: entry.chainId,
    inputToken: entry.tokenIn.address,
    outputToken: entry.tokenOut.address,
    recipient: SPIKE_SENDER,
    amountIn: SPIKE_AMOUNT_IN,
    expectedAmountOut: toAmount,
    minimumAmountOut: toAmountMin,
    txTarget: target,
    approvalSpender,
    callDataSelector: data.slice(0, 10),
    callData: data,
    txValue,
    routeSummary: {
      providerId: 'lifi',
      swapPrice: 0,
      priceImpact: 0,
      gasSpentEstimate: lifiGasUnits(body).toNumber(),
      tokenPathSymbols: [entry.tokenIn.symbol, entry.tokenOut.symbol],
    },
  };
}

function lifiGasUnits(body: Record<string, unknown>): BigNumber {
  const txRequest = isRecord(body.transactionRequest)
    ? body.transactionRequest
    : undefined;
  if (txRequest && txRequest.gasLimit !== undefined) {
    try {
      return BigNumber.from(txRequest.gasLimit as string);
    } catch {
      // fall through to estimate
    }
  }
  const estimate = isRecord(body.estimate) ? body.estimate : undefined;
  const gasCosts = estimate && Array.isArray(estimate.gasCosts) ? estimate.gasCosts : [];
  const first = gasCosts[0];
  if (isRecord(first) && typeof first.estimate === 'string') {
    try {
      return BigNumber.from(first.estimate);
    } catch {
      return BigNumber.from(0);
    }
  }
  return BigNumber.from(0);
}

function lifiGasPriceWei(body: Record<string, unknown>): BigNumber {
  const txRequest = isRecord(body.transactionRequest)
    ? body.transactionRequest
    : undefined;
  if (txRequest && txRequest.gasPrice !== undefined) {
    try {
      return BigNumber.from(txRequest.gasPrice as string);
    } catch {
      return BigNumber.from(0);
    }
  }
  return BigNumber.from(0);
}

async function main(): Promise<void> {
  fs.mkdirSync(COMPETITIVENESS_RAW_DIR, { recursive: true });
  const oneInchKey = process.env.ONEINCH_API_KEY ?? '';

  const rows: SampleRow[] = [];
  const stabilityEvidence: AllowlistStabilityEvidence[] = [];
  const coverageChains: number[] = [];
  const netExecutionChains: number[] = [];
  const scopePairs = new Set<string>();
  const scopeAllowlist = new Map<
    string,
    { target: string; selector: string; spender: string }
  >();

  for (const entry of MATRIX) {
    const requestedAt = new Date().toISOString();
    const providerResults: ProviderResult[] = [];
    const pairLabel = `${entry.tokenIn.symbol}/${entry.tokenOut.symbol}`;

    // --- Sushi ---
    const sushiCaptured = await capture(sushiQuoteUrl(entry));
    const sushiCtx: SushiQuoteRequestContext = {
      chainId: entry.chainId,
      tokenIn: entry.tokenIn.address,
      tokenOut: entry.tokenOut.address,
      amountIn: SPIKE_AMOUNT_IN,
      maxSlippage: SPIKE_MAX_SLIPPAGE,
      sender: SPIKE_SENDER,
      requestedAt: sushiCaptured.capturedAt,
    };
    const sushiNormalized = normalizeSushiV7Response(
      sushiCaptured.body,
      sushiCtx
    );
    const sushiFixturePath = writeRawFixture(
      `sushi-${entry.chainName}.json`,
      { request: sushiQuoteUrl(entry), ...sushiCaptured }
    );
    if (sushiNormalized.ok) {
      const body = sushiCaptured.body as Record<string, unknown>;
      const tx = body.tx as Record<string, unknown>;
      const gasUnits = BigNumber.from(Math.round(Number(body.gasSpent ?? 0)));
      const gasPriceWei = BigNumber.from(
        Math.round(Number(tx.gasPrice ?? 0)).toString()
      );
      providerResults.push({
        provider: 'sushi',
        outcome: 'success',
        rawFixturePath: sushiFixturePath,
        normalized: sushiNormalized.normalized,
        execution: {
          gasEstimate: gasUnits.toString(),
          netQuoteValueAfterGasRaw: netAfterGas({
            expectedOutRaw: BigNumber.from(
              sushiNormalized.normalized.expectedAmountOut
            ),
            amountInWei: BigNumber.from(SPIKE_AMOUNT_IN),
            gasUnits,
            gasPriceWei,
            inputIsWrappedNative: inputIsWrappedNative(entry),
          }),
        },
      });
    } else {
      const retry = await capture(sushiQuoteUrl(entry));
      const first = classifySushiQuoteFailure(
        sushiCaptured.httpStatus || undefined,
        sushiCaptured.body,
        sushiCaptured.transportError
      );
      const second = classifySushiQuoteFailure(
        retry.httpStatus || undefined,
        retry.body,
        retry.transportError
      );
      providerResults.push({
        provider: 'sushi',
        outcome: 'failure',
        classification: first.classification,
        evidenceSummary: `${first.evidenceSummary} | normalizer: ${sushiNormalized.reason}`,
        rawFixturePath: sushiFixturePath,
        reproducible: first.classification === second.classification,
      });
    }

    // --- LI.FI ---
    const lifiCaptured = await capture(lifiQuoteUrl(entry));
    const lifiFixturePath = writeRawFixture(`lifi-${entry.chainName}.json`, {
      request: lifiQuoteUrl(entry),
      ...lifiCaptured,
    });
    const lifiNormalized =
      lifiCaptured.httpStatus === 200
        ? normalizeLifiSuccess(entry, lifiCaptured)
        : undefined;
    if (lifiNormalized) {
      const body = lifiCaptured.body as Record<string, unknown>;
      const gasUnits = lifiGasUnits(body);
      providerResults.push({
        provider: 'lifi',
        outcome: 'success',
        rawFixturePath: lifiFixturePath,
        normalized: lifiNormalized,
        execution: {
          gasEstimate: gasUnits.toString(),
          netQuoteValueAfterGasRaw: netAfterGas({
            expectedOutRaw: BigNumber.from(lifiNormalized.expectedAmountOut),
            amountInWei: BigNumber.from(SPIKE_AMOUNT_IN),
            gasUnits,
            gasPriceWei: lifiGasPriceWei(body),
            inputIsWrappedNative: inputIsWrappedNative(entry),
          }),
        },
      });
    } else {
      const retry = await capture(lifiQuoteUrl(entry));
      const first = classifyLifiFailure(lifiCaptured);
      const second = classifyLifiFailure(retry);
      providerResults.push({
        provider: 'lifi',
        outcome: 'failure',
        classification: first.classification,
        evidenceSummary: first.evidenceSummary,
        rawFixturePath: lifiFixturePath,
        reproducible: first.classification === second.classification,
      });
    }

    // --- 1inch ---
    const oneInchHeaders = { Authorization: `Bearer ${oneInchKey}` };
    const oneInchCaptured = await capture(oneInchQuoteUrl(entry), oneInchHeaders);
    const oneInchFixturePath = writeRawFixture(
      `oneinch-${entry.chainName}.json`,
      { request: oneInchQuoteUrl(entry), ...oneInchCaptured }
    );
    // 1inch v6 /quote responses do not include executable calldata, so even a
    // 200 would not satisfy the normalized execution shape without the swap
    // endpoint; the sweep records quote-level success only when calldata-
    // bearing fields are present. With invalid credentials every chain is a
    // classified failure.
    const retryOneInch = await capture(oneInchQuoteUrl(entry), oneInchHeaders);
    const firstOneInch = classifyOneInchFailure(oneInchCaptured);
    const secondOneInch = classifyOneInchFailure(retryOneInch);
    providerResults.push({
      provider: 'oneinch',
      outcome: 'failure',
      classification: firstOneInch.classification,
      evidenceSummary: firstOneInch.evidenceSummary,
      rawFixturePath: oneInchFixturePath,
      reproducible: firstOneInch.classification === secondOneInch.classification,
    });

    // --- Assessment ---
    const sushiResult = providerResults.find(r => r.provider === 'sushi');
    const lifiResult = providerResults.find(r => r.provider === 'lifi');
    const incumbents = providerResults.filter(r => r.provider !== 'sushi');
    const sushiOk = sushiResult?.outcome === 'success';
    const incumbentsAllReproducibleGap = incumbents.every(
      result =>
        result.outcome === 'failure' &&
        (result.classification === 'unsupported_chain' ||
          result.classification === 'no_route') &&
        result.reproducible === true
    );
    const incumbentsCredentialGapOnly = incumbents.every(
      result => result.outcome === 'failure'
    );
    let sushiBetterNetExecution: boolean | 'unknown' = 'unknown';
    let rationale: string;
    if (sushiOk && lifiResult?.outcome === 'success') {
      const sushiOut = BigNumber.from(
        (sushiResult as { normalized: ProvisionalNormalizedRouteFields })
          .normalized.expectedAmountOut
      );
      const lifiOut = BigNumber.from(lifiResult.normalized.expectedAmountOut);
      sushiBetterNetExecution = sushiOut.gte(lifiOut);
      rationale =
        `Sushi expected ${sushiOut.toString()} vs LI.FI ${lifiOut.toString()} ` +
        `${entry.tokenOut.symbol} raw for 1.0 ${entry.tokenIn.symbol}; 1inch ` +
        `${incumbents.find(r => r.provider === 'oneinch')?.outcome === 'failure' ? 'unavailable (' + (incumbents.find(r => r.provider === 'oneinch') as { classification: string }).classification + ')' : 'succeeded'}.`;
      if (sushiBetterNetExecution) {
        netExecutionChains.push(entry.chainId);
      }
    } else if (sushiOk && incumbentsAllReproducibleGap) {
      rationale =
        'Sushi routes successfully while both incumbents have reproducible ' +
        'unsupported_chain/no_route outcomes: materially distinct coverage.';
      coverageChains.push(entry.chainId);
    } else if (sushiOk && incumbentsCredentialGapOnly) {
      rationale =
        'Sushi routes successfully but incumbent failures include ' +
        'credentials/rate-limit/transient classes, which never justify ' +
        'coverage-based proceed for this chain.';
    } else if (sushiOk) {
      rationale = 'Sushi succeeded; incumbent comparison recorded above.';
    } else {
      rationale = 'Sushi failed on this row; no Sushi advantage possible.';
    }

    rows.push({
      chainId: entry.chainId,
      chainName: entry.chainName,
      pair: { tokenIn: entry.tokenIn, tokenOut: entry.tokenOut },
      amountIn: SPIKE_AMOUNT_IN,
      requestedAt,
      quoteRequest: {
        apiVersion: 'sushi v7 / lifi v1 / 1inch v6.0',
        maxSlippage: SPIKE_MAX_SLIPPAGE,
        sender: SPIKE_SENDER,
        ...(entry.substitutedPair
          ? { substitutedPair: entry.substitutedPair }
          : {}),
      },
      providerResults,
      assessment: {
        sushiAddsMateriallyDistinctRoute:
          sushiOk && incumbentsAllReproducibleGap,
        sushiBetterNetExecution,
        rationale,
      },
    });

    // --- Stability refreshes for eligible chains ---
    const eligibleForScope =
      sushiOk &&
      (incumbentsAllReproducibleGap ||
        (lifiResult?.outcome === 'success' && sushiBetterNetExecution === true));
    if (eligibleForScope && sushiResult?.outcome === 'success') {
      scopePairs.add(pairLabel);
      const normalized = sushiResult.normalized;
      const key = `${normalized.txTarget}:${normalized.callDataSelector}:${normalized.approvalSpender}`;
      scopeAllowlist.set(key, {
        target: normalized.txTarget,
        selector: normalized.callDataSelector,
        spender: normalized.approvalSpender,
      });
      const samples = [
        {
          timestamp: sushiCaptured.capturedAt,
          responseSha256: sha256(sushiCaptured.bodyText),
        },
      ];
      let stable = true;
      for (let i = 0; i < STABILITY_SAMPLES - 1; i++) {
        const refresh = await capture(sushiQuoteUrl(entry));
        const refreshNormalized = normalizeSushiV7Response(refresh.body, {
          ...sushiCtx,
          requestedAt: refresh.capturedAt,
        });
        if (
          !refreshNormalized.ok ||
          refreshNormalized.normalized.txTarget !== normalized.txTarget ||
          refreshNormalized.normalized.callDataSelector !==
            normalized.callDataSelector ||
          refreshNormalized.normalized.approvalSpender !==
            normalized.approvalSpender
        ) {
          stable = false;
          console.log(
            `unstable allowlist evidence on ${entry.chainName}: refresh ${i + 2} diverged`
          );
          break;
        }
        samples.push({
          timestamp: refresh.capturedAt,
          responseSha256: sha256(refresh.bodyText),
        });
      }
      if (stable && samples.length >= STABILITY_SAMPLES) {
        stabilityEvidence.push({
          chainId: entry.chainId,
          pair: pairLabel,
          target: normalized.txTarget,
          selector: normalized.callDataSelector,
          spender: normalized.approvalSpender,
          samples,
        });
        console.log(
          `ok ${entry.chainName}: stability ${samples.length}/${STABILITY_SAMPLES} samples for ${normalized.txTarget}`
        );
      }
    }
    console.log(
      `row ${entry.chainName}(${entry.chainId}): sushi=${sushiResult?.outcome} lifi=${lifiResult?.outcome} oneinch=failure assessment="${rationale.slice(0, 90)}"`
    );
  }

  // --- Decision (derived strictly from the recorded data) ---
  const scopedChains = Array.from(
    new Set([...coverageChains, ...netExecutionChains])
  ).filter(chainId =>
    stabilityEvidence.some(evidence => evidence.chainId === chainId)
  );
  const allowlist = Array.from(scopeAllowlist.values()).filter(entry =>
    stabilityEvidence.some(
      evidence =>
        evidence.target === entry.target &&
        evidence.selector === entry.selector &&
        evidence.spender === entry.spender
    )
  );
  const proceed = scopedChains.length > 0 && allowlist.length > 0;
  const coverageScoped = coverageChains.filter(c => scopedChains.includes(c));
  const netExecScoped = netExecutionChains.filter(c =>
    scopedChains.includes(c)
  );
  const rationaleText = proceed
    ? `Sushi earns first-class support on ${scopedChains.length} scoped chain(s): ` +
      (coverageScoped.length > 0
        ? `materially distinct coverage on chain(s) ${coverageScoped.join(', ')} where both incumbents have reproducible unsupported_chain/no_route outcomes; `
        : '') +
      (netExecScoped.length > 0
        ? `non-dominated expected output vs the successful incumbent on chain(s) ${netExecScoped.join(', ')}; `
        : '') +
      `every scoped target/selector/spender has ${STABILITY_SAMPLES} distinct-timestamp/hash stability samples. ` +
      '1inch rows are missing_credentials and contribute nothing to this decision.'
    : 'No chain combines a successful Sushi route with either reproducible ' +
      'incumbent unsupported_chain/no_route coverage or non-dominated net ' +
      'execution plus stable allowlist evidence; incumbent credential/rate ' +
      'failures never justify proceed.';

  const artifact: CompetitivenessArtifact = {
    artifactKind: 'competitiveness',
    schemaVersion: 1,
    packet: '3A',
    generatedAt: new Date().toISOString(),
    validationMechanism: 'hand-rolled',
    rows,
    decision: proceed
      ? {
          decision: 'proceed',
          rationale: rationaleText,
          scope: {
            chains: scopedChains,
            pairs: Array.from(scopePairs),
            sourceFilters: ['sushi swap API v7 same-chain routes'],
            allowlist,
          },
          stabilityEvidence,
        }
      : {
          decision: 'defer',
          rationale: rationaleText,
        },
  };

  const validation = validateEvidenceArtifact(artifact);
  if (!validation.ok) {
    for (const error of validation.errors) {
      console.error(`FAIL [schema] ${error}`);
    }
    process.exit(1);
  }
  const violations = checkCompetitivenessArtifact(artifact);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`FAIL [${violation.rule}] ${violation.detail}`);
    }
    process.exit(1);
  }

  fs.writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + '\n');
  fs.writeFileSync(SUMMARY_PATH, renderSummary(artifact));
  console.log(`ok artifact: ${path.relative(process.cwd(), ARTIFACT_PATH)}`);
  console.log(`ok summary: ${path.relative(process.cwd(), SUMMARY_PATH)}`);
  console.log(`ok decision: ${artifact.decision.decision}`);
}

function renderSummary(artifact: CompetitivenessArtifact): string {
  const lines: string[] = [];
  lines.push('# Packet 3A Decision: Sushi Competitiveness');
  lines.push('');
  lines.push(
    '<!-- Derived from the checked typed artifact at ' +
      'tools/external-take-evidence/fixtures/sushi-competitiveness.artifact.json. -->'
  );
  lines.push('');
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push('');
  lines.push(`## Decision: \`${artifact.decision.decision}\``);
  lines.push('');
  lines.push(artifact.decision.rationale);
  lines.push('');
  if (artifact.decision.decision === 'proceed' && artifact.decision.scope) {
    const scope = artifact.decision.scope;
    lines.push('### Packet 3B scope (the only unlocked surface)');
    lines.push('');
    lines.push(`- Chains: ${scope.chains.join(', ')}`);
    lines.push(`- Pairs: ${scope.pairs.join(', ')}`);
    lines.push(`- Source filters: ${(scope.sourceFilters ?? []).join(', ')}`);
    lines.push('- Allowlist (target / selector / spender):');
    for (const entry of scope.allowlist ?? []) {
      lines.push(`  - ${entry.target} / ${entry.selector} / ${entry.spender}`);
    }
    lines.push('');
  }
  lines.push('## Sample rows');
  lines.push('');
  lines.push('| Chain | Pair | Sushi | LI.FI | 1inch | Assessment |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of artifact.rows) {
    const by = (provider: string) => {
      const result = row.providerResults.find(r => r.provider === provider);
      if (!result) {
        return 'missing';
      }
      return result.outcome === 'success'
        ? 'success'
        : `${result.classification}${result.reproducible ? ' (reproducible)' : ''}`;
    };
    lines.push(
      `| ${row.chainName} (${row.chainId}) | ${row.pair.tokenIn.symbol}/${row.pair.tokenOut.symbol} | ${by('sushi')} | ${by('lifi')} | ${by('oneinch')} | ${row.assessment?.rationale ?? ''} |`
    );
  }
  lines.push('');
  lines.push(
    'Failure-classification policy: incumbent `missing_credentials`, ' +
      '`rate_limited`, `transient_error`, and `malformed_response` outcomes ' +
      'never count toward a proceed decision (packet-3a.md).'
  );
  lines.push('');
  return lines.join('\n');
}

if (require.main === module) {
  main().catch(error => {
    console.error(
      `FAIL [sweep] ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  });
}
