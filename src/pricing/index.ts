import {
  PriceOrigin,
  PriceOriginPoolReference,
  PriceOriginSource,
} from '../config';
import { getPriceCoinGecko } from './coingecko';
import { weiToDecimaled } from '../utils';
import { PriceInfo } from '@ajna-finance/sdk';
import { logger } from '../logging';
import { assertFinitePositivePrice } from './price-guard';

// Retrieves the market price using the configured source
export async function getPrice(
  priceOrigin: PriceOrigin,
  coinGeckoApiKey: string | undefined = '',
  poolPrices?: PriceInfo,
  chainId?: number,
  rpcUrl?: string,
  tokenAddresses?: { [key: string]: string }
) {
  let price: number;
  switch (priceOrigin.source) {
    case PriceOriginSource.COINGECKO:
      price = await getPriceCoinGecko(
        priceOrigin,
        coinGeckoApiKey,
        chainId,
        rpcUrl,
        tokenAddresses
      );
      break;
    case PriceOriginSource.FIXED:
      price = priceOrigin.value;
      break;
    case PriceOriginSource.POOL:
      if (!poolPrices) {
        throw new Error('Pool prices required for pool price origin');
      }
      price = await getPoolPrice(poolPrices, priceOrigin.reference);
      break;
    default:
      throw new Error('Unknown price provider:' + (priceOrigin as any).source);
  }
  // Single price-boundary guard: whatever the source/invert combination, the
  // value that leaves getPrice must be finite and strictly positive, so a 0 /
  // NaN / Infinity / negative can never silently drive a kick or take gate. The
  // invert path keeps its divide-by-zero guard, but a 0 input now fails the
  // assertion below rather than returning a degenerate 0.
  const resolved = priceOrigin.invert ? (price !== 0 ? 1 / price : 0) : price;
  logger.debug(
    `Price resolved: ${resolved} (source: ${priceOrigin.source}${
      priceOrigin.invert ? `, inverted from ${price}` : ''
    })`
  );
  return assertFinitePositivePrice(
    resolved,
    `source=${priceOrigin.source}${priceOrigin.invert ? ' (inverted)' : ''}`
  );
}

export async function getPoolPrice(
  poolPrices: PriceInfo,
  reference: PriceOriginPoolReference
): Promise<number> {
  let price;
  switch (reference) {
    case PriceOriginPoolReference.HPB:
      price = poolPrices?.hpb;
      break;
    case PriceOriginPoolReference.HTP:
      price = poolPrices?.htp;
      break;
    case PriceOriginPoolReference.LUP:
      price = poolPrices?.lup;
      break;
    case PriceOriginPoolReference.LLB:
      price = poolPrices?.llb;
      break;
    default:
      throw new Error('Unknown pool price reference:' + reference);
  }
  return weiToDecimaled(price);
}

export { getPriceCoinGecko } from './coingecko';
