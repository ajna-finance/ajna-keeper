// Tooling-only evidence schema for the SushiSwap aggregator roadmap
// (Packet 2A route-shape evidence and the Packet 3A competitiveness wrapper).
//
// This module is the single owner of the shared evidence components
// (ProviderResult, SampleRow, FailureClassification) and the discriminated
// artifact union (route_shape | competitiveness) used by Packets 2A and 3A.
//
// Validation mechanism decision (recorded per packet-2a.md): HAND-ROLLED
// checks, no schema-validation dependency. Rationale: zero new dependencies
// under the pinned toolchain (docs/adr/0001), matching the repo's existing
// hand-rolled parser posture (no-spend env/policy parsing). Packet 3A must
// reuse this module and must not introduce a second validation mechanism.
//
// BOUNDARY: production src/** must never import this module, its types, or
// recorded evidence artifacts. tests/unit/evidence-tooling-boundary.test.ts
// enforces this. The proposed execution-quote field names validated here are
// a Packet 2A proposal only; Packet 2B owns freezing the production
// ApprovedCalldataAggregatorQuote type.

export const EVIDENCE_PROVIDERS = ['sushi', 'lifi', 'oneinch'] as const;
export type EvidenceProvider = (typeof EVIDENCE_PROVIDERS)[number];

export const FAILURE_CLASSIFICATIONS = [
  'unsupported_chain',
  'no_route',
  'missing_credentials',
  'rate_limited',
  'transient_error',
  'malformed_response',
  'other',
] as const;
export type FailureClassification = (typeof FAILURE_CLASSIFICATIONS)[number];

export interface EvidenceTokenRef {
  address: string;
  symbol: string;
  decimals: number;
}

// Proposed ApprovedCalldataAggregatorQuote execution fields (plan: Shared
// Offchain Core). Provisional in Packet 2A; frozen by Packet 2B.
export interface ProvisionalNormalizedRouteFields {
  providerId: string;
  quoteTimestamp: string;
  chainId: number;
  inputToken: string;
  outputToken: string;
  recipient: string;
  amountIn: string;
  expectedAmountOut: string;
  minimumAmountOut: string;
  txTarget: string;
  approvalSpender: string;
  callDataSelector: string;
  callData: string;
  txValue: string;
  routeSummary: {
    providerId: string;
    swapPrice: number;
    priceImpact: number;
    gasSpentEstimate: number;
    tokenPathSymbols: string[];
  };
}

export interface ProviderSuccessResult {
  provider: EvidenceProvider;
  outcome: 'success';
  rawFixturePath: string;
  normalized: ProvisionalNormalizedRouteFields;
}

export interface ProviderFailureResult {
  provider: EvidenceProvider;
  outcome: 'failure';
  classification: FailureClassification;
  evidenceSummary: string;
  rawFixturePath?: string;
}

export type ProviderResult = ProviderSuccessResult | ProviderFailureResult;

export interface SampleRow {
  chainId: number;
  chainName: string;
  pair: { tokenIn: EvidenceTokenRef; tokenOut: EvidenceTokenRef };
  amountIn: string;
  requestedAt: string;
  quoteRequest: {
    apiVersion: string;
    maxSlippage: number;
    sender: string;
    recipient?: string;
    substitutedPair?: { reason: string };
  };
  providerResults: ProviderResult[];
}

export interface ObservedResponseShape {
  selector: string;
  headLayout: string;
  chains: number[];
  proven: boolean;
}

export interface RouteShapeArtifact {
  artifactKind: 'route_shape';
  schemaVersion: 1;
  packet: '2A';
  provider: 'sushi';
  generatedAt: string;
  validationMechanism: 'hand-rolled';
  apiBase: string;
  observedResponseShapes: ObservedResponseShape[];
  rows: SampleRow[];
}

export interface CompetitivenessDecisionBlock {
  decision: 'proceed' | 'defer';
  rationale: string;
  scope?: {
    chains: number[];
    pairs: string[];
    sourceFilters?: string[];
    allowlist?: { target: string; selector: string; spender: string }[];
  };
  modelDocRef?: string;
}

