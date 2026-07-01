import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';
import { JsonRpcProvider } from '../../src/provider';

describe('JsonRpcProvider fee data', () => {
  afterEach(() => {
    sinon.restore();
  });

  function makeProvider(): JsonRpcProvider {
    return new JsonRpcProvider('http://localhost:8545', {
      chainId: 1,
      name: 'mainnet',
    });
  }

  it('reads max priority fee through eth_maxPriorityFeePerGas', async () => {
    const provider = makeProvider();
    const send = sinon
      .stub(provider, 'send')
      .withArgs('eth_maxPriorityFeePerGas', [])
      .resolves('0x3b9aca00');

    const priorityFee = await provider.getMaxPriorityFeePerGas();

    expect(priorityFee.eq(BigNumber.from('1000000000'))).to.equal(true);
    expect(send.calledOnce).to.equal(true);
  });

  it('computes EIP-1559 fee data from base fee and priority fee', async () => {
    const provider = makeProvider();
    const baseFee = BigNumber.from('10000000000');
    const gasPrice = BigNumber.from('12000000000');
    const priorityFee = BigNumber.from('1500000000');
    sinon.stub(provider, 'getBlock').withArgs('latest').resolves({
      baseFeePerGas: baseFee,
    } as any);
    sinon.stub(provider, 'getGasPrice').resolves(gasPrice);
    sinon.stub(provider, 'getMaxPriorityFeePerGas').resolves(priorityFee);

    const feeData = await provider.getFeeData();

    expect(feeData.gasPrice?.eq(gasPrice)).to.equal(true);
    expect(feeData.lastBaseFeePerGas?.eq(baseFee)).to.equal(true);
    expect(feeData.maxPriorityFeePerGas?.eq(priorityFee)).to.equal(true);
    expect(feeData.maxFeePerGas?.eq(baseFee.mul(2).add(priorityFee))).to.equal(
      true
    );
  });

  it('keeps EIP-1559 fees usable when gas price and priority RPCs fail', async () => {
    const provider = makeProvider();
    const baseFee = BigNumber.from('10000000000');
    const defaultPriorityFee = BigNumber.from('1000000000');
    sinon.stub(provider, 'getBlock').withArgs('latest').resolves({
      baseFeePerGas: baseFee,
    } as any);
    sinon.stub(provider, 'getGasPrice').rejects(new Error('gas price down'));
    sinon
      .stub(provider, 'getMaxPriorityFeePerGas')
      .rejects(new Error('priority down'));

    const feeData = await provider.getFeeData();

    expect(feeData.gasPrice).to.equal(null);
    expect(feeData.lastBaseFeePerGas?.eq(baseFee)).to.equal(true);
    expect(feeData.maxPriorityFeePerGas?.eq(defaultPriorityFee)).to.equal(true);
    expect(
      feeData.maxFeePerGas?.eq(baseFee.mul(2).add(defaultPriorityFee))
    ).to.equal(true);
  });

  it('returns legacy gas price without EIP-1559 fields when base fee is unavailable', async () => {
    const provider = makeProvider();
    const gasPrice = BigNumber.from('12000000000');
    sinon.stub(provider, 'getBlock').withArgs('latest').resolves({} as any);
    sinon.stub(provider, 'getGasPrice').resolves(gasPrice);
    sinon.stub(provider, 'getMaxPriorityFeePerGas').resolves(
      BigNumber.from('1500000000')
    );

    const feeData = await provider.getFeeData();

    expect(feeData.gasPrice?.eq(gasPrice)).to.equal(true);
    expect(feeData.lastBaseFeePerGas).to.equal(null);
    expect(feeData.maxPriorityFeePerGas).to.equal(null);
    expect(feeData.maxFeePerGas).to.equal(null);
  });
});
