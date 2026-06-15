// Leaf module: numeric validation primitives. Imports nothing from sibling
// config modules to avoid the validation-rules <-> lifi-policy import cycle.
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function requireOptionalPositive(value: unknown, message: string): void {
  if (value !== undefined && (!isFiniteNumber(value) || value <= 0)) {
    throw new Error(message);
  }
}

export function requireOptionalIntegerRange(
  value: unknown,
  min: number,
  max: number,
  message: string
): void {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(message);
  }
}