// Wrapper shape Packet 3A must reuse. Packet 2A defines it but never
// populates a competitiveness artifact.
export interface CompetitivenessArtifact {
  artifactKind: 'competitiveness';
  schemaVersion: 1;
  packet: '3A';
  generatedAt: string;
  validationMechanism: 'hand-rolled';
  rows: SampleRow[];
  decision: CompetitivenessDecisionBlock;
}

export type EvidenceArtifact = RouteShapeArtifact | CompetitivenessArtifact;

export type ValidationResult =
  | { ok: true; artifact: EvidenceArtifact }
  | { ok: false; errors: string[] };

const HEX_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HEX_SELECTOR_RE = /^0x[0-9a-f]{8}$/;
const HEX_DATA_RE = /^0x[0-9a-f]*$/;
const DECIMAL_STRING_RE = /^(0|[1-9][0-9]*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    !isNaN(new Date(value).getTime())
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === 'string' && allowed.indexOf(value as T) >= 0;
}

function validateTokenRef(
  value: unknown,
  path: string,
  errors: string[]
): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected token object`);
    return;
  }
  if (
    typeof value.address !== 'string' ||
    !HEX_ADDRESS_RE.test(value.address)
  ) {
    errors.push(`${path}.address: expected lowercase 0x-prefixed address`);
  }
  if (typeof value.symbol !== 'string' || value.symbol.length === 0) {
    errors.push(`${path}.symbol: expected non-empty string`);
  }
  if (
    typeof value.decimals !== 'number' ||
    value.decimals < 0 ||
    value.decimals > 255 ||
    Math.floor(value.decimals) !== value.decimals
  ) {
    errors.push(`${path}.decimals: expected integer 0..255`);
  }
}

function validateNormalizedFields(
  value: unknown,
  path: string,
  errors: string[]
): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected normalized route object`);
    return;
  }
  if (typeof value.providerId !== 'string' || value.providerId.length === 0) {
    errors.push(`${path}.providerId: expected non-empty string`);
  }
  if (!isIsoTimestamp(value.quoteTimestamp)) {
    errors.push(`${path}.quoteTimestamp: expected ISO timestamp`);
  }
  if (!isFiniteNumber(value.chainId) || value.chainId <= 0) {
    errors.push(`${path}.chainId: expected positive number`);
  }
  const addressFields = [
    'inputToken',
    'outputToken',
    'recipient',
    'txTarget',
    'approvalSpender',
  ];
  for (const field of addressFields) {
    const fieldValue = value[field];
    if (typeof fieldValue !== 'string' || !HEX_ADDRESS_RE.test(fieldValue)) {
      errors.push(`${path}.${field}: expected lowercase 0x-prefixed address`);
    }
  }
  const amountFields = [
    'amountIn',
    'expectedAmountOut',
    'minimumAmountOut',
    'txValue',
  ];
  for (const field of amountFields) {
    const fieldValue = value[field];
    if (
      typeof fieldValue !== 'string' ||
      !DECIMAL_STRING_RE.test(fieldValue)
    ) {
      errors.push(`${path}.${field}: expected decimal token-unit string`);
    }
  }
  if (
    typeof value.callDataSelector !== 'string' ||
    !HEX_SELECTOR_RE.test(value.callDataSelector)
  ) {
    errors.push(`${path}.callDataSelector: expected 4-byte lowercase selector`);
  }
  if (
    typeof value.callData !== 'string' ||
    !HEX_DATA_RE.test(value.callData) ||
    value.callData.length < 10
  ) {
    errors.push(`${path}.callData: expected 0x-prefixed calldata hex`);
  }
  const summary = value.routeSummary;
  if (!isRecord(summary)) {
    errors.push(`${path}.routeSummary: expected route summary object`);
    return;
  }
  if (
    typeof summary.providerId !== 'string' ||
    summary.providerId.length === 0
  ) {
    errors.push(`${path}.routeSummary.providerId: expected non-empty string`);
  }
  if (!isFiniteNumber(summary.swapPrice)) {
    errors.push(`${path}.routeSummary.swapPrice: expected finite number`);
  }
  if (!isFiniteNumber(summary.priceImpact)) {
    errors.push(`${path}.routeSummary.priceImpact: expected finite number`);
  }
  if (
    !isFiniteNumber(summary.gasSpentEstimate) ||
    summary.gasSpentEstimate < 0
  ) {
    errors.push(
      `${path}.routeSummary.gasSpentEstimate: expected non-negative number`
    );
  }
  if (
    !Array.isArray(summary.tokenPathSymbols) ||
    summary.tokenPathSymbols.length === 0 ||
    summary.tokenPathSymbols.some(s => typeof s !== 'string' || s.length === 0)
  ) {
    errors.push(
      `${path}.routeSummary.tokenPathSymbols: expected non-empty string array`
    );
  }
}

