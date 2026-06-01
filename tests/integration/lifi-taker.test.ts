import { expect } from 'chai';
import { BigNumber, Wallet, constants, providers, utils } from 'ethers';
import { network } from 'hardhat';
import { AjnaKeeperTakerFactory__factory } from '../../typechain-types/factories/contracts/factories';
import {
  MockAtomicSwapPool__factory,
  MockERC20__factory,
  MockLifiSwapTarget__factory,
  MockPoolDeployer__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { LifiKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import { LiquiditySource } from '../../src/config';

const ERC20_NON_SUBSET_HASH = utils.keccak256(
  utils.toUtf8Bytes('ERC20_NON_SUBSET_HASH')
);
const BORROWER = utils.getAddress('0x00000000000000000000000000000000000000b0');
const LIFI_DETAILS_ABI =
  'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)';

function getProvider() {
  return new providers.Web3Provider(network.provider as any);
}

async function fundSigner(address: string) {
  await network.provider.send('hardhat_setBalance', [
    address,
    utils.parseEther('10').toHexString(),
  ]);
}

async function expectRevertWith(
  action: Promise<unknown>,
  expected: string
): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  expect(caught).to.be.instanceOf(Error);
  expect((caught as Error).message).to.contain(expected);
}

describe('LifiKeeperTaker', () => {
  async function deployFixture() {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);

    const collateral = await new MockERC20__factory(owner).deploy(
      'Collateral',
      'COL',
      18
    );
    const quote = await new MockERC20__factory(owner).deploy(
      'Quote',
      'QTE',
      18
    );
    await collateral.deployed();
    await quote.deployed();

    const pool = await new MockAtomicSwapPool__factory(owner).deploy(
      collateral.address,
      quote.address,
      1
    );
    await pool.deployed();

    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();
    await poolDeployer.setDeployedPool(
      ERC20_NON_SUBSET_HASH,
      collateral.address,
      quote.address,
      pool.address
    );

    const factory = await new AjnaKeeperTakerFactory__factory(owner).deploy(
      poolDeployer.address
    );
    await factory.deployed();

    const taker = await new LifiKeeperTaker__factory(owner).deploy(
      poolDeployer.address,
      factory.address
    );
    await taker.deployed();

    const target = await new MockLifiSwapTarget__factory(owner).deploy();
    await target.deployed();

    await factory.setTaker(LiquiditySource.LIFI, taker.address);
    const selector = target.interface.getSighash('mockSwap');
    await taker.setCallTarget(target.address, true);
    await taker.setApprovalSpender(target.address, true);
    await taker.setCallSelector(target.address, selector, true);

    return {
      owner,
      collateral,
      quote,
      pool,
      poolDeployer,
      factory,
      taker,
      target,
      selector,
    };
  }

  function buildDetails(params: {
    approvalSpender: string;
    srcToken: string;
    dstToken: string;
    dstReceiver: string;
    amountIn: BigNumber;
    amountOutMinimum: BigNumber;
    callData: string;
  }) {
    return {
      approvalSpender: params.approvalSpender,
      srcToken: params.srcToken,
      dstToken: params.dstToken,
      dstReceiver: params.dstReceiver,
      amountInTokenUnits: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      callData: params.callData,
    };
  }

  function encodeDetails(params: {
    approvalSpender: string;
    srcToken: string;
    dstToken: string;
    dstReceiver: string;
    amountIn: BigNumber;
    amountOutMinimum: BigNumber;
    callData: string;
  }): string {
    return utils.defaultAbiCoder.encode(
      [LIFI_DETAILS_ABI],
      [buildDetails(params)]
    );
  }

  function encodeCallbackData(
    params: {
      approvalSpender: string;
      srcToken: string;
      dstToken: string;
      dstReceiver: string;
      amountIn: BigNumber;
      amountOutMinimum: BigNumber;
      callData: string;
    },
    swapRouter: string
  ): string {
    return utils.defaultAbiCoder.encode(
      [LIFI_DETAILS_ABI, 'address'],
      [buildDetails(params), swapRouter]
    );
  }

  it('rejects zero deployment authority addresses', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);
    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    await expectRevertWith(
      new LifiKeeperTaker__factory(owner).deploy(
        constants.AddressZero,
        owner.address
      ),
      'InvalidSwapDetails'
    );
    await expectRevertWith(
      new LifiKeeperTaker__factory(owner).deploy(
        poolDeployer.address,
        constants.AddressZero
      ),
      'InvalidSwapDetails'
    );
  });

  async function executeTake(params: {
    outputAmount?: BigNumber;
    amountOutMinimum?: BigNumber;
    quoteAmountDue?: BigNumber;
    approvalSpender?: string;
    detailsAmountIn?: BigNumber;
    allowedSelector?: string;
    callData?: string;
    swapRouter?: string;
  }) {
    const fixture = await deployFixture();
    const amountIn = utils.parseEther('1');
    const quoteAmountDue = params.quoteAmountDue ?? utils.parseEther('1');
    const outputAmount = params.outputAmount ?? utils.parseEther('1.25');
    const amountOutMinimum = params.amountOutMinimum ?? utils.parseEther('1.1');

    await fixture.collateral.mint(fixture.pool.address, amountIn);
    await fixture.quote.mint(fixture.target.address, outputAmount);
    await fixture.pool.setQuoteAmountDue(quoteAmountDue);

    const callData =
      params.callData ??
      fixture.target.interface.encodeFunctionData('mockSwap', [
        fixture.collateral.address,
        fixture.quote.address,
        fixture.taker.address,
        amountIn,
        outputAmount,
      ]);
    if (params.allowedSelector) {
      await fixture.taker.setCallSelector(
        fixture.target.address,
        params.allowedSelector,
        true
      );
    }
    const details = encodeDetails({
      approvalSpender: params.approvalSpender ?? fixture.target.address,
      srcToken: fixture.collateral.address,
      dstToken: fixture.quote.address,
      dstReceiver: fixture.taker.address,
      amountIn: params.detailsAmountIn ?? amountIn,
      amountOutMinimum,
      callData,
    });

    const send = () =>
      fixture.factory.takeWithAtomicSwap(
        fixture.pool.address,
        BORROWER,
        constants.WeiPerEther,
        amountIn,
        LiquiditySource.LIFI,
        params.swapRouter ?? fixture.target.address,
        details
      );

    return {
      ...fixture,
      amountIn,
      outputAmount,
      amountOutMinimum,
      quoteAmountDue,
      details,
      send,
    };
  }

  type LifiTakeExecution = Awaited<ReturnType<typeof executeTake>>;

  function defaultLifiCallData(result: LifiTakeExecution): string {
    return result.target.interface.encodeFunctionData('mockSwap', [
      result.collateral.address,
      result.quote.address,
      result.taker.address,
      result.amountIn,
      result.outputAmount,
    ]);
  }

  function encodeDetailsForExecution(
    result: LifiTakeExecution,
    overrides: Partial<{
      approvalSpender: string;
      srcToken: string;
      dstToken: string;
      dstReceiver: string;
      amountIn: BigNumber;
      amountOutMinimum: BigNumber;
      callData: string;
    }> = {}
  ): string {
    return encodeDetails({
      approvalSpender: overrides.approvalSpender ?? result.target.address,
      srcToken: overrides.srcToken ?? result.collateral.address,
      dstToken: overrides.dstToken ?? result.quote.address,
      dstReceiver: overrides.dstReceiver ?? result.taker.address,
      amountIn: overrides.amountIn ?? result.amountIn,
      amountOutMinimum: overrides.amountOutMinimum ?? result.amountOutMinimum,
      callData: overrides.callData ?? defaultLifiCallData(result),
    });
  }

  async function expectInvalidSwapDetails(params: {
    executeOverrides?: Parameters<typeof executeTake>[0];
    detailOverrides?: Parameters<typeof encodeDetailsForExecution>[1];
  }) {
    const result = await executeTake(params.executeOverrides ?? {});
    const details = encodeDetailsForExecution(
      result,
      params.detailOverrides ?? {}
    );

    await expectRevertWith(
      result.factory.takeWithAtomicSwap(
        result.pool.address,
        BORROWER,
        constants.WeiPerEther,
        result.amountIn,
        LiquiditySource.LIFI,
        params.executeOverrides?.swapRouter ?? result.target.address,
        details
      ),
      'InvalidSwapDetails'
    );
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
    expect((await result.collateral.balanceOf(result.target.address)).eq(0)).to
      .be.true;
  }

  it('executes through the factory and enforces balance-delta output', async () => {
    const result = await executeTake({});
    await result.send();

    expect((await result.pool.takeCount()).eq(1)).to.be.true;
    expect(await result.pool.lastCallee()).to.equal(result.taker.address);
    expect(await result.pool.lastBorrower()).to.equal(BORROWER);
    expect(
      (await result.quote.balanceOf(result.pool.address)).eq(
        result.quoteAmountDue
      )
    ).to.be.true;
    expect(
      (await result.quote.balanceOf(result.owner.address)).eq(
        result.outputAmount.sub(result.quoteAmountDue)
      )
    ).to.be.true;
    expect((await result.collateral.balanceOf(result.taker.address)).eq(0)).to
      .be.true;
    expect(
      (
        await result.collateral.allowance(
          result.taker.address,
          result.target.address
        )
      ).eq(0)
    ).to.be.true;
    expect(
      (
        await result.quote.allowance(result.taker.address, result.pool.address)
      ).eq(0)
    ).to.be.true;
  });

  it('allows owner direct execution through the same validated callback path', async () => {
    const result = await executeTake({});

    await result.taker.takeWithAtomicSwap(
      result.pool.address,
      BORROWER,
      constants.WeiPerEther,
      result.amountIn,
      LiquiditySource.LIFI,
      result.target.address,
      result.details
    );

    expect((await result.pool.takeCount()).eq(1)).to.be.true;
    expect(await result.pool.lastCallee()).to.equal(result.taker.address);
    expect(await result.pool.lastBorrower()).to.equal(BORROWER);
    expect(
      (await result.quote.balanceOf(result.pool.address)).eq(
        result.quoteAmountDue
      )
    ).to.be.true;
    expect(
      (await result.quote.balanceOf(result.owner.address)).eq(
        result.outputAmount.sub(result.quoteAmountDue)
      )
    ).to.be.true;
    expect((await result.collateral.balanceOf(result.taker.address)).eq(0)).to
      .be.true;
    expect(
      (
        await result.collateral.allowance(
          result.taker.address,
          result.target.address
        )
      ).eq(0)
    ).to.be.true;
    expect(
      (
        await result.quote.allowance(result.taker.address, result.pool.address)
      ).eq(0)
    ).to.be.true;
  });

  it('recovers stray taker tokens to the owner through taker or factory authority', async () => {
    const result = await deployFixture();
    const directRecoveryAmount = utils.parseEther('2');
    const factoryRecoveryAmount = utils.parseEther('3');

    await result.quote.mint(result.taker.address, directRecoveryAmount);
    const ownerBeforeDirect = await result.quote.balanceOf(
      result.owner.address
    );
    await result.taker.recover(result.quote.address);

    expect(
      (await result.quote.balanceOf(result.owner.address))
        .sub(ownerBeforeDirect)
        .eq(directRecoveryAmount)
    ).to.be.true;
    expect((await result.quote.balanceOf(result.taker.address)).eq(0)).to.be
      .true;

    await result.quote.mint(result.taker.address, factoryRecoveryAmount);
    const ownerBeforeFactory = await result.quote.balanceOf(
      result.owner.address
    );
    await result.factory.recoverFromTaker(
      LiquiditySource.LIFI,
      result.quote.address
    );

    expect(
      (await result.quote.balanceOf(result.owner.address))
        .sub(ownerBeforeFactory)
        .eq(factoryRecoveryAmount)
    ).to.be.true;
    expect((await result.quote.balanceOf(result.taker.address)).eq(0)).to.be
      .true;
  });

  it('preserves the factory configured-taker enumeration for LI.FI', async () => {
    const result = await deployFixture();
    const configured = await result.factory.getConfiguredTakers();

    expect(configured.sources).to.include(LiquiditySource.LIFI);
    expect(configured.takers).to.include(result.taker.address);
  });

  it('reverts before callback execution when source collateral is already present', async () => {
    const result = await executeTake({});
    await result.collateral.mint(result.taker.address, 1);

    await expectRevertWith(result.send(), 'StaleSourceBalance');
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
  });

  it('reverts when LI.FI underdelivers below the approved floor', async () => {
    const result = await executeTake({
      outputAmount: utils.parseEther('1.05'),
      amountOutMinimum: utils.parseEther('1.1'),
    });

    await expectRevertWith(result.send(), 'InsufficientQuoteReceived');
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
    expect(
      (
        await result.collateral.allowance(
          result.taker.address,
          result.target.address
        )
      ).eq(0)
    ).to.be.true;
    expect(
      (
        await result.quote.allowance(result.taker.address, result.pool.address)
      ).eq(0)
    ).to.be.true;
  });

  it('reverts when LI.FI output repays min-out but misses quote due', async () => {
    const result = await executeTake({
      outputAmount: utils.parseEther('1.15'),
      amountOutMinimum: utils.parseEther('1.1'),
      quoteAmountDue: utils.parseEther('1.2'),
    });

    await expectRevertWith(result.send(), 'InsufficientQuoteReceived');
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
    expect(
      (
        await result.collateral.allowance(
          result.taker.address,
          result.target.address
        )
      ).eq(0)
    ).to.be.true;
    expect(
      (
        await result.quote.allowance(result.taker.address, result.pool.address)
      ).eq(0)
    ).to.be.true;
  });

  it('reverts when the LI.FI target returns success but transfers the wrong token', async () => {
    const result = await deployFixture();
    const wrongToken = await new MockERC20__factory(result.owner).deploy(
      'Wrong Quote',
      'WRONG',
      18
    );
    await wrongToken.deployed();

    const amountIn = utils.parseEther('1');
    const wrongOutputAmount = utils.parseEther('1.25');
    await result.collateral.mint(result.pool.address, amountIn);
    await wrongToken.mint(result.target.address, wrongOutputAmount);
    await result.pool.setQuoteAmountDue(utils.parseEther('1'));

    const wrongTokenSelector =
      result.target.interface.getSighash('mockSwapWrongToken');
    await result.taker.setCallSelector(
      result.target.address,
      wrongTokenSelector,
      true
    );
    const callData = result.target.interface.encodeFunctionData(
      'mockSwapWrongToken',
      [
        result.collateral.address,
        wrongToken.address,
        result.taker.address,
        amountIn,
        wrongOutputAmount,
      ]
    );
    const details = encodeDetails({
      approvalSpender: result.target.address,
      srcToken: result.collateral.address,
      dstToken: result.quote.address,
      dstReceiver: result.taker.address,
      amountIn,
      amountOutMinimum: utils.parseEther('1.1'),
      callData,
    });

    await expectRevertWith(
      result.factory.takeWithAtomicSwap(
        result.pool.address,
        BORROWER,
        constants.WeiPerEther,
        amountIn,
        LiquiditySource.LIFI,
        result.target.address,
        details
      ),
      'InsufficientQuoteReceived'
    );
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
    expect((await wrongToken.balanceOf(result.taker.address)).eq(0)).to.be.true;
  });

  it('ignores LI.FI target return data and requires actual quote-token output', async () => {
    const result = await deployFixture();
    const amountIn = utils.parseEther('1');
    const fakeAmountOut = utils.parseEther('100');

    await result.collateral.mint(result.pool.address, amountIn);
    await result.pool.setQuoteAmountDue(utils.parseEther('1'));

    const fakeReturnSelector = result.target.interface.getSighash(
      'mockReturnFakeOutputNoTransfer'
    );
    await result.taker.setCallSelector(
      result.target.address,
      fakeReturnSelector,
      true
    );
    const callData = result.target.interface.encodeFunctionData(
      'mockReturnFakeOutputNoTransfer',
      [result.collateral.address, amountIn, fakeAmountOut]
    );
    const details = encodeDetails({
      approvalSpender: result.target.address,
      srcToken: result.collateral.address,
      dstToken: result.quote.address,
      dstReceiver: result.taker.address,
      amountIn,
      amountOutMinimum: utils.parseEther('1.1'),
      callData,
    });

    await expectRevertWith(
      result.factory.takeWithAtomicSwap(
        result.pool.address,
        BORROWER,
        constants.WeiPerEther,
        amountIn,
        LiquiditySource.LIFI,
        result.target.address,
        details
      ),
      'InsufficientQuoteReceived'
    );
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
    expect(
      (
        await result.collateral.allowance(
          result.taker.address,
          result.target.address
        )
      ).eq(0)
    ).to.be.true;
  });

  it('reverts when the LI.FI target consumes input but returns zero quote output', async () => {
    const result = await deployFixture();
    const amountIn = utils.parseEther('1');

    await result.collateral.mint(result.pool.address, amountIn);
    await result.pool.setQuoteAmountDue(utils.parseEther('1'));

    const noOutputSelector = result.target.interface.getSighash('mockNoOutput');
    await result.taker.setCallSelector(
      result.target.address,
      noOutputSelector,
      true
    );
    const callData = result.target.interface.encodeFunctionData(
      'mockNoOutput',
      [result.collateral.address, amountIn]
    );
    const details = encodeDetails({
      approvalSpender: result.target.address,
      srcToken: result.collateral.address,
      dstToken: result.quote.address,
      dstReceiver: result.taker.address,
      amountIn,
      amountOutMinimum: utils.parseEther('1.1'),
      callData,
    });

    await expectRevertWith(
      result.factory.takeWithAtomicSwap(
        result.pool.address,
        BORROWER,
        constants.WeiPerEther,
        amountIn,
        LiquiditySource.LIFI,
        result.target.address,
        details
      ),
      'InsufficientQuoteReceived'
    );
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
    expect(
      (
        await result.collateral.allowance(
          result.taker.address,
          result.target.address
        )
      ).eq(0)
    ).to.be.true;
  });

  it('reverts when callback collateral does not match LI.FI amountIn', async () => {
    const result = await executeTake({
      detailsAmountIn: utils.parseEther('0.99'),
    });

    await expectRevertWith(result.send(), 'UnexpectedSourceBalance');
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
  });

  it('rejects malformed LI.FI swap details before calling an external target', async () => {
    await expectInvalidSwapDetails({
      executeOverrides: { swapRouter: constants.AddressZero },
    });

    await expectInvalidSwapDetails({
      detailOverrides: {
        srcToken: Wallet.createRandom().address,
      },
    });

    await expectInvalidSwapDetails({
      detailOverrides: {
        dstToken: Wallet.createRandom().address,
      },
    });

    await expectInvalidSwapDetails({
      detailOverrides: {
        dstReceiver: Wallet.createRandom().address,
      },
    });

    await expectInvalidSwapDetails({
      detailOverrides: {
        amountOutMinimum: constants.Zero,
      },
    });

    await expectInvalidSwapDetails({
      detailOverrides: {
        callData: '0x',
      },
    });
  });

  it('rejects valid-pool callbacks outside an active factory take', async () => {
    const result = await deployFixture();
    const amountIn = utils.parseEther('1');
    const outputAmount = utils.parseEther('1.25');
    const quoteAmountDue = utils.parseEther('1');

    await result.collateral.mint(result.taker.address, amountIn);
    await result.quote.mint(result.target.address, outputAmount);
    await result.pool.setQuoteAmountDue(quoteAmountDue);

    const callData = result.target.interface.encodeFunctionData('mockSwap', [
      result.collateral.address,
      result.quote.address,
      result.taker.address,
      amountIn,
      outputAmount,
    ]);
    const callbackData = encodeCallbackData(
      {
        approvalSpender: result.target.address,
        srcToken: result.collateral.address,
        dstToken: result.quote.address,
        dstReceiver: result.taker.address,
        amountIn,
        amountOutMinimum: utils.parseEther('1.1'),
        callData,
      },
      result.target.address
    );

    await expectRevertWith(
      result.pool.callAtomicSwapCallback(
        result.taker.address,
        amountIn,
        quoteAmountDue,
        callbackData
      ),
      'UnexpectedCallback'
    );
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
    expect(
      (await result.collateral.balanceOf(result.taker.address)).eq(amountIn)
    ).to.be.true;
    expect((await result.collateral.balanceOf(result.target.address)).eq(0)).to
      .be.true;
    expect((await result.quote.balanceOf(result.taker.address)).eq(0)).to.be
      .true;
    expect(
      (
        await result.collateral.allowance(
          result.taker.address,
          result.target.address
        )
      ).eq(0)
    ).to.be.true;
  });

  it('recovers LI.FI source token residue to the owner after quote repayment', async () => {
    const result = await deployFixture();
    const amountIn = utils.parseEther('1');
    const outputAmount = utils.parseEther('1.25');
    const refundAmount = utils.parseEther('0.01');
    const quoteAmountDue = utils.parseEther('1');

    await result.collateral.mint(result.pool.address, amountIn);
    await result.quote.mint(result.target.address, outputAmount);
    await result.pool.setQuoteAmountDue(quoteAmountDue);
    const refundSelector =
      result.target.interface.getSighash('mockSwapWithRefund');
    await result.taker.setCallSelector(
      result.target.address,
      refundSelector,
      true
    );

    const callData = result.target.interface.encodeFunctionData(
      'mockSwapWithRefund',
      [
        result.collateral.address,
        result.quote.address,
        result.taker.address,
        amountIn,
        outputAmount,
        refundAmount,
      ]
    );
    const details = encodeDetails({
      approvalSpender: result.target.address,
      srcToken: result.collateral.address,
      dstToken: result.quote.address,
      dstReceiver: result.taker.address,
      amountIn,
      amountOutMinimum: utils.parseEther('1.1'),
      callData,
    });

    await result.factory.takeWithAtomicSwap(
      result.pool.address,
      BORROWER,
      constants.WeiPerEther,
      amountIn,
      LiquiditySource.LIFI,
      result.target.address,
      details
    );
    expect((await result.pool.takeCount()).eq(1)).to.be.true;
    expect(
      (await result.quote.balanceOf(result.pool.address)).eq(quoteAmountDue)
    ).to.be.true;
    expect((await result.collateral.balanceOf(result.taker.address)).eq(0)).to
      .be.true;
    expect(
      (await result.collateral.balanceOf(result.owner.address)).eq(refundAmount)
    ).to.be.true;
  });

  it('reverts on reentrant callback attempts', async () => {
    const result = await deployFixture();
    const amountIn = utils.parseEther('1');
    const outputAmount = utils.parseEther('1.25');

    await result.collateral.mint(result.pool.address, amountIn);
    await result.quote.mint(result.target.address, outputAmount);
    await result.pool.setQuoteAmountDue(utils.parseEther('1'));

    const reentrantSelector = result.target.interface.getSighash(
      'mockReentrantCallback'
    );
    await result.taker.setCallSelector(
      result.target.address,
      reentrantSelector,
      true
    );
    const callData = result.target.interface.encodeFunctionData(
      'mockReentrantCallback',
      [
        result.collateral.address,
        result.quote.address,
        result.taker.address,
        amountIn,
        outputAmount,
        '0x',
      ]
    );
    const details = encodeDetails({
      approvalSpender: result.target.address,
      srcToken: result.collateral.address,
      dstToken: result.quote.address,
      dstReceiver: result.taker.address,
      amountIn,
      amountOutMinimum: utils.parseEther('1.1'),
      callData,
    });

    await expectRevertWith(
      result.factory.takeWithAtomicSwap(
        result.pool.address,
        BORROWER,
        constants.WeiPerEther,
        amountIn,
        LiquiditySource.LIFI,
        result.target.address,
        details
      ),
      'ReentrancyGuard: reentrant call'
    );
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
  });

  it('rejects non-allowlisted LI.FI call targets and selectors', async () => {
    const result = await executeTake({
      swapRouter: Wallet.createRandom().address,
    });

    await expectRevertWith(result.send(), 'CallTargetNotAllowed');

    const badSelectorResult = await executeTake({
      callData: '0xdeadbeef00000000',
    });
    await expectRevertWith(badSelectorResult.send(), 'SelectorNotAllowed');
  });

  it('rejects an allowlisted LI.FI call target that has no contract code', async () => {
    const fixture = await deployFixture();
    const amountIn = utils.parseEther('1');
    const amountOutMinimum = utils.parseEther('1.1');
    const noCodeTarget = Wallet.createRandom().address;
    const selector = '0xabcdef12';

    await fixture.collateral.mint(fixture.pool.address, amountIn);
    await fixture.pool.setQuoteAmountDue(utils.parseEther('1'));
    // Allowlist a target/spender/selector whose address has no contract code.
    // Without the on-chain code-existence guard the low-level call would
    // succeed as a no-op and the swap would silently move no funds.
    await fixture.taker.setCallTarget(noCodeTarget, true);
    await fixture.taker.setApprovalSpender(noCodeTarget, true);
    await fixture.taker.setCallSelector(noCodeTarget, selector, true);

    const details = encodeDetails({
      approvalSpender: noCodeTarget,
      srcToken: fixture.collateral.address,
      dstToken: fixture.quote.address,
      dstReceiver: fixture.taker.address,
      amountIn,
      amountOutMinimum,
      callData: selector + '00'.repeat(32),
    });

    await expectRevertWith(
      fixture.factory.takeWithAtomicSwap(
        fixture.pool.address,
        BORROWER,
        constants.WeiPerEther,
        amountIn,
        LiquiditySource.LIFI,
        noCodeTarget,
        details
      ),
      'CallTargetHasNoCode'
    );
    expect((await fixture.pool.takeCount()).eq(0)).to.be.true;
  });

  it('rejects non-allowlisted approval spenders', async () => {
    const result = await executeTake({
      approvalSpender: Wallet.createRandom().address,
    });

    await expectRevertWith(result.send(), 'ApprovalSpenderNotAllowed');
    expect((await result.pool.takeCount()).eq(0)).to.be.true;
  });

  it('reverts and leaves no collateral allowance when the LI.FI target reverts', async () => {
    const mockRevertIface = new utils.Interface(['function mockRevert()']);
    const result = await executeTake({
      callData: mockRevertIface.encodeFunctionData('mockRevert'),
      allowedSelector: mockRevertIface.getSighash('mockRevert'),
    });

    await expectRevertWith(result.send(), 'mock lifi target revert');
    expect(
      (
        await result.collateral.allowance(
          result.taker.address,
          result.target.address
        )
      ).eq(0)
    ).to.be.true;
  });

  it('keeps LI.FI execution and allowlist policy owner/factory controlled', async () => {
    const result = await executeTake({});
    const attacker = Wallet.createRandom().connect(getProvider());
    await fundSigner(attacker.address);

    await expectRevertWith(
      result.taker
        .connect(attacker)
        .takeWithAtomicSwap(
          result.pool.address,
          BORROWER,
          constants.WeiPerEther,
          result.amountIn,
          LiquiditySource.LIFI,
          result.target.address,
          result.details
        ),
      'Unauthorized'
    );
    await expectRevertWith(
      result.taker.connect(attacker).recover(result.quote.address),
      'Unauthorized'
    );
    await expectRevertWith(
      result.taker
        .connect(attacker)
        .setCallTarget(result.target.address, false),
      'Unauthorized'
    );
    await expectRevertWith(
      result.taker
        .connect(attacker)
        .setApprovalSpender(result.target.address, false),
      'Unauthorized'
    );
    await expectRevertWith(
      result.taker
        .connect(attacker)
        .setCallSelector(result.target.address, result.selector, false),
      'Unauthorized'
    );

    expect(
      await result.taker.isCallTargetAllowed(result.target.address)
    ).to.equal(true);
    expect(
      await result.taker.isApprovalSpenderAllowed(result.target.address)
    ).to.equal(true);
    expect(
      await result.taker.isCallSelectorAllowed(
        result.target.address,
        result.selector
      )
    ).to.equal(true);
  });
});
