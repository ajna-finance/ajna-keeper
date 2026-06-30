import { logger } from '../logging';
import { PriceOriginCoinGecko, PriceOriginCoinGeckoQuery } from '../config';
import { getPriceFromAlchemy, getPoolPriceFromAlchemy } from './alchemy';

interface CoinGeckoResponse {
  [coinName: string]: {
    usd: number;
  };
}

interface CoinGeckoErrorResponse {
  error_code?: number;
  timestamp?: string;
  status?: {
    error_code?: number;
    error_message?: string;
    timestamp?: string;
  };
}

const COINGECKO_REQUEST_VARIANTS = [
  {
    label: 'demo',
    baseUrl: 'https://api.coingecko.com/api/v3/simple/',
    headerName: 'x-cg-demo-api-key',
  },
  {
    label: 'pro',
    baseUrl: 'https://pro-api.coingecko.com/api/v3/simple/',
    headerName: 'x-cg-pro-api-key',
  },
] as const;

function getCoinGeckoErrorMessage(
  response: CoinGeckoErrorResponse,
  status: number,
  variantLabel: string
): string {
  return (
    response.status?.error_message ??
    `CoinGecko ${variantLabel} request failed with status ${status}`
  );
}

/**
 * Keyed extractor: map each requested CoinGecko id to its USD price. Unlike a
 * positional read, this never mis-attributes a value when several ids share one
 * response. A 0/negative/missing value (CoinGecko returns 0 for an unknown or
 * unpriced token) is treated as "no price" — the id is simply absent from the
 * map, so the Alchemy fallback (or a fail-closed throw) takes over for it.
 */
function extractCoinGeckoPricesByIds(
  payload: unknown,
  ids: string[]
): Map<string, number> {
  const prices = new Map<string, number>();
  if (!payload || typeof payload !== 'object') return prices;
  const byId = payload as Record<string, { usd?: unknown } | undefined>;
  for (const id of ids) {
    const usd = byId[id]?.usd;
    if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) {
      prices.set(id, usd);
    }
  }
  return prices;
}

/**
 * Standalone CoinGecko fetch primitive: resolve many ids in ONE request and
 * return a keyed `id -> USD price` map (ids CoinGecko can't price are absent).
 * Tries each request variant (demo then pro); throws only if no variant returns
 * a usable HTTP response. This is the batch building block — a single-id lookup
 * is `fetchCoinGeckoPrices([id], key)`, and a future cross-pool batch passes the
 * union of every pool's ids in one call.
 */
export async function fetchCoinGeckoPrices(
  ids: string[],
  apiKey: string
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const query = `price?ids=${ids.join(',')}&vs_currencies=usd`;
  let lastError = 'CoinGecko request failed';

  for (const variant of COINGECKO_REQUEST_VARIANTS) {
    const response = await fetch(variant.baseUrl + query, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        [variant.headerName]: apiKey,
      },
    });
    const payload = await response.json();

    // A successful HTTP response is authoritative: return its keyed prices (ids
    // it omits fall through to the caller's per-id fallback). Only HTTP failures
    // advance to the next variant.
    if (response.ok) {
      return extractCoinGeckoPricesByIds(payload, ids);
    }

    lastError = getCoinGeckoErrorMessage(
      payload as CoinGeckoErrorResponse,
      response.status,
      variant.label
    );
    logger.debug(`CoinGecko ${variant.label} request failed: ${lastError}`);
  }

  throw new Error(lastError);
}