function validateProviderResult(
  value: unknown,
  path: string,
  errors: string[]
): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected provider result object`);
    return;
  }
  if (!oneOf(value.provider, EVIDENCE_PROVIDERS)) {
    errors.push(
      `${path}.provider: expected one of ${EVIDENCE_PROVIDERS.join(', ')}`
    );
  }
  if (value.outcome === 'success') {
    if (
      typeof value.rawFixturePath !== 'string' ||
      value.rawFixturePath.length === 0
    ) {
      errors.push(`${path}.rawFixturePath: expected non-empty fixture path`);
    }
    validateNormalizedFields(value.normalized, `${path}.normalized`, errors);
    if ('classification' in value) {
      errors.push(`${path}: success result must not carry a classification`);
    }
  } else if (value.outcome === 'failure') {
    if (!oneOf(value.classification, FAILURE_CLASSIFICATIONS)) {
      errors.push(
        `${path}.classification: expected one of ` +
          FAILURE_CLASSIFICATIONS.join(', ')
      );
    }
    if (
      typeof value.evidenceSummary !== 'string' ||
      value.evidenceSummary.length === 0
    ) {
      errors.push(`${path}.evidenceSummary: expected non-empty summary`);
    }
    if ('normalized' in value) {
      errors.push(`${path}: failure result must not carry normalized fields`);
    }
  } else {
    errors.push(`${path}.outcome: expected 'success' or 'failure'`);
  }
}

function validateSampleRow(
  value: unknown,
  path: string,
  errors: string[]
): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected sample row object`);
    return;
  }
  if (
    !isFiniteNumber(value.chainId) ||
    value.chainId <= 0 ||
    Math.floor(value.chainId) !== value.chainId
  ) {
    errors.push(`${path}.chainId: expected positive integer`);
  }
  if (typeof value.chainName !== 'string' || value.chainName.length === 0) {
    errors.push(`${path}.chainName: expected non-empty string`);
  }
  if (!isRecord(value.pair)) {
    errors.push(`${path}.pair: expected pair object`);
  } else {
    validateTokenRef(value.pair.tokenIn, `${path}.pair.tokenIn`, errors);
    validateTokenRef(value.pair.tokenOut, `${path}.pair.tokenOut`, errors);
  }
  if (
    typeof value.amountIn !== 'string' ||
    !DECIMAL_STRING_RE.test(value.amountIn)
  ) {
    errors.push(`${path}.amountIn: expected decimal token-unit string`);
  }
  if (!isIsoTimestamp(value.requestedAt)) {
    errors.push(`${path}.requestedAt: expected ISO timestamp`);
  }
  const quoteRequest = value.quoteRequest;
  if (!isRecord(quoteRequest)) {
    errors.push(`${path}.quoteRequest: expected quote request object`);
  } else {
    if (
      typeof quoteRequest.apiVersion !== 'string' ||
      quoteRequest.apiVersion.length === 0
    ) {
      errors.push(`${path}.quoteRequest.apiVersion: expected non-empty string`);
    }
    if (
      !isFiniteNumber(quoteRequest.maxSlippage) ||
      quoteRequest.maxSlippage <= 0 ||
      quoteRequest.maxSlippage >= 1
    ) {
      errors.push(
        `${path}.quoteRequest.maxSlippage: expected fraction in (0, 1)`
      );
    }
    if (
      typeof quoteRequest.sender !== 'string' ||
      !HEX_ADDRESS_RE.test(quoteRequest.sender.toLowerCase())
    ) {
      errors.push(`${path}.quoteRequest.sender: expected 0x address`);
    }
    if (
      quoteRequest.recipient !== undefined &&
      (typeof quoteRequest.recipient !== 'string' ||
        !HEX_ADDRESS_RE.test(quoteRequest.recipient.toLowerCase()))
    ) {
      errors.push(`${path}.quoteRequest.recipient: expected 0x address`);
    }
    if (quoteRequest.substitutedPair !== undefined) {
      if (
        !isRecord(quoteRequest.substitutedPair) ||
        typeof quoteRequest.substitutedPair.reason !== 'string' ||
        quoteRequest.substitutedPair.reason.length === 0
      ) {
        errors.push(
          `${path}.quoteRequest.substitutedPair.reason: expected non-empty reason`
        );
      }
    }
  }
  if (!Array.isArray(value.providerResults) || value.providerResults.length === 0) {
    errors.push(`${path}.providerResults: expected non-empty array`);
  } else {
    value.providerResults.forEach((result, index) =>
      validateProviderResult(result, `${path}.providerResults[${index}]`, errors)
    );
  }
}

