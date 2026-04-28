import 'dotenv/config';

import { PriceOriginSource } from '../src/config';
import { getPriceFromAlchemy, getPoolPriceFromAlchemy } from '../src/pricing/alchemy';
import { getPriceCoinGecko } from '../src/pricing/coingecko';

type PriceDiagnostic = 'alchemy' | 'fallback' | 'cana';

const CHAIN_ID = 8453;
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CANA_ADDRESS = '0x88a3548e2a662936268bFD4366e48D38183E3958';
const CANA_COINGECKO_ID = 'cana-holdings-california-carbon-credits';
const ALL_DIAGNOSTICS: PriceDiagnostic[] = ['alchemy', 'fallback', 'cana'];

function getRpcUrl(): string {
  return `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
}

function hasCoinGeckoApiKey(): boolean {
  const apiKey = process.env.COINGECKO_API_KEY;
  return Boolean(apiKey && apiKey !== 'YOUR_COINGECKO_API_KEY_HERE');
}

function getRequestedDiagnostics(): PriceDiagnostic[] {
  const requested = process.argv.slice(2);
  if (requested.includes('--help') || requested.includes('-h')) {
    console.log('Usage: npx ts-node scripts/price-diagnostics.ts [all|alchemy|fallback|cana]');
    return [];
  }

  if (requested.length === 0 || requested.includes('all')) {
    return ALL_DIAGNOSTICS;
  }

  const invalid = requested.filter(
    diagnostic => !ALL_DIAGNOSTICS.includes(diagnostic as PriceDiagnostic)
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown price diagnostic(s): ${invalid.join(', ')}. Valid: ${[
        ...ALL_DIAGNOSTICS,
        'all',
      ].join(', ')}`
    );
  }

  return requested as PriceDiagnostic[];
}

async function testAlchemyPrices() {
  const rpcUrl = getRpcUrl();

  console.log('Testing Alchemy Prices API on Base chain...\n');

  console.log('Test 1: Fetching WETH price...');
  const wethPrice = await getPriceFromAlchemy(WETH_ADDRESS, CHAIN_ID, rpcUrl);
  console.log(`OK WETH Price: $${wethPrice.toFixed(2)}\n`);

  console.log('Test 2: Fetching USDC price...');
  const usdcPrice = await getPriceFromAlchemy(USDC_ADDRESS, CHAIN_ID, rpcUrl);
  console.log(`OK USDC Price: $${usdcPrice.toFixed(4)}\n`);

  console.log('Test 3: Fetching CANA price...');
  try {
    const canaPrice = await getPriceFromAlchemy(CANA_ADDRESS, CHAIN_ID, rpcUrl);
    console.log(`OK CANA Price: $${canaPrice.toFixed(6)}\n`);

    console.log('Test 4: Calculating CANA/USDC pool price...');
    const poolPrice = await getPoolPriceFromAlchemy(
      USDC_ADDRESS,
      CANA_ADDRESS,
      CHAIN_ID,
      rpcUrl
    );
    console.log(`OK CANA/USDC Pool Price: ${poolPrice.toFixed(6)} USDC per CANA\n`);
  } catch {
    console.log('WARN CANA price not currently available in Alchemy');
    console.log('  Will use CoinGecko for CANA price instead.\n');
  }

  console.log('Test 5: Calculating WETH/USDC pool price...');
  const poolPrice = await getPoolPriceFromAlchemy(
    USDC_ADDRESS,
    WETH_ADDRESS,
    CHAIN_ID,
    rpcUrl
  );
  console.log(`OK WETH/USDC Pool Price: ${poolPrice.toFixed(2)} USDC per WETH\n`);

  console.log('OK Alchemy Prices API diagnostics passed!');
  console.log('Note: If a token is not available in Alchemy, the keeper will');
  console.log('automatically fall back to CoinGecko API when a CoinGecko API key is provided.\n');
}

async function testPriceFallback() {
  const rpcUrl = getRpcUrl();
  const coinGeckoApiKey = process.env.COINGECKO_API_KEY;
  const sourceLabel = hasCoinGeckoApiKey() ? 'CoinGecko' : 'Alchemy fallback';

  console.log('Testing Price Fallback System (CoinGecko -> Alchemy)...\n');

  console.log('Test 1: Fetching WETH price...');
  const wethPrice = await getPriceCoinGecko(
    {
      source: PriceOriginSource.COINGECKO,
      query: 'price?ids=ethereum&vs_currencies=usd',
    },
    coinGeckoApiKey,
    CHAIN_ID,
    rpcUrl,
    { ethereum: WETH_ADDRESS }
  );
  console.log(`OK WETH Price: $${wethPrice.toFixed(2)}`);
  console.log(`  Used: ${sourceLabel}\n`);

  console.log('Test 2: Fetching CANA price...');
  const canaPrice = await getPriceCoinGecko(
    {
      source: PriceOriginSource.COINGECKO,
      query: `price?ids=${CANA_COINGECKO_ID}&vs_currencies=usd`,
    },
    coinGeckoApiKey,
    CHAIN_ID,
    rpcUrl,
    {
      [CANA_COINGECKO_ID]: CANA_ADDRESS,
      cana: CANA_ADDRESS,
    }
  );
  console.log(`OK CANA Price: $${canaPrice.toFixed(6)}`);
  console.log(`  Used: ${sourceLabel}\n`);

  console.log('Test 3: Fetching USDC price...');
  const usdcPrice = await getPriceCoinGecko(
    {
      source: PriceOriginSource.COINGECKO,
      query: 'price?ids=usd-coin&vs_currencies=usd',
    },
    coinGeckoApiKey,
    CHAIN_ID,
    rpcUrl,
    { 'usd-coin': USDC_ADDRESS }
  );
  console.log(`OK USDC Price: $${usdcPrice.toFixed(4)}\n`);

  console.log('OK price fallback diagnostics passed!');
  console.log('Summary:');
  console.log('  - Tokens are sourced from CoinGecko or Alchemy based on availability');
  console.log('  - Fallback system: CoinGecko, then Alchemy, then error');
  console.log('  - Both services support a wide range of tokens\n');
}

async function testCanaPrice() {
  const rpcUrl = getRpcUrl();
  const coinGeckoApiKey = process.env.COINGECKO_API_KEY;

  console.log('Fetching CANA price from CoinGecko...\n');

  const canaPrice = await getPriceCoinGecko(
    {
      source: PriceOriginSource.COINGECKO,
      query: `price?ids=${CANA_COINGECKO_ID}&vs_currencies=usd`,
    },
    coinGeckoApiKey,
    CHAIN_ID,
    rpcUrl,
    {
      [CANA_COINGECKO_ID]: CANA_ADDRESS,
      cana: CANA_ADDRESS,
    }
  );

  console.log(`OK CANA Price: $${canaPrice.toFixed(6)}`);
  console.log('   Source: CoinGecko API');
  console.log(`   Token: CANA (Base: ${CANA_ADDRESS})`);
  console.log(`   CoinGecko ID: ${CANA_COINGECKO_ID}\n`);
  console.log('OK CoinGecko integration is working correctly!\n');
}

async function main() {
  const diagnostics = getRequestedDiagnostics();

  for (const diagnostic of diagnostics) {
    if (diagnostic === 'alchemy') {
      await testAlchemyPrices();
    } else if (diagnostic === 'fallback') {
      await testPriceFallback();
    } else {
      await testCanaPrice();
    }
  }
}

main().catch(error => {
  console.error('Price diagnostic failed:', error);
  process.exit(1);
});
