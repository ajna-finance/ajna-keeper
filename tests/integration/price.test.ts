import { AjnaSDK, Pool } from '@ajna-finance/sdk';
import { expect } from 'chai';
import { configureAjna, PriceOriginPoolReference } from '../../src/config';
import { getPoolPrice } from '../../src/pricing';
import { getProvider, resetHardhat } from './test-utils';
import { MAINNET_CONFIG } from './test-config';

describe('getPoolPrice', () => {
  const poolAddress = MAINNET_CONFIG.WBTC_USDC_POOL.poolConfig.address;
  let provider: ReturnType<typeof getProvider>;
  let ajna: AjnaSDK;
  let fungiblePool: Pool;

  beforeEach(async () => {
    await resetHardhat();
    provider = getProvider();
    configureAjna(MAINNET_CONFIG.AJNA_CONFIG);
    ajna = new AjnaSDK(provider);
    fungiblePool = await ajna.fungiblePoolFactory.getPoolByAddress(poolAddress);
  });

  it('should find price for hpb', async () => {
    const hpbPrice = await getPoolPrice(
      await fungiblePool.getPrices(),
      PriceOriginPoolReference.HPB
    );
    // Use approximate comparison to handle minor calculation differences
    expect(hpbPrice).to.be.approximately(59726.377253304, 1);
  });

  it('should find price for htp', async () => {
    const htpPrice = await getPoolPrice(
      await fungiblePool.getPrices(),
      PriceOriginPoolReference.HTP
    );
    // Use approximate comparison to handle minor calculation differences
    expect(htpPrice).to.be.approximately(38336.04015947, 1);
  });

  it('should find price for lup', async () => {
    const lupPrice = await getPoolPrice(
      await fungiblePool.getPrices(),
      PriceOriginPoolReference.LUP
    );
    // Use approximate comparison to handle minor calculation differences
    expect(lupPrice).to.be.approximately(52988.385953918, 1);
  });

  it('should find price for llb', async () => {
    const llbPrice = await getPoolPrice(
      await fungiblePool.getPrices(),
      PriceOriginPoolReference.LLB
    );
    // Use approximate comparison to handle minor calculation differences
    expect(llbPrice).to.be.approximately(1004968987.6065, 100);
  });
});
