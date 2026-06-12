// Read-only Packet 2A evidence refresher (SushiSwap aggregator roadmap).
//
// Fetches the minimum same-chain Sushi route fixture matrix (packet-2a.md):
// Ethereum mainnet, Base, Arbitrum, Optimism, Polygon, Avalanche, and Hemi,
// wrapped-native (or substituted keeper-relevant collateral) into the chain's
// production USDC/stable token. Writes raw response fixtures, normalizes each
// successful route through the tooling-only Sushi normalizer, and rebuilds
// the typed route_shape evidence artifact.
//
// This script is convenience tooling for refreshing evidence. The committed
// fixtures plus the offline unit tests are the proof; a live run is never
// required for the gates. The script performs HTTP GET quote requests only —
// no wallet, no RPC writes, no broadcast.
//
// Usage: npm run refresh-sushi-route-shape-evidence
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import {
  EvidenceTokenRef,
  ProviderResult,
  RouteShapeArtifact,
  SampleRow,
  ObservedResponseShape,
  routeShapeSuccessFloorMet,
  validateEvidenceArtifact,
} from '../tools/external-take-evidence/evidence-schema';
import {
  PROVEN_SUSHI_RESPONSE_SHAPES,
  SUSHI_V7_API_BASE,
  classifySushiQuoteFailure,
  normalizeSushiV7Response,
} from '../tools/external-take-evidence/sushi-route-normalizer';

const EVIDENCE_DIR = path.join(
  __dirname,
  '..',
  'tools',
  'external-take-evidence'
);
const FIXTURES_DIR = path.join(EVIDENCE_DIR, 'fixtures');
const RAW_DIR = path.join(FIXTURES_DIR, 'raw');
const ARTIFACT_PATH = path.join(FIXTURES_DIR, 'sushi-route-shape.artifact.json');

// Spike-only quote identity: a burn address keeps committed fixtures clearly
// detached from any operator wallet. The API's recipient param was verified
// to rewrite the encoded recipient; default recipient is the sender.
const SPIKE_SENDER = '0x000000000000000000000000000000000000dead';
const SPIKE_MAX_SLIPPAGE = 0.005;
const SPIKE_AMOUNT_IN = '1000000000000000000'; // 1.0 of an 18-decimal input

interface MatrixEntry {
  chainId: number;
  chainName: string;
  tokenIn: EvidenceTokenRef;
  tokenOut: EvidenceTokenRef;
  substitutedPair?: { reason: string };
}

const POLYGON_SUBSTITUTION_REASON =
  'Preferred wrapped-native POL input returns the unproven 0xd33721a5 ' +
  'response shape on Polygon (recorded separately as an ambiguous ' +
  'fail-closed fixture); WETH into the production USDC quote token is the ' +
  'substituted keeper-relevant collateral pair.';

const MATRIX: readonly MatrixEntry[] = [
  {
    chainId: 1,
    chainName: 'ethereum',
    tokenIn: {
      address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      symbol: 'WETH',
      decimals: 18,
    },
    tokenOut: {
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      symbol: 'USDC',
      decimals: 6,
    },
  },
  {
    chainId: 8453,
    chainName: 'base',
    tokenIn: {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      decimals: 18,
    },
    tokenOut: {
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      symbol: 'USDC',
      decimals: 6,
    },
  },
  {
    chainId: 42161,
    chainName: 'arbitrum',
    tokenIn: {
      address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
      symbol: 'WETH',
      decimals: 18,
    },
    tokenOut: {
      address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      symbol: 'USDC',
      decimals: 6,
    },
  },
  {
    chainId: 10,
    chainName: 'optimism',
    tokenIn: {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      decimals: 18,
    },
    tokenOut: {
      address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      symbol: 'USDC',
      decimals: 6,
    },
  },
  {
    chainId: 137,
    chainName: 'polygon',
    tokenIn: {
      address: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
      symbol: 'WETH',
      decimals: 18,
    },
    tokenOut: {
      address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      symbol: 'USDC',
      decimals: 6,
    },
    substitutedPair: { reason: POLYGON_SUBSTITUTION_REASON },
  },
  {
    chainId: 43114,
    chainName: 'avalanche',
    tokenIn: {
      address: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
      symbol: 'WAVAX',
      decimals: 18,
    },
    tokenOut: {
      address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      symbol: 'USDC',
      decimals: 6,
    },
  },
  {
    chainId: 43111,
    chainName: 'hemi',
    tokenIn: {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      decimals: 18,
    },
    tokenOut: {
      address: '0xad11a8beb98bbf61dbb1aa0f6d6f2ecd87b35afa',
      symbol: 'USDC.e',
      decimals: 6,
    },
  },
];

