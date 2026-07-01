import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import {
  createUniversalRouterSwapper,
  swapWithUniversalRouter,
  type UniversalRouterSwapResult,
} from '../../src/dex/universal-router';
import { NonceTracker } from '../../src/nonce';
import * as uniswap from '../../src/dex/uniswap';
import * as erc20 from '../../src/erc20';
import { deriveSwapMinimumOut } from '../../src/dex/swap-min-out';
import { logger } from '../../src/logging';

chai.use(chaiAsPromised);

// Exercises the REAL swapWithUniversalRouter body. The pre-existing
// universal-router.test.ts sinon-stubs the function under test, so before this
// suite the live Permit2 approval, the bounded-router approval, and the
// fail-closed quoter min-out guard had never actually executed in a test.
// Addresses are real 20-byte values because the function abi-encodes them into
// the Universal Router calldata.
const TOKEN = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const SIGNER_ADDR = '0x3333333333333333333333333333333333333333';
const ROUTER = '0x4444444444444444444444444444444444444444';
const PERMIT2 = '0x5555555555555555555555555555555555555555';
const FACTORY = '0x6666666666666666666666666666666666666666';
const QUOTER = '0x7777777777777777777777777777777777777777';
const POOL = '0x8888888888888888888888888888888888888888';
const FEE = 3000;
const SLIPPAGE_BPS = 50; // 0.5%
const AMOUNT = BigNumber.from(1000);

interface Mocks {
  factory: any;
  quoter: any;
  token: any;
  permit2: any;
  router: any;
  makeContract: sinon.SinonStub;
}

function installMocks(
  opts: {
    quotedOut?: BigNumber;
    poolAddress?: string;
    permit2TokenAllowance?: BigNumber; // token -> Permit2 allowance
    routerAllowanceAmount?: BigNumber; // Permit2 -> Universal Router allowance
    routerAllowanceExpiration?: number;
    executeRejects?: boolean;
  } = {}
): Mocks {
  const quotedOut = opts.quotedOut ?? BigNumber.from(500);
  const factory = { getPool: sinon.stub().resolves(opts.poolAddress ?? POOL) };
  const quoter = {
    callStatic: {
      quoteExactInputSingle: sinon.stub().resolves({ amountOut: quotedOut }),
    },
  };
  const token = {
    allowance: sinon
      .stub()
      .resolves(opts.permit2TokenAllowance ?? BigNumber.from(0)),
    approve: sinon
      .stub()
      .resolves({ hash: '0xtoken', wait: sinon.stub().resolves({}) }),
  };
  const permit2 = {
    allowance: sinon.stub().resolves({
      amount: opts.routerAllowanceAmount ?? BigNumber.from(0),
      expiration: opts.routerAllowanceExpiration ?? 0,
      nonce: 0,
    }),
    approve: sinon
      .stub()
      .resolves({ hash: '0xpermit2', wait: sinon.stub().resolves({}) }),
  };
  const router = {
    execute: opts.executeRejects
      ? sinon.stub().rejects(new Error('execution reverted: UR'))
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
      case FACTORY:
        return factory as any;
      case QUOTER:
        return quoter as any;
      case TOKEN:
        return token as any;
      case PERMIT2:
        return permit2 as any;
      case ROUTER:
        return router as any;
      default:
        throw new Error(`unexpected Contract address ${address}`);
    }
  });
  return { factory, quoter, token, permit2, router, makeContract };
}

function makeSigner(): any {
  return {
    getAddress: sinon.stub().resolves(SIGNER_ADDR),
    provider: {
      getNetwork: sinon.stub().resolves({ chainId: 8453 }),
      getGasPrice: sinon.stub().resolves(BigNumber.from('1000000000')),
    },
  };
}

function swap(
  mocks: Mocks,
  amount: BigNumber = AMOUNT,
  quoterAddr: string | undefined = QUOTER,
  targetAddr: string = TARGET
): Promise<UniversalRouterSwapResult> {
  const testSwapper = createUniversalRouterSwapper({
    makeContract: mocks.makeContract as any,
  });
  return testSwapper(
    makeSigner(),
    TOKEN,
    amount,
    targetAddr,
    SLIPPAGE_BPS,
    ROUTER,
    PERMIT2,
    FEE,
    FACTORY,
    quoterAddr
  );
}