// Map CoinGecko token IDs to contract addresses for Alchemy fallback
// This mapping is chain-specific and should be expanded as needed
export function getTokenAddress(
  tokenId: string,
  chainId: number,
  tokenAddresses?: { [key: string]: string }
): string | null {
  // First check user-provided token addresses
  if (tokenAddresses && tokenAddresses[tokenId]) {
    return tokenAddresses[tokenId];
  }

  // Common token address mappings per chain
  const addressMap: { [key: number]: { [key: string]: string } } = {
    // Base mainnet (8453)
    8453: {
      ethereum: '0x4200000000000000000000000000000000000006', // WETH
      weth: '0x4200000000000000000000000000000000000006',
      'usd-coin': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      dai: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      tether: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT
      usdt: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
      'wrapped-bitcoin': '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
      wbtc: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      cana: '0x88a3548e2a662936268bFD4366e48D38183E3958', // CANA on Base
      'cana-holdings-california-carbon-credits':
        '0x88a3548e2a662936268bFD4366e48D38183E3958', // CANA full CoinGecko ID
    },
    // Ethereum mainnet (1)
    1: {
      ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      'usd-coin': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      dai: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      tether: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      'wrapped-bitcoin': '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
      wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      'wrapped-steth': '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', // wstETH
      wsteth: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
      cana: '0x01995A697752266d8E748738aAa3F06464B8350B', // CANA on Ethereum mainnet
      'cana-holdings-california-carbon-credits':
        '0x01995A697752266d8E748738aAa3F06464B8350B', // CANA full CoinGecko ID
    },
    // Avalanche C-Chain (43114)
    43114: {
      'avalanche-2': '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
      avax: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      wavax: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      'usd-coin': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // USDC
      usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      ethereum: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', // WETH.e
      weth: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    },
    // Arbitrum One (42161)
    42161: {
      ethereum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
      weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      'usd-coin': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      dai: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      tether: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
      usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    },
    // Optimism (10) — surfaced-defects #6
    10: {
      ethereum: '0x4200000000000000000000000000000000000006', // WETH
      weth: '0x4200000000000000000000000000000000000006',
      'usd-coin': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // native USDC
      usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      dai: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      tether: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // USDT
      usdt: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
      'wrapped-bitcoin': '0x68f180fcCe6836688e9084f035309E29Bf0A2095', // WBTC
      wbtc: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
    },
    // Polygon PoS (137) — surfaced-defects #6
    137: {
      ethereum: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
      weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      'usd-coin': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // native USDC
      usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      dai: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      tether: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
      usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      'wrapped-bitcoin': '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', // WBTC
      wbtc: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
      'matic-network': '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
      wmatic: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    },
  };

  const chainMap = addressMap[chainId];
  if (!chainMap) {
    return null;
  }

  return chainMap[tokenId] || null;
}

function isUsableApiKey(apiKey: string | undefined): apiKey is string {
  return (
    !!apiKey && apiKey.trim() !== '' && apiKey !== 'YOUR_COINGECKO_API_KEY_HERE'
  );
}

// Configured queries are always "price?ids=<id>&vs_currencies=usd" (the only
// shape the keeper builds and the Alchemy fallback understands).
function extractTokenIdFromQuery(query: string): string {
  const match = query.match(/ids=([^&]+)/);
  if (!match) {
    throw new Error(`Could not extract token ID from query: ${query}`);
  }
  return match[1];
}

/**
 * Resolve USD prices for `ids`: one batched CoinGecko request, then a per-id
 * Alchemy Prices fallback for any id CoinGecko couldn't price. Returns a map
 * covering every requested id, or throws (fail closed) when an id resolves
 * through neither source. The batch fetch is the shared building block; the
 * per-id fallback keeps each id's resolution independent.
 */
async function resolveCoinGeckoPrices(
  ids: string[],
  apiKey: string | undefined,
  chainId?: number,
  rpcUrl?: string,
  tokenAddresses?: { [key: string]: string }
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  if (isUsableApiKey(apiKey)) {
    try {
      for (const [id, price] of await fetchCoinGeckoPrices(ids, apiKey)) {
        resolved.set(id, price);
      }
    } catch (error) {
      logger.warn(`CoinGecko fetch failed, trying Alchemy fallback: ${error}`);
    }
  } else {
    logger.debug('CoinGecko API key not provided, using Alchemy fallback');
  }

  const missing = ids.filter((id) => !resolved.has(id));
  if (missing.length > 0) {
    if (!chainId || !rpcUrl) {
      throw new Error('chainId and rpcUrl required for Alchemy price fallback');
    }
    // The per-id Alchemy lookups are independent — resolve them concurrently so a
    // multi-id fallback (e.g. a future cross-pool batch) doesn't serialize.
    const fallbacks = await Promise.all(
      missing.map(async (id): Promise<[string, number]> => {
        const tokenAddress = getTokenAddress(id, chainId, tokenAddresses);
        if (!tokenAddress) {
          throw new Error(
            `No token address mapping found for "${id}" on chain ${chainId}. ` +
              `Add it to tokenAddresses config or update the token mapping in pricing/coingecko.ts`
          );
        }
        logger.info(`Using Alchemy Prices API for ${id} (${tokenAddress})`);
        return [id, await getPriceFromAlchemy(tokenAddress, chainId, rpcUrl)];
      })
    );
    for (const [id, price] of fallbacks) {
      resolved.set(id, price);
    }
  }
  return resolved;
}

