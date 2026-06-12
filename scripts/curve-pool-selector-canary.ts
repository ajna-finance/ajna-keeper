// Verifies that configured Curve pools expose the exchange selector the
// CurveKeeperTaker and src/dex/curve-router.ts actually call, by scanning
// deployed bytecode for the selector constant in the Vyper dispatcher.
//
// Context: the takers call the 4-arg base forms — exchange(int128,int128,
// uint256,uint256) for STABLE pools (0x3df02124) and exchange(uint256,uint256,
// uint256,uint256) for CRYPTO pools (0x5b41b908). The previous 6-arg CRYPTO
// encoding (0xce7d6503) silently did not exist on tricrypto2 or V2-factory
// crypto pools and made every such take revert; this canary makes that class
// of ABI drift checkable against any live deployment before takes are routed
// through a pool.
//
// Usage:
//   CURVE_CANARY_RPC_URL=https://... npm run curve-selector-canary
//   CURVE_CANARY_POOLS='[{"address":"0x...","type":"crypto","label":"..."}]' \
//     CURVE_CANARY_RPC_URL=https://... npm run curve-selector-canary
//
// Without CURVE_CANARY_POOLS, checks a reference set of Ethereum mainnet
// pools spanning every Curve generation (verified 2026-06-11).
import { providers } from 'ethers';
import { exit } from 'process';

type PoolType = 'stable' | 'crypto';

interface CanaryPool {
  address: string;
  type: PoolType;
  label: string;
}

const SELECTOR_BY_TYPE: Record<PoolType, { selector: string; sig: string }> = {
  stable: {
    selector: '3df02124',
    sig: 'exchange(int128,int128,uint256,uint256)',
  },
  crypto: {
    selector: '5b41b908',
    sig: 'exchange(uint256,uint256,uint256,uint256)',
  },
};

// Ethereum mainnet reference pools covering every generation the keeper may
// face: legacy StableSwap, CryptoSwap V2 (tricrypto2), V2 factory two-coin,
// and tricrypto-NG.
const DEFAULT_POOLS: CanaryPool[] = [
  {
    address: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
    type: 'stable',
    label: '3pool (legacy StableSwap)',
  },
  {
    address: '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46',
    type: 'crypto',
    label: 'tricrypto2 (CryptoSwap V2, no 6-arg exchange)',
  },
  {
    address: '0xB576491F1E6e5E62f1d8F26062Ee822B40B0E0d4',
    type: 'crypto',
    label: 'CVX/ETH (V2 factory two-coin, no 6-arg exchange)',
  },
  {
    address: '0x7F86Bf177Dd4F3494b841a37e810A34dD56c829B',
    type: 'crypto',
    label: 'tricryptoUSDC (tricrypto-NG)',
  },
];

function loadPools(): CanaryPool[] {
  const raw = process.env.CURVE_CANARY_POOLS;
  if (!raw) {
    return DEFAULT_POOLS;
  }
  const parsed = JSON.parse(raw) as CanaryPool[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('CURVE_CANARY_POOLS must be a non-empty JSON array');
  }
  for (const pool of parsed) {
    if (!pool.address || (pool.type !== 'stable' && pool.type !== 'crypto')) {
      throw new Error(
        `CURVE_CANARY_POOLS entries need address and type stable|crypto: ${JSON.stringify(pool)}`
      );
    }
    pool.label = pool.label ?? pool.address;
  }
  return parsed;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.CURVE_CANARY_RPC_URL;
  if (!rpcUrl) {
    console.error('CURVE_CANARY_RPC_URL is required');
    exit(2);
  }

  const provider = new providers.JsonRpcProvider(rpcUrl);
  const pools = loadPools();
  let failures = 0;

  for (const pool of pools) {
    const expected = SELECTOR_BY_TYPE[pool.type];
    let code: string;
    try {
      code = await provider.getCode(pool.address);
    } catch (error) {
      console.error(`FAIL ${pool.label}: getCode failed: ${error}`);
      failures += 1;
      continue;
    }

    if (!code || code === '0x') {
      console.error(`FAIL ${pool.label}: no contract code at ${pool.address}`);
      failures += 1;
      continue;
    }

    if (code.toLowerCase().includes(expected.selector)) {
      console.log(
        `ok   ${pool.label}: ${expected.sig} (${'0x' + expected.selector}) present`
      );
    } else {
      console.error(
        `FAIL ${pool.label}: selector ${'0x' + expected.selector} for ${expected.sig} ` +
          `not found in deployed bytecode at ${pool.address} — the taker's ` +
          `${pool.type} exchange call would revert against this pool`
      );
      failures += 1;
    }
  }

  if (failures > 0) {
    console.error(`${failures}/${pools.length} pools failed the selector canary`);
    exit(1);
  }
  console.log(`${pools.length}/${pools.length} pools expose the expected exchange selector`);
}

main().catch((error) => {
  console.error(error);
  exit(2);
});
