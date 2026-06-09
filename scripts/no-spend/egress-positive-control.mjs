#!/usr/bin/env node

import process from 'process';
import {
  EGRESS_POSITIVE_CONTROL_BLOCKED_EXIT_CODE,
  EGRESS_POSITIVE_CONTROL_URL,
} from './egress-constants.mjs';

try {
  await fetch(EGRESS_POSITIVE_CONTROL_URL);
  process.stderr.write(
    `[egress-positive-control] request unexpectedly completed: ${EGRESS_POSITIVE_CONTROL_URL}\n`
  );
  process.exit(1);
} catch (error) {
  const code = error?.code;
  process.stderr.write(
    `[egress-positive-control] ${
      code ?? (error instanceof Error ? error.message : String(error))
    }\n`
  );
  process.exit(
    code === 'AJNA_UNEXPECTED_EGRESS'
      ? EGRESS_POSITIVE_CONTROL_BLOCKED_EXIT_CODE
      : 1
  );
}