async function getPrice(
  query: string,
  apiKey: string | undefined,
  chainId?: number,
  rpcUrl?: string,
  tokenAddresses?: { [key: string]: string }
): Promise<number> {
  const tokenId = extractTokenIdFromQuery(query);
  const prices = await resolveCoinGeckoPrices(
    [tokenId],
    apiKey,
    chainId,
    rpcUrl,
    tokenAddresses
  );
  const price = prices.get(tokenId);
  if (price === undefined) {
    throw new Error(`Could not resolve a price for "${tokenId}"`);
  }
  return price;
}

async function getPoolPrice(
  quoteId: string,
  collateralId: string,
  apiKey: string | undefined,
  chainId?: number,
  rpcUrl?: string,
  tokenAddresses?: { [key: string]: string }
): Promise<number> {
  // Try CoinGecko first if API key is provided
  if (isUsableApiKey(apiKey)) {
    try {
      // Both legs in ONE batched request (was two), with per-id Alchemy fallback.
      const prices = await resolveCoinGeckoPrices(
        [collateralId, quoteId],
        apiKey,
        chainId,
        rpcUrl,
        tokenAddresses
      );
      const collateralPrice = prices.get(collateralId);
      const quotePrice = prices.get(quoteId);
      // Guard the divisor: a non-positive/absent quote price would yield
      // Infinity/NaN. Throwing here drops to the pool-level Alchemy fallback
      // below rather than returning a degenerate pool price.
      if (
        collateralPrice === undefined ||
        quotePrice === undefined ||
        !(quotePrice > 0)
      ) {
        throw new Error(
          `Could not resolve a positive pool price for ${collateralId}/${quoteId}`
        );
      }
      return collateralPrice / quotePrice;
    } catch (error) {
      logger.warn(
        `CoinGecko pool price fetch failed, trying Alchemy fallback: ${error}`
      );
    }
  } else {
    logger.debug(
      'CoinGecko API key not provided, using Alchemy for pool price'
    );
  }

  // Fallback to Alchemy
  if (!chainId || !rpcUrl) {
    throw new Error('chainId and rpcUrl required for Alchemy price fallback');
  }

  const quoteAddress = getTokenAddress(quoteId, chainId, tokenAddresses);
  const collateralAddress = getTokenAddress(
    collateralId,
    chainId,
    tokenAddresses
  );

  if (!quoteAddress || !collateralAddress) {
    throw new Error(
      `No token address mapping found for "${quoteId}" or "${collateralId}" on chain ${chainId}. ` +
        `Add them to tokenAddresses config or update the token mapping in pricing/coingecko.ts`
    );
  }

  logger.info(
    `Using Alchemy Prices API for pool price: ${collateralId}/${quoteId}`
  );
  return await getPoolPriceFromAlchemy(
    quoteAddress,
    collateralAddress,
    chainId,
    rpcUrl
  );
}

export async function getPriceCoinGecko(
  config: PriceOriginCoinGecko,
  apiKey: string | undefined,
  chainId?: number,
  rpcUrl?: string,
  tokenAddresses?: { [key: string]: string }
): Promise<number> {
  if (isPriceOriginQuery(config)) {
    return await getPrice(
      config.query,
      apiKey,
      chainId,
      rpcUrl,
      tokenAddresses
    );
  } else {
    return await getPoolPrice(
      config.quoteId,
      config.collateralId,
      apiKey,
      chainId,
      rpcUrl,
      tokenAddresses
    );
  }
}

function isPriceOriginQuery(
  config: PriceOriginCoinGecko
): config is PriceOriginCoinGeckoQuery {
  return !!config.hasOwnProperty('query');
}