// Real Polygon wrapped-native pair that produced the unproven second
// response shape during the spike; committed as the ambiguous fail-closed
// fixture required by packet-2a.md.
const POLYGON_AMBIGUOUS_PAIR = {
  chainId: 137,
  chainName: 'polygon',
  tokenIn: {
    address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
    symbol: 'WPOL',
    decimals: 18,
  },
  tokenOut: {
    address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    symbol: 'USDC',
    decimals: 6,
  },
};

interface HttpResult {
  status: number;
  bodyText: string;
}

function httpGetText(url: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { accept: 'application/json' }, timeout: 30_000 },
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

function quoteUrl(chainId: number, tokenIn: string, tokenOut: string): string {
  return (
    `${SUSHI_V7_API_BASE}/${chainId}` +
    `?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amount=${SPIKE_AMOUNT_IN}` +
    `&maxSlippage=${SPIKE_MAX_SLIPPAGE}&sender=${SPIKE_SENDER}`
  );
}

interface RawFixture {
  fixtureKind: 'sushi_v7_raw_response';
  capturedAt: string;
  expectedNormalization: 'success' | 'fail_closed';
  expectedClassification?: string;
  synthetic: boolean;
  mutation?: string;
  request: {
    chainId: number;
    chainName: string;
    url: string;
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

function writeFixture(fileName: string, fixture: RawFixture): string {
  fs.writeFileSync(
    path.join(RAW_DIR, fileName),
    JSON.stringify(fixture, null, 2) + '\n'
  );
  return `raw/${fileName}`;
}

function parseBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

async function captureQuote(
  chainId: number,
  chainName: string,
  tokenIn: EvidenceTokenRef,
  tokenOut: EvidenceTokenRef
): Promise<{ fixture: RawFixture; transportError?: string }> {
  const url = quoteUrl(chainId, tokenIn.address, tokenOut.address);
  const capturedAt = new Date().toISOString();
  const request = {
    chainId,
    chainName,
    url,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn: SPIKE_AMOUNT_IN,
    maxSlippage: SPIKE_MAX_SLIPPAGE,
    sender: SPIKE_SENDER,
  };
  try {
    const { status, bodyText } = await httpGetText(url);
    return {
      fixture: {
        fixtureKind: 'sushi_v7_raw_response',
        capturedAt,
        expectedNormalization: 'success',
        synthetic: false,
        request,
        httpStatus: status,
        response: parseBody(bodyText),
      },
    };
  } catch (error) {
    return {
      fixture: {
        fixtureKind: 'sushi_v7_raw_response',
        capturedAt,
        expectedNormalization: 'fail_closed',
        synthetic: false,
        request,
        httpStatus: 0,
        response: null,
      },
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const rows: SampleRow[] = [];
  const provenShapeChains: number[] = [];
  const unprovenShapes: ObservedResponseShape[] = [];
  let ethereumSuccessFixture: RawFixture | undefined;

  for (const entry of MATRIX) {
    const fileName =
      `sushi-v7-${entry.chainName}-` +
      `${entry.tokenIn.symbol.toLowerCase().replace(/[^a-z0-9]/g, '')}-` +
      `${entry.tokenOut.symbol.toLowerCase().replace(/[^a-z0-9]/g, '')}.json`;
    const { fixture, transportError } = await captureQuote(
      entry.chainId,
      entry.chainName,
      entry.tokenIn,
      entry.tokenOut
    );
    const normalization = normalizeSushiV7Response(fixture.response, {
      chainId: entry.chainId,
      tokenIn: entry.tokenIn.address,
      tokenOut: entry.tokenOut.address,
      amountIn: SPIKE_AMOUNT_IN,
      maxSlippage: SPIKE_MAX_SLIPPAGE,
      sender: SPIKE_SENDER,
      requestedAt: fixture.capturedAt,
    });

    let providerResult: ProviderResult;
    if (normalization.ok) {
      fixture.expectedNormalization = 'success';
      const rawFixturePath = writeFixture(fileName, fixture);
      providerResult = {
        provider: 'sushi',
        outcome: 'success',
        rawFixturePath,
        normalized: normalization.normalized,
      };
      if (provenShapeChains.indexOf(entry.chainId) < 0) {
        provenShapeChains.push(entry.chainId);
      }
      if (entry.chainId === 1) {
        ethereumSuccessFixture = fixture;
      }
      console.log(
        `ok ${entry.chainName}(${entry.chainId}): normalized ` +
          `${normalization.normalized.callDataSelector} via ` +
          `${normalization.normalized.txTarget}`
      );
    } else {
      fixture.expectedNormalization = 'fail_closed';
      const classified = classifySushiQuoteFailure(
        fixture.httpStatus || undefined,
        fixture.response,
        transportError
      );
      fixture.expectedClassification = classified.classification;
      const rawFixturePath = writeFixture(fileName, fixture);
      providerResult = {
        provider: 'sushi',
        outcome: 'failure',
        classification: classified.classification,
        evidenceSummary: `${classified.evidenceSummary} | normalizer: ${normalization.reason}`,
        rawFixturePath,
      };
      console.log(
        `classified ${entry.chainName}(${entry.chainId}): ` +
          `${classified.classification} (${normalization.reason})`
      );
    }

    rows.push({
      chainId: entry.chainId,
      chainName: entry.chainName,
      pair: { tokenIn: entry.tokenIn, tokenOut: entry.tokenOut },
      amountIn: SPIKE_AMOUNT_IN,
      requestedAt: fixture.capturedAt,
      quoteRequest: {
        apiVersion: 'v7',
        maxSlippage: SPIKE_MAX_SLIPPAGE,
        sender: SPIKE_SENDER,
        ...(entry.substitutedPair
          ? { substitutedPair: entry.substitutedPair }
          : {}),
      },
      providerResults: [providerResult],
    });
  }

  // Ambiguous real-response fixture: Polygon wrapped-native input returns a
  // second selector whose head layout is not proven; it must fail closed.
  const ambiguous = await captureQuote(
    POLYGON_AMBIGUOUS_PAIR.chainId,
    POLYGON_AMBIGUOUS_PAIR.chainName,
    POLYGON_AMBIGUOUS_PAIR.tokenIn,
    POLYGON_AMBIGUOUS_PAIR.tokenOut
  );
  ambiguous.fixture.expectedNormalization = 'fail_closed';
  const ambiguousResponse = ambiguous.fixture.response as Record<
    string,
    unknown
  >;
  const ambiguousTx =
    ambiguousResponse && typeof ambiguousResponse === 'object'
      ? (ambiguousResponse.tx as Record<string, unknown> | undefined)
      : undefined;
  const ambiguousSelector =
    ambiguousTx && typeof ambiguousTx.data === 'string'
      ? ambiguousTx.data.slice(0, 10).toLowerCase()
      : undefined;
  writeFixture(
    'sushi-v7-polygon-wpol-usdc-ambiguous-shape.json',
    ambiguous.fixture
  );
  if (
    ambiguousSelector &&
    !PROVEN_SUSHI_RESPONSE_SHAPES.some(s => s.selector === ambiguousSelector)
  ) {
    unprovenShapes.push({
      selector: ambiguousSelector,
      headLayout:
        'unproven: head words do not match the proven ' +
        '(tokenIn, amountIn, recipient, tokenOut, amountOutMin) layout',
      chains: [POLYGON_AMBIGUOUS_PAIR.chainId],
      proven: false,
    });
    console.log(
      `recorded ambiguous shape ${ambiguousSelector} (polygon wrapped-native input)`
    );
  }

  // Synthetic malformed fixture: a real success response with tx.data
  // removed; the normalizer must fail closed on missing execution fields.
  if (ethereumSuccessFixture) {
    const malformedResponse = JSON.parse(
      JSON.stringify(ethereumSuccessFixture.response)
    ) as Record<string, unknown>;
    if (
      malformedResponse.tx &&
      typeof malformedResponse.tx === 'object' &&
      malformedResponse.tx !== null
    ) {
      delete (malformedResponse.tx as Record<string, unknown>).data;
    }
    writeFixture('sushi-v7-synthetic-malformed-missing-txdata.json', {
      ...ethereumSuccessFixture,
      expectedNormalization: 'fail_closed',
      synthetic: true,
      mutation:
        'tx.data removed from the recorded Ethereum response to prove ' +
        'missing execution fields fail closed',
      response: malformedResponse,
    });
  }

  // Classified failure-shape references for the shared classification union.
  const invalidTokenUrl = quoteUrl(
    8453,
    '0x4200000000000000000000000000000000000006',
    '0x00000000000000000000000000000000000000aa'
  );
  const invalidTokenCaptured = new Date().toISOString();
  const invalidTokenResult = await httpGetText(invalidTokenUrl);
  writeFixture('sushi-v7-base-invalid-token-422.json', {
    fixtureKind: 'sushi_v7_raw_response',
    capturedAt: invalidTokenCaptured,
    expectedNormalization: 'fail_closed',
    expectedClassification: 'no_route',
    synthetic: false,
    request: {
      chainId: 8453,
      chainName: 'base',
      url: invalidTokenUrl,
      tokenIn: '0x4200000000000000000000000000000000000006',
      tokenOut: '0x00000000000000000000000000000000000000aa',
      amountIn: SPIKE_AMOUNT_IN,
      maxSlippage: SPIKE_MAX_SLIPPAGE,
      sender: SPIKE_SENDER,
    },
    httpStatus: invalidTokenResult.status,
    response: parseBody(invalidTokenResult.bodyText),
  });

  const unsupportedChainUrl = quoteUrl(
    424242,
    '0x4200000000000000000000000000000000000006',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  );
  const unsupportedCaptured = new Date().toISOString();
  const unsupportedResult = await httpGetText(unsupportedChainUrl);
  writeFixture('sushi-v7-unsupported-chain-404.json', {
    fixtureKind: 'sushi_v7_raw_response',
    capturedAt: unsupportedCaptured,
    expectedNormalization: 'fail_closed',
    expectedClassification: 'unsupported_chain',
    synthetic: false,
    request: {
      chainId: 424242,
      chainName: 'unsupported-chain-424242',
      url: unsupportedChainUrl,
      tokenIn: '0x4200000000000000000000000000000000000006',
      tokenOut: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amountIn: SPIKE_AMOUNT_IN,
      maxSlippage: SPIKE_MAX_SLIPPAGE,
      sender: SPIKE_SENDER,
    },
    httpStatus: unsupportedResult.status,
    response: parseBody(unsupportedResult.bodyText),
  });

  const artifact: RouteShapeArtifact = {
    artifactKind: 'route_shape',
    schemaVersion: 1,
    packet: '2A',
    provider: 'sushi',
    generatedAt: new Date().toISOString(),
    validationMechanism: 'hand-rolled',
    apiBase: SUSHI_V7_API_BASE,
    observedResponseShapes: [
      {
        selector: PROVEN_SUSHI_RESPONSE_SHAPES[0].selector,
        headLayout: PROVEN_SUSHI_RESPONSE_SHAPES[0].headLayout,
        chains: provenShapeChains,
        proven: true,
      },
      ...unprovenShapes,
    ],
    rows,
  };

  const validation = validateEvidenceArtifact(artifact);
  if (!validation.ok) {
    for (const error of validation.errors) {
      console.error(`FAIL [schema] ${error}`);
    }
    process.exit(1);
  }
  const floor = routeShapeSuccessFloorMet(artifact);
  if (!floor.met) {
    console.error(
      `FAIL [floor] objective successful-route floor unmet: ${floor.detail}. ` +
        'Packet 2B is blocked or must be scope-limited to the proven shape.'
    );
    process.exit(1);
  }

  fs.writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`ok artifact written: ${path.relative(process.cwd(), ARTIFACT_PATH)}`);
  console.log(`ok floor: ${floor.detail}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`FAIL [refresh] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
