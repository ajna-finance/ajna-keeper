import { expect } from 'chai';
import { Wallet, constants, utils } from 'ethers';
import { LiquiditySource } from '../../src/config';
import {
  MockERC20__factory,
  MockPoolDeployer__factory,
} from '../../typechain-types/factories/contracts/mocks';
import { LifiKeeperTaker__factory } from '../../typechain-types/factories/contracts/takers';
import {
  BORROWER,
  deployFixture,
  encodeCallbackData,
  encodeDetails,
  executeTake,
  expectInvalidSwapDetails,
  expectRevertWith,
  fundSigner,
  getProvider,
} from './helpers/lifi-taker-fixture';

describe('LifiKeeperTaker', () => {
  it('rejects zero deployment authority addresses', async () => {
    const owner = Wallet.createRandom().connect(getProvider());
    await fundSigner(owner.address);
    const poolDeployer = await new MockPoolDeployer__factory(owner).deploy();
    await poolDeployer.deployed();

    // Assert the hardhat reason phrase, not just the bare string: deploy-revert
    // errors embed the contract source (sourceContent), so a bare `.contains`
    // can false-match identifiers that merely appear in the source code.
    await expectRevertWith(
      new LifiKeeperTaker__factory(owner).deploy(
        constants.AddressZero,
        owner.address
      ),
      "reverted with reason string 'Zero pool factory'"
    );
    await expectRevertWith(
      new LifiKeeperTaker__factory(owner).deploy(
        poolDeployer.address,
        constants.AddressZero
      ),
      "reverted with reason string 'Zero authorized router'"
    );
  });

  it('emits AggregatorSwapExecuted and no generic SwapExecuted on successful takes', async () => {
    // The inherited 4-arg SwapExecuted is part of the ABI but is intentionally
    // never emitted by this taker; monitoring must subscribe to
    // AggregatorSwapExecuted (distinct topic0 carrying the indexed source and
    // the allowlisted call target). This pins that event contract.
    const result = await executeTake({});
    const receipt = await (await result.send()).wait();

    const takerLogs = receipt.logs.filter(
      (log) => log.address.toLowerCase() === result.taker.address.toLowerCase()
    );

    const lifiTopic = result.taker.interface.getEventTopic(
      'AggregatorSwapExecuted'
    );
    const genericTopic = utils.id(
      'SwapExecuted(address,address,uint256,uint256)'
    );

    const lifiLogs = takerLogs.filter((log) => log.topics[0] === lifiTopic);
    expect(lifiLogs.length).to.equal(1);
    const parsed = result.taker.interface.parseLog(lifiLogs[0]);
    expect(parsed.args.source).to.equal(LiquiditySource.LIFI);
    expect(parsed.args.tokenIn).to.equal(result.collateral.address);
    expect(parsed.args.tokenOut).to.equal(result.quote.address);
    expect(parsed.args.target).to.equal(result.target.address);
    expect(parsed.args.amountIn.eq(result.amountIn)).to.equal(true);
    expect(parsed.args.amountOut.eq(result.outputAmount)).to.equal(true);

    expect(
      takerLogs.some((log) => log.topics[0] === genericTopic)
    ).to.equal(false);
  });

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

  it('sweeps a forced source-token donation instead of letting it grief the take', async () => {
    const result = await executeTake({});
    const ownerCollateralBefore = await result.collateral.balanceOf(
      result.owner.address
    );
    // An attacker can transfer dust of the collateral token directly to the
    // taker. A balanceOf-based exact-fill check would revert every take for that
    // collateral (cheap permanent griefing); the take must instead trust the
    // pool's reported callback collateral, succeed, and sweep the dust to owner.
    await result.collateral.mint(result.taker.address, 1);

    await result.send();

    expect((await result.pool.takeCount()).eq(1)).to.be.true;
    expect((await result.collateral.balanceOf(result.taker.address)).eq(0)).to.be
      .true;
    expect(
      (await result.collateral.balanceOf(result.owner.address))
        .sub(ownerCollateralBefore)
        .eq(1)
    ).to.be.true;
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

  it('rejects valid-pool callbacks outside an active direct DEX take', async () => {
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

  it('rejects active-pool callbacks whose data does not hash-match the in-flight take', async () => {
    // Packet 2B regression: an extraction that kept _activeCallbackPool but
    // dropped _activeCallbackDataHash would pass the sender half of the
    // binding. The mock pool delivers mutated callback bytes mid-take; the
    // taker must reject them even though msg.sender IS the active pool.
    const result = await executeTake({});
    await result.pool.setMutateCallbackData(true);

    await expectRevertWith(result.send(), 'UnexpectedCallback');
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

  it('rejects a zero-delivery aggregator swap even when the taker is pre-funded above the floor', async () => {
    // Donation immunity: the aggregator taker measures the quote it RECEIVES as a
    // balance delta. outputAmount: 0 makes the swap deliver nothing; pre-funding the
    // taker with the full min-out (a forced donation) would let an absolute-balanceOf
    // taker settle, so the delta guard must still reject.
    const result = await executeTake({
      outputAmount: constants.Zero,
      amountOutMinimum: utils.parseEther('1'),
      quoteAmountDue: utils.parseEther('1'),
    });
    await result.quote.mint(result.taker.address, utils.parseEther('1'));

    await expectRevertWith(result.send(), 'InsufficientQuoteReceived');
  });
});
