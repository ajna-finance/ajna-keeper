/**
 * A resolved market price was non-finite or non-positive. A price of 0, NaN,
 * Infinity, or a negative number is invalid input to every kick/take gate: it
 * makes comparisons like `NP * priceFactor < limitPrice` trivially true/false
 * and yields a degenerate `limitIndex`, so a bad number must be rejected at the
 * boundary rather than silently driving an on-chain decision.
 *
 * Callers that gate per-loan/per-pool (e.g. the kick path) should treat this as
 * a skip reason; the daemon's supervised loops already log-and-continue.
 */
export class PriceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceUnavailableError';
  }
}

/**
 * The single price-boundary guard. Every resolved price must be a finite,
 * strictly positive number before it can gate a decision. Returns the value
 * unchanged when valid (so it reads inline at a `return`); throws
 * {@link PriceUnavailableError} otherwise.
 */
export function assertFinitePositivePrice(
  value: number,
  context: string
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PriceUnavailableError(
      `Resolved price is not a finite positive number (got ${value}) for ${context}`
    );
  }
  return value;
}
