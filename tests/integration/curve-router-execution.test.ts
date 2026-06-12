// Real-execution coverage for swapWithCurveRouter against a tricrypto-style
// pool that exposes ONLY the 4/5-arg exchange forms. The previous 6-arg
// CRYPTOSWAP_ABI made this exact flow revert at gas estimation (tricrypto2 and
// V2 factory crypto pools lack that selector), which the stub-based
// curve-router.test.ts could never catch.
import { expect } from 'chai';
import sinon from 'sinon';
import { Contract, Wallet, utils } from 'ethers';
import * as curveRouterModule from '../../src/dex/curve-router';
import { NonceTracker } from '../../src/nonce';
import { CurvePoolType } from '../../src/config';
import {
  MockCurveTricryptoPool__factory,
  MockERC20__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { fundSigner, getProvider } from './helpers/mock-taker-base';

const AMOUNT_IN = utils.parseEther('1');
const FIXED_OUT = utils.parseEther('2');

describe('Curve router real execution', () => {
  let queueTransactionStub: sinon.SinonStub;

  beforeEach(() => {
    queueTransactionStub = sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (signer: any, txFunc: any) =>
        txFunc(await signer.getTransactionCount())
      );
  });

  afterEach(() => {
    sinon.restore();
  });

  async function deployTricryptoFixture() {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);

    const tokenIn = await new MockERC20__factory(owner).deploy(
      'Mock tBTC',
      'MTBTC',
      18
    );
    await tokenIn.deployed();
    const tokenOut = await new MockERC20__factory(owner).deploy(
      'Mock WETH',
      'MWETH',
      18
    );
    await tokenOut.deployed();

    const curvePool = await new MockCurveTricryptoPool__factory(owner).deploy(
      tokenIn.address,
      FIXED_OUT
    );
    await curvePool.deployed();
    await curvePool.setTokenOut(tokenOut.address);

    await tokenIn.mint(owner.address, AMOUNT_IN);
    await tokenOut.mint(curvePool.address, FIXED_OUT);

    return { owner, tokenIn, tokenOut, curvePool };
  }

  it('executes a CRYPTO swap against a pool that lacks the 6-arg exchange form', async () => {
    const { owner, tokenIn, tokenOut, curvePool } =
      await deployTricryptoFixture();

    const result = await curveRouterModule.swapWithCurveRouter(
      owner,
      tokenIn.address,
      AMOUNT_IN,
      tokenOut.address,
      2.0,
      curvePool.address,
      CurvePoolType.CRYPTO,
      2.0
    );

    expect(result.success, `swap failed: ${result.error ?? ''}`).to.equal(
      true
    );
    expect(queueTransactionStub.called).to.equal(true);
    expect((await tokenOut.balanceOf(owner.address)).eq(FIXED_OUT)).to.equal(
      true
    );
    expect(
      (await tokenIn.balanceOf(curvePool.address)).eq(AMOUNT_IN)
    ).to.equal(true);
  });

  it('documents that the removed 6-arg form is genuinely absent on the tricrypto surface', async () => {
    const { owner, curvePool } = await deployTricryptoFixture();

    const sixArg = new Contract(
      curvePool.address,
      [
        'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, bool use_eth, address receiver) returns (uint256)',
      ],
      owner
    );

    let error: unknown;
    try {
      await sixArg.callStatic.exchange(0, 1, AMOUNT_IN, 0, false, owner.address);
    } catch (caught) {
      error = caught;
    }
    expect(error, 'expected the 6-arg selector to be missing').to.be.instanceOf(
      Error
    );
  });
});
