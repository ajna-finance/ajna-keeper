import { Signer } from '@ajna-finance/sdk';
import { getDecimalsErc20 } from '../../erc20';
import { pruneMapToMaxSize } from '../../utils';

/**
 * Shared chain-verification and token-decimals helpers for external-take
 * provider paths (1inch, LI.FI). These were previously copy-pasted verbatim per
 * path; centralizing them keeps the signer-chain guard and decimals cache from
 * silently drifting between providers. Only the human-facing `providerLabel`
 * differs per caller.
 */

export const DEFAULT_EXTERNAL_TAKE_TOKEN_DECIMAL_CACHE_ENTRIES = 512;

export async function getCachedTokenDecimals(params: {
  signer: Signer;
  tokenAddress: string;
  chainId?: number;
  cache?: Map<string, number>;
  maxEntries?: number;
}): Promise<number> {
  const cacheKey = `${params.chainId ?? 'unknown'}:${params.tokenAddress.toLowerCase()}`;
  const cached = params.cache?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const decimals = await getDecimalsErc20(
    params.signer,
    params.tokenAddress,
    params.chainId
  );
  if (params.cache) {
    params.cache.set(cacheKey, decimals);
    const maxEntries =
      params.maxEntries ?? DEFAULT_EXTERNAL_TAKE_TOKEN_DECIMAL_CACHE_ENTRIES;
    pruneMapToMaxSize(params.cache, maxEntries);
  }
  return decimals;
}

interface VerifiedChainCheck {
  provider?: object;
  pending: Promise<void>;
}

// Keyed by signer object, then by `${providerLabel}:${chainId}` so each provider
// keeps an isolated cache entry (and its own labeled error) while sharing one
// in-flight verification per (signer, provider, chainId).
const verifiedChainIds = new WeakMap<object, Map<string, VerifiedChainCheck>>();

export async function assertConfiguredChainIdMatchesSigner(
  signer: Signer,
  configuredChainId: number,
  providerLabel: string
): Promise<void> {
  if (typeof signer !== 'object' || signer === null) {
    return;
  }
  const provider = (signer as { provider?: object }).provider;
  let signerChecks = verifiedChainIds.get(signer);
  if (!signerChecks) {
    signerChecks = new Map();
    verifiedChainIds.set(signer, signerChecks);
  }
  const cacheKey = `${providerLabel}:${configuredChainId}`;
  const cached = signerChecks.get(cacheKey);
  if (cached !== undefined && cached.provider === provider) {
    await cached.pending;
    return;
  }

  const check: VerifiedChainCheck = {
    provider,
    pending: (async () => {
      const signerChainId = await signer.getChainId();
      if (signerChainId !== configuredChainId) {
        throw new Error(
          `configured ${providerLabel} chainId ${configuredChainId} does not match signer chainId ${signerChainId}`
        );
      }
    })(),
  };
  signerChecks.set(cacheKey, check);
  try {
    await check.pending;
  } catch (error) {
    if (signerChecks.get(cacheKey) === check) {
      signerChecks.delete(cacheKey);
    }
    throw error;
  }
}

export async function resolveExternalTakeChainId(
  config: { chainId?: number },
  signer: Signer,
  providerLabel: string
): Promise<number> {
  if (config.chainId === undefined) {
    return await signer.getChainId();
  }
  await assertConfiguredChainIdMatchesSigner(
    signer,
    config.chainId,
    providerLabel
  );
  return config.chainId;
}
