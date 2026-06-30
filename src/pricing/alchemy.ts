import { logger } from '../logging';

interface AlchemyPriceRequest {
  network: string;
  address: string;
}

interface AlchemyPriceResponse {
  data: Array<{
    network: string;
    address: string;
    prices: Array<{
      currency: string;
      value: string;
      lastUpdatedAt: string;
    }>;
    error?: string;
  }>;
}

// Map chainId to Alchemy network names
function getAlchemyNetwork(chainId: number): string {
  const networkMap: { [key: number]: string } = {
    1: 'eth-mainnet',
    8453: 'base-mainnet',
    42161: 'arb-mainnet',
    10: 'opt-mainnet',
    137: 'polygon-mainnet',
    43114: 'avax-mainnet',
  };

  const network = networkMap[chainId];
  if (!network) {
    throw new Error(`Unsupported chainId for Alchemy Prices API: ${chainId}`);
  }
  return network;
}

// Extract Alchemy API key from RPC URL
function extractAlchemyKey(rpcUrl: string): string | null {
  // Pattern: https://[network].g.alchemy.com/v2/[API_KEY]
  const match = rpcUrl.match(/\/v2\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

/**
 * Standalone Alchemy Prices fetch primitive: resolve many token addresses in ONE
 * request and return a keyed `lowercased-address -> USD price` map (addresses
 * Alchemy can't price are absent). A single lookup is just
 * fetchPricesFromAlchemy([addr]); a pool price passes both legs.
 */
async function fetchPricesFromAlchemy(
  addresses: string[],
  chainId: number,
  rpcUrl: string
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (addresses.length === 0) {
    return result;
  }
  const apiKey = extractAlchemyKey(rpcUrl);
  if (!apiKey) {
    throw new Error('Could not extract Alchemy API key from RPC URL');
  }
  const network = getAlchemyNetwork(chainId);
  const url = `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`;
  const requestBody: { addresses: AlchemyPriceRequest[] } = {
    addresses: addresses.map((address) => ({ network, address })),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    throw new Error(
      `Alchemy API request failed: ${response.status} ${response.statusText}`
    );
  }

  const data: AlchemyPriceResponse = await response.json();
  for (const tokenData of data.data ?? []) {
    if (tokenData.error) {
      continue; // missing from the map -> the caller fails closed
    }
    const usd = tokenData.prices?.find(
      (p) => p.currency.toLowerCase() === 'usd'
    );
    const price = usd ? parseFloat(usd.value) : NaN;
    if (Number.isFinite(price)) {
      result.set(tokenData.address.toLowerCase(), price);
    }
  }
  return result;
}

/**
 * Fetch a single token's USD price from the Alchemy Prices API.
 */
export async function getPriceFromAlchemy(
  tokenAddress: string,
  chainId: number,
  rpcUrl: string
): Promise<number> {
  const prices = await fetchPricesFromAlchemy([tokenAddress], chainId, rpcUrl);
  const price = prices.get(tokenAddress.toLowerCase());
  if (price === undefined) {
    throw new Error(`No USD price available from Alchemy for ${tokenAddress}`);
  }
  logger.debug(`Alchemy price for ${tokenAddress}: $${price}`);
  return price;
}

/**
 * Fetch prices for a token pair and calculate the ratio
 * @param quoteAddress - Contract address of the quote token
 * @param collateralAddress - Contract address of the collateral token
 * @param chainId - Chain ID
 * @param rpcUrl - The RPC URL containing the Alchemy API key
 * @returns Price ratio (collateral/quote)
 */
export async function getPoolPriceFromAlchemy(
  quoteAddress: string,
  collateralAddress: string,
  chainId: number,
  rpcUrl: string
): Promise<number> {
  // One request for both legs (was two), keyed back by address.
  const prices = await fetchPricesFromAlchemy(
    [collateralAddress, quoteAddress],
    chainId,
    rpcUrl
  );
  const collateralPrice = prices.get(collateralAddress.toLowerCase());
  const quotePrice = prices.get(quoteAddress.toLowerCase());
  if (collateralPrice === undefined || quotePrice === undefined) {
    throw new Error(
      `No USD price available from Alchemy for pool ${collateralAddress}/${quoteAddress}`
    );
  }
  return collateralPrice / quotePrice;
}