describe('swapWithUniversalRouter (real reward-swap path)', () => {
  beforeEach(() => {
    sinon.restore();
    sinon.stub(logger, 'info');
    sinon.stub(logger, 'debug');
    sinon.stub(logger, 'warn');
    sinon.stub(logger, 'error');
    sinon
      .stub(uniswap, 'getTokenFromAddress')
      .callsFake(
        async (_chainId: any, _provider: any, addr: string) =>
          ({ address: addr, symbol: `T${addr.slice(2, 4)}` }) as any
      );
    sinon.stub(erc20, 'getDecimalsErc20').resolves(18);
    sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (_signer: any, fn: any) => fn(7));
  });

  afterEach(() => sinon.restore());

  it('returns success with the swap receipt on the happy path', async () => {
    const m = installMocks();
    const result = await swap(m);
    expect(result.success).to.equal(true);
    if (!result.success) expect.fail(result.error);
    expect(result.receipt?.transactionHash).to.equal('0xswap');
    expect(m.factory.getPool.calledOnce).to.equal(true);
    expect(m.router.execute.calledOnce).to.equal(true);
  });

  it('fails closed and grants NO approval / sends NO swap when quoterV2Address is omitted', async () => {
    const m = installMocks();
    // Call directly with an omitted quoter — passing `undefined` through the
    // `swap()` helper would trigger its default parameter value instead.
    const testSwapper = createUniversalRouterSwapper({
      makeContract: m.makeContract as any,
    });
    const result = await testSwapper(
      makeSigner(),
      TOKEN,
      AMOUNT,
      TARGET,
      SLIPPAGE_BPS,
      ROUTER,
      PERMIT2,
      FEE,
      FACTORY,
      undefined
    );
    expect(result.success).to.equal(false);
    if (result.success) expect.fail('Expected omitted quoter to fail');
    expect(result.error).to.match(/quoterV2Address|fail closed/i);
    expect(m.token.approve.called, 'Permit2 token approval').to.equal(false);
    expect(m.permit2.approve.called, 'router approval').to.equal(false);
    expect(m.router.execute.called, 'swap execution').to.equal(false);
    expect(
      (NonceTracker.queueTransaction as sinon.SinonStub).called,
      'no tx queued'
    ).to.equal(false);
  });

  it('fails closed (no approval, no swap) when the quoted output is non-positive', async () => {
    const m = installMocks({ quotedOut: BigNumber.from(0) });
    const result = await swap(m);
    expect(result.success).to.equal(false);
    expect(m.token.approve.called).to.equal(false);
    expect(m.permit2.approve.called).to.equal(false);
    expect(m.router.execute.called).to.equal(false);
  });

  it('derives amountOutMin from the quoted OUTPUT (not the input) and passes it into execute()', async () => {
    const amount = BigNumber.from(1000);
    const quotedOut = BigNumber.from(500);
    const m = installMocks({ quotedOut });
    const result = await swap(m, amount);
    expect(result.success).to.equal(true);

    // the quoter is asked for the INPUT amount + configured fee tier
    const qArg = m.quoter.callStatic.quoteExactInputSingle.firstCall.args[0];
    expect(BigNumber.from(qArg.amountIn).toString()).to.equal(
      amount.toString()
    );
    expect(Number(qArg.fee)).to.equal(FEE);

    // decode the V3_SWAP_EXACT_IN inputs and pull amountOutMin (index 2)
    const inputs = m.router.execute.firstCall.args[1];
    const decoded = ethers.utils.defaultAbiCoder.decode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      inputs[0]
    );
    const amountOutMin = decoded[2] as BigNumber;
    const expected = deriveSwapMinimumOut({
      expectedOutputRaw: quotedOut,
      slippagePercent: SLIPPAGE_BPS / 100,
    });
    expect(amountOutMin.toString()).to.equal(expected.toString());
    expect(amountOutMin.toString()).to.equal('497'); // 500 * 9950 / 10000
    expect(
      amountOutMin.lt(quotedOut),
      'derived from output (500), not input (1000)'
    ).to.equal(true);
    expect(decoded[0].toLowerCase()).to.equal(SIGNER_ADDR); // recipient
    expect((decoded[1] as BigNumber).toString()).to.equal(amount.toString()); // amountIn
  });

  it('approves Permit2 with MaxUint256 when the token->Permit2 allowance is insufficient', async () => {
    const m = installMocks({ permit2TokenAllowance: BigNumber.from(0) });
    await swap(m);
    expect(m.token.approve.calledOnce).to.equal(true);
    const [spender, value] = m.token.approve.firstCall.args;
    expect(spender).to.equal(PERMIT2);
    expect(BigNumber.from(value).eq(ethers.constants.MaxUint256)).to.equal(
      true
    );
  });

  it('skips the Permit2 token approval when the existing allowance already covers the amount', async () => {
    const m = installMocks({
      permit2TokenAllowance: ethers.constants.MaxUint256,
    });
    const result = await swap(m);
    expect(result.success).to.equal(true);
    expect(m.token.approve.called, 'token->Permit2 approval skipped').to.equal(
      false
    );
    expect(m.router.execute.calledOnce).to.equal(true);
  });

  it('approves the Universal Router via Permit2 bounded to `amount` (not MaxUint256) with a future expiration', async () => {
    const amount = BigNumber.from(1000);
    const m = installMocks({
      routerAllowanceAmount: BigNumber.from(0),
      routerAllowanceExpiration: 0,
    });
    const before = Math.floor(Date.now() / 1000);
    await swap(m, amount);
    expect(m.permit2.approve.calledOnce).to.equal(true);
    const [tok, spender, approveAmount, expiration] =
      m.permit2.approve.firstCall.args;
    expect(tok.toLowerCase()).to.equal(TOKEN);
    expect(spender).to.equal(ROUTER);
    expect(BigNumber.from(approveAmount).toString()).to.equal(
      amount.toString()
    );
    expect(
      BigNumber.from(approveAmount).eq(ethers.constants.MaxUint256),
      'bounded, not MaxUint256'
    ).to.equal(false);
    expect(expiration).to.be.greaterThan(before);
    expect(expiration).to.be.at.most(Math.floor(Date.now() / 1000) + 86400 + 5);
  });

  it('skips the router approval when a sufficient, unexpired Permit2 allowance already exists', async () => {
    const m = installMocks({
      routerAllowanceAmount: BigNumber.from('100000000000000'),
      routerAllowanceExpiration: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await swap(m);
    expect(result.success).to.equal(true);
    expect(m.permit2.approve.called, 'router approval skipped').to.equal(false);
    expect(m.router.execute.calledOnce).to.equal(true);
  });

  it('continues (warns) when no direct pool exists for the fee tier', async () => {
    const m = installMocks({ poolAddress: ethers.constants.AddressZero });
    const result = await swap(m);
    expect(result.success).to.equal(true);
    expect(m.router.execute.calledOnce).to.equal(true);
  });

  it('returns {success:false,error} when the swap execution reverts', async () => {
    const m = installMocks({ executeRejects: true });
    const result = await swap(m);
    expect(result.success).to.equal(false);
    if (result.success) expect.fail('Expected swap execution to fail');
    expect(result.error)
      .to.be.a('string')
      .and.match(/execution reverted/);
  });

  it('returns early without swapping when input and target tokens are identical', async () => {
    const m = installMocks();
    const result = await swap(m, AMOUNT, QUOTER, TOKEN); // target == input
    expect(result.success).to.equal(true);
    expect(m.factory.getPool.called).to.equal(false);
    expect(m.router.execute.called).to.equal(false);
  });

  describe('config validation (throws before any network call)', () => {
    it('throws when the Universal Router address is missing', async () => {
      await expect(
        swapWithUniversalRouter(
          makeSigner(),
          TOKEN,
          AMOUNT,
          TARGET,
          SLIPPAGE_BPS,
          '',
          PERMIT2,
          FEE,
          FACTORY,
          QUOTER
        )
      ).to.be.rejectedWith(/Universal Router address/);
    });

    it('throws when the fee tier is missing', async () => {
      await expect(
        swapWithUniversalRouter(
          makeSigner(),
          TOKEN,
          AMOUNT,
          TARGET,
          SLIPPAGE_BPS,
          ROUTER,
          PERMIT2,
          0,
          FACTORY,
          QUOTER
        )
      ).to.be.rejectedWith(/Fee tier/);
    });

    it('throws when the Permit2 address is missing', async () => {
      await expect(
        swapWithUniversalRouter(
          makeSigner(),
          TOKEN,
          AMOUNT,
          TARGET,
          SLIPPAGE_BPS,
          ROUTER,
          '',
          FEE,
          FACTORY,
          QUOTER
        )
      ).to.be.rejectedWith(/Permit2 address/);
    });

    it('throws when the pool factory address is missing', async () => {
      await expect(
        swapWithUniversalRouter(
          makeSigner(),
          TOKEN,
          AMOUNT,
          TARGET,
          SLIPPAGE_BPS,
          ROUTER,
          PERMIT2,
          FEE,
          '',
          QUOTER
        )
      ).to.be.rejectedWith(/poolFactoryAddress/);
    });
  });
});
