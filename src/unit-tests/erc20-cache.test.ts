import { expect } from 'chai';
import sinon from 'sinon';
import { ethers, providers } from 'ethers';
import { clearErc20DecimalCache, getDecimalsErc20 } from '../erc20';

describe('erc20 decimals cache', () => {
  afterEach(() => {
    sinon.restore();
    clearErc20DecimalCache();
  });

  it('reuses one decimals RPC call across concurrent mixed-case lookups', async () => {
    const provider = new providers.JsonRpcProvider();
    const decimalsCallStub = sinon
      .stub(provider, 'call')
      .resolves(ethers.utils.defaultAbiCoder.encode(['uint8'], [6]));
    const lowerCaseAddress = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const upperCaseAddress = '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD';

    const [first, second] = await Promise.all([
      getDecimalsErc20(provider as any, lowerCaseAddress),
      getDecimalsErc20(provider as any, upperCaseAddress),
    ]);

    expect(first).to.equal(6);
    expect(second).to.equal(6);
    expect(decimalsCallStub.calledOnce).to.be.true;
  });
});
