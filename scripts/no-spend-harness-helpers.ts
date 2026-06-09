const HARD_LIQUIDATION_READ_FAILURE_CODES = new Set([
  'CALL_EXCEPTION',
  'SERVER_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
]);

const BENIGN_NO_LIQUIDATION_PATTERNS = [
  /no active auction/i,
  /no liquidation/i,
  /liquidation[^.]*not found/i,
  /auction[^.]*not found/i,
  /kickTime\s*=\s*0/i,
];

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const values = [
      (error as { message?: unknown }).message,
      (error as { reason?: unknown }).reason,
      (error as { shortMessage?: unknown }).shortMessage,
    ];
    return values
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  }
  return String(error ?? '');
}

export function isBenignNoLiquidationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === 'string' &&
    HARD_LIQUIDATION_READ_FAILURE_CODES.has(code)
  ) {
    return false;
  }
  const text = errorText(error);
  return BENIGN_NO_LIQUIDATION_PATTERNS.some((pattern) => pattern.test(text));
}
