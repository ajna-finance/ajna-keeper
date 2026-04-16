import { expect } from 'chai';
import 'dotenv';
import { PriceOriginSource } from '../config';
import { getPriceCoinGecko } from '../pricing';

const MAINNET_CHAIN_ID = 1;
const MAINNET_RPC_URL = process.env.ALCHEMY_API_KEY
  ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : undefined;

describe('Coingecko API', () => {
  before(() => {
    expect(
      !!process.env.COINGECKO_API_KEY || !!MAINNET_RPC_URL,
      'Add COINGECKO_API_KEY or ALCHEMY_API_KEY to your .env file'
    ).to.be.true;
  });

  it('Gets pool price for token pair', async () => {
    const poolPrice = await getPriceCoinGecko(
      {
        source: PriceOriginSource.COINGECKO,
        quoteId: 'ethereum',
        collateralId: 'wrapped-steth',
      },
      process.env.COINGECKO_API_KEY,
      MAINNET_CHAIN_ID,
      MAINNET_RPC_URL
    );

    expect(poolPrice).greaterThan(0);
  });

  it('Gets pool price for query (fiat)', async () => {
    const poolPrice = await getPriceCoinGecko(
      {
        source: PriceOriginSource.COINGECKO,
        query: 'price?ids=ethereum&vs_currencies=usd',
      },
      process.env.COINGECKO_API_KEY,
      MAINNET_CHAIN_ID,
      MAINNET_RPC_URL
    );

    expect(poolPrice).greaterThan(0);
  });
});
