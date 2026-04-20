// Re-export so existing integration-test imports keep working. The real
// helper lives in `src/rewards/test-helpers.ts` so unit tests can share it.
export { makeSinglePoolLpCollector } from '../rewards/test-helpers';
