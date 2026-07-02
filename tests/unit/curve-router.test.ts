import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, Signer, ethers, providers } from 'ethers';
import {
  createCurveRouterSwapper,
  CurveRouterSwapResult,
} from '../../src/dex/curve-router';
import { CurvePoolType } from '../../src/config';
import { CurvePoolSelection } from '../../src/dex/curve-pool-selection';

describe('Curve Router Module', () => {
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const TARGET = '0x2222222222222222222222222222222222222222';
  const SIGNER_ADDR = '0x3333333333333333333333333333333333333333';
  const POOL = '0x4444444444444444444444444444444444444444';
  const AMOUNT = BigNumber.from('1000000000000000000');

  interface Mocks {
    signer: Signer;
    tokenContract: {
      allowance: sinon.SinonStub;
      approve: sinon.SinonStub;
    };
    poolContract: {
      get_dy: sinon.SinonStub;
      exchange: sinon.SinonStub;
    };
    makeContract: sinon.SinonStub;
    getToken: sinon.SinonStub;
    queueTransaction: sinon.SinonStub;
  }

  function installMocks(
    opts: {
      tokenAddress?: string;
      targetTokenAddress?: string;
      allowance?: BigNumber;
      quoteOut?: BigNumber;
      exchangeRejects?: boolean;
    } = {}
  ): Mocks {
    const tokenAddress = opts.tokenAddress ?? TOKEN;
    const targetTokenAddress = opts.targetTokenAddress ?? TARGET;
    const provider = {
      getNetwork: sinon.stub().resolves({ chainId: 8453, name: 'base' }),
      getGasPrice: sinon.stub().resolves(BigNumber.from('20000000000')),
    } as unknown as providers.Provider;
    const signer = {
      provider,
      getAddress: sinon.stub().resolves(SIGNER_ADDR),
    } as unknown as Signer;

    const tokenContract = {
      allowance: sinon.stub().resolves(opts.allowance ?? BigNumber.from(0)),
      approve: sinon
        .stub()
        .resolves({ hash: '0xapprove', wait: sinon.stub().resolves({}) }),
    };
    const poolContract = {
      get_dy: sinon.stub().resolves(opts.quoteOut ?? AMOUNT.mul(2)),
      exchange: opts.exchangeRejects
        ? sinon.stub().rejects(new Error('Transaction reverted'))
        : sinon.stub().resolves({
            hash: '0xswap',
            wait: sinon.stub().resolves({
              transactionHash: '0xswap',
              gasUsed: BigNumber.from(21000),
            }),
          }),
    };

    const makeContract = sinon.stub().callsFake((address: string) => {
      switch (address.toLowerCase()) {
        case tokenAddress.toLowerCase():
          return tokenContract as unknown as ethers.Contract;
        case POOL.toLowerCase():
          return poolContract as unknown as ethers.Contract;
        default:
          throw new Error(`unexpected contract address ${address}`);
      }
    });
    const getToken = sinon
      .stub()
      .callsFake(async (_chainId, _provider, address: string) => ({
        address,
        symbol:
          address.toLowerCase() === tokenAddress.toLowerCase() ? 'IN' : 'OUT',
        decimals: 18,
      }));
    const queueTransaction = sinon
      .stub()
      .callsFake(async (_signer, txFunction) => await txFunction(7));

    return {
      signer,
      tokenContract,
      poolContract,
      makeContract,
      getToken,
      queueTransaction,
    };
  }

  function swap(
    mocks: Mocks,
    opts: {
      tokenAddress?: string;
      targetTokenAddress?: string;
      slippage?: number;
      poolType?: CurvePoolType;
      defaultSlippage?: number;
      poolAddress?: string;
    } = {}
  ): Promise<CurveRouterSwapResult> {
    const testSwapper = createCurveRouterSwapper({
      makeContract: mocks.makeContract,
      getToken: mocks.getToken,
      queueTransaction: mocks.queueTransaction,
    });
    const selectedPool: CurvePoolSelection = {
      address: opts.poolAddress ?? POOL,
      poolType: opts.poolType ?? CurvePoolType.STABLE,
      tokenInIndex: 0,
      tokenOutIndex: 1,
    };
    return testSwapper(
      mocks.signer,
      opts.tokenAddress ?? TOKEN,
      AMOUNT,
      opts.targetTokenAddress ?? TARGET,
      opts.slippage as number,
      selectedPool,
      opts.defaultSlippage
    );
  }

  afterEach(() => {
    sinon.restore();
  });

  it('uses default slippage and skips approval when allowance already equals the swap amount', async () => {
    const mocks = installMocks({ allowance: AMOUNT });

    const result = await swap(mocks, { defaultSlippage: 1 });

    expect(result.success).to.equal(true);
    if (!result.success || !result.receipt) {
      expect.fail('Expected successful swap to include receipt');
    }
    expect(result.receipt.transactionHash).to.equal('0xswap');
    expect(mocks.tokenContract.approve.called).to.equal(false);
    expect(mocks.poolContract.exchange.calledOnce).to.equal(true);
    expect(mocks.queueTransaction.calledOnce).to.equal(true);
  });

  it('resets stale nonzero allowance before exact reapproval on crypto pools', async () => {
    const mocks = installMocks({ allowance: AMOUNT.mul(2) });

    const result = await swap(mocks, {
      slippage: 1,
      poolType: CurvePoolType.CRYPTO,
      defaultSlippage: 1,
    });

    expect(result.success).to.equal(true);
    expect(mocks.tokenContract.approve.callCount).to.equal(2);
    expect(
      mocks.tokenContract.approve.firstCall.args.slice(0, 2)
    ).to.deep.equal([POOL, 0]);
    expect(
      mocks.tokenContract.approve.secondCall.args.slice(0, 2)
    ).to.deep.equal([POOL, AMOUNT]);
    expect(mocks.poolContract.exchange.calledOnce).to.equal(true);
    expect(mocks.queueTransaction.callCount).to.equal(3);
  });

  it('fails closed without approvals when the Curve quote is non-positive', async () => {
    const mocks = installMocks({ quoteOut: BigNumber.from(0) });

    const result = await swap(mocks, { slippage: 1, defaultSlippage: 1 });

    expect(result.success).to.equal(false);
    expect(mocks.tokenContract.approve.called).to.equal(false);
    expect(mocks.poolContract.exchange.called).to.equal(false);
    expect(mocks.queueTransaction.called).to.equal(false);
  });

  it('returns no-op success without contracts when token addresses are identical', async () => {
    const mocks = installMocks({ targetTokenAddress: TOKEN });

    const result = await swap(mocks, {
      tokenAddress: TOKEN,
      targetTokenAddress: TOKEN,
      slippage: 1,
      defaultSlippage: 1,
    });

    expect(result).to.deep.equal({ success: true });
    expect(mocks.makeContract.called).to.equal(false);
    expect(mocks.queueTransaction.called).to.equal(false);
  });

  it('returns a swap failure without leaking thrown transaction errors', async () => {
    const mocks = installMocks({ exchangeRejects: true });

    const result = await swap(mocks, { slippage: 1, defaultSlippage: 1 });

    expect(result).to.deep.equal({
      success: false,
      error: 'Transaction reverted',
    });
  });

  it('throws configuration errors before touching chain dependencies', async () => {
    const mocks = installMocks();
    const testSwapper = createCurveRouterSwapper({
      makeContract: mocks.makeContract,
      getToken: mocks.getToken,
      queueTransaction: mocks.queueTransaction,
    });

    let error: unknown;
    try {
      await testSwapper(
        mocks.signer,
        TOKEN,
        AMOUNT,
        TARGET,
        1,
        {
          address: '',
          poolType: CurvePoolType.STABLE,
          tokenInIndex: 0,
          tokenOutIndex: 1,
        },
        1
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal(
      'Curve pool selection is missing address or pool type'
    );
    expect(mocks.makeContract.called).to.equal(false);
  });
});