function validateObservedShape(
  value: unknown,
  path: string,
  errors: string[]
): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected observed response shape object`);
    return;
  }
  if (
    typeof value.selector !== 'string' ||
    !HEX_SELECTOR_RE.test(value.selector)
  ) {
    errors.push(`${path}.selector: expected 4-byte lowercase selector`);
  }
  if (typeof value.headLayout !== 'string' || value.headLayout.length === 0) {
    errors.push(`${path}.headLayout: expected non-empty layout description`);
  }
  if (
    !Array.isArray(value.chains) ||
    value.chains.length === 0 ||
    value.chains.some(c => !isFiniteNumber(c) || c <= 0)
  ) {
    errors.push(`${path}.chains: expected non-empty positive chain-id array`);
  }
  if (typeof value.proven !== 'boolean') {
    errors.push(`${path}.proven: expected boolean`);
  }
}

const ROUTE_SHAPE_ALLOWED_KEYS = [
  'artifactKind',
  'schemaVersion',
  'packet',
  'provider',
  'generatedAt',
  'validationMechanism',
  'apiBase',
  'observedResponseShapes',
  'rows',
];

export function validateRouteShapeArtifact(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['artifact: expected object'] };
  }
  for (const key of Object.keys(value)) {
    if (ROUTE_SHAPE_ALLOWED_KEYS.indexOf(key) < 0) {
      errors.push(`artifact.${key}: unexpected key in route_shape artifact`);
    }
  }
  if (value.artifactKind !== 'route_shape') {
    errors.push(`artifact.artifactKind: expected 'route_shape'`);
  }
  if (value.schemaVersion !== 1) {
    errors.push('artifact.schemaVersion: expected 1');
  }
  if (value.packet !== '2A') {
    errors.push(`artifact.packet: expected '2A'`);
  }
  if (value.provider !== 'sushi') {
    errors.push(`artifact.provider: expected 'sushi'`);
  }
  if (!isIsoTimestamp(value.generatedAt)) {
    errors.push('artifact.generatedAt: expected ISO timestamp');
  }
  if (value.validationMechanism !== 'hand-rolled') {
    errors.push(
      "artifact.validationMechanism: expected recorded 'hand-rolled' decision"
    );
  }
  if (typeof value.apiBase !== 'string' || value.apiBase.length === 0) {
    errors.push('artifact.apiBase: expected non-empty string');
  }
  if (
    !Array.isArray(value.observedResponseShapes) ||
    value.observedResponseShapes.length === 0
  ) {
    errors.push('artifact.observedResponseShapes: expected non-empty array');
  } else {
    value.observedResponseShapes.forEach((shape, index) =>
      validateObservedShape(
        shape,
        `artifact.observedResponseShapes[${index}]`,
        errors
      )
    );
  }
  if (!Array.isArray(value.rows) || value.rows.length === 0) {
    errors.push('artifact.rows: expected non-empty array');
  } else {
    value.rows.forEach((row, index) =>
      validateSampleRow(row, `artifact.rows[${index}]`, errors)
    );
    // Packet 2A boundary: route-shape evidence is Sushi-only. LI.FI/1inch
    // comparison results and proceed/defer decisions belong to Packet 3A.
    value.rows.forEach((row, index) => {
      if (isRecord(row) && Array.isArray(row.providerResults)) {
        row.providerResults.forEach((result, resultIndex) => {
          if (isRecord(result) && result.provider !== 'sushi') {
            errors.push(
              `artifact.rows[${index}].providerResults[${resultIndex}]: ` +
                'route_shape artifacts accept only sushi provider results'
            );
          }
        });
      }
    });
  }
  if ('decision' in value) {
    errors.push(
      'artifact.decision: proceed/defer decisions are invalid in route_shape artifacts'
    );
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, artifact: value as unknown as RouteShapeArtifact };
}

export function validateCompetitivenessArtifact(
  value: unknown
): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['artifact: expected object'] };
  }
  if (value.artifactKind !== 'competitiveness') {
    errors.push(`artifact.artifactKind: expected 'competitiveness'`);
  }
  if (value.schemaVersion !== 1) {
    errors.push('artifact.schemaVersion: expected 1');
  }
  if (value.packet !== '3A') {
    errors.push(`artifact.packet: expected '3A'`);
  }
  if (!isIsoTimestamp(value.generatedAt)) {
    errors.push('artifact.generatedAt: expected ISO timestamp');
  }
  if (value.validationMechanism !== 'hand-rolled') {
    errors.push(
      "artifact.validationMechanism: expected recorded 'hand-rolled' decision"
    );
  }
  if (!Array.isArray(value.rows) || value.rows.length === 0) {
    errors.push('artifact.rows: expected non-empty array');
  } else {
    value.rows.forEach((row, index) =>
      validateSampleRow(row, `artifact.rows[${index}]`, errors)
    );
  }
  const decision = value.decision;
  if (!isRecord(decision)) {
    errors.push(
      'artifact.decision: expected exactly one decision/scope block object'
    );
  } else {
    if (decision.decision !== 'proceed' && decision.decision !== 'defer') {
      errors.push(
        "artifact.decision.decision: expected 'proceed' or 'defer'"
      );
    }
    if (
      typeof decision.rationale !== 'string' ||
      decision.rationale.length === 0
    ) {
      errors.push('artifact.decision.rationale: expected non-empty rationale');
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, artifact: value as unknown as CompetitivenessArtifact };
}

export function validateEvidenceArtifact(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { ok: false, errors: ['artifact: expected object'] };
  }
  if (value.artifactKind === 'route_shape') {
    return validateRouteShapeArtifact(value);
  }
  if (value.artifactKind === 'competitiveness') {
    return validateCompetitivenessArtifact(value);
  }
  return {
    ok: false,
    errors: [
      "artifact.artifactKind: expected 'route_shape' or 'competitiveness'",
    ],
  };
}

// Objective Packet 2A successful-route floor: at least two successful
// normalized routes on distinct chains, or one successful fixture for every
// observed response shape. Packet 2B may freeze only shapes proven here.
export function routeShapeSuccessFloorMet(
  artifact: RouteShapeArtifact
): { met: boolean; detail: string } {
  const successChains: number[] = [];
  for (const row of artifact.rows) {
    const hasSuccess = row.providerResults.some(
      result => result.outcome === 'success'
    );
    if (hasSuccess && successChains.indexOf(row.chainId) < 0) {
      successChains.push(row.chainId);
    }
  }
  if (successChains.length >= 2) {
    return {
      met: true,
      detail: `successful normalized routes on ${successChains.length} distinct chains`,
    };
  }
  const unprovenShapes = artifact.observedResponseShapes.filter(
    shape => !shape.proven
  );
  if (unprovenShapes.length === 0 && successChains.length >= 1) {
    return {
      met: true,
      detail: 'every observed response shape has a successful fixture',
    };
  }
  return {
    met: false,
    detail:
      `only ${successChains.length} successful chain(s) and ` +
      `${unprovenShapes.length} unproven response shape(s)`,
  };
}
