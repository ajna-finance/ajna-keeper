import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import { LiquiditySource } from '../../../src/config';
import { AjnaKeeperTakerFactory__factory } from '../../../typechain-types/factories/contracts/factories';
import { MockLifiSwapTarget__factory } from '../../../typechain-types/factories/contracts/mocks';
import { LifiKeeperTaker__factory } from '../../../typechain-types/factories/contracts/takers';
import {
  deployMockTakerBase,
  expectRevertContaining,
  fundSigner,
  getProvider,
} from './mock-taker-base';

export { fundSigner, getProvider };
export const expectRevertWith = expectRevertContaining;

const LIFI_DETAILS_ABI =
  'tuple(address approvalSpender,address srcToken,address dstToken,address dstReceiver,uint256 amountInTokenUnits,uint256 amountOutMinimum,bytes callData)';

export const BORROWER = utils.getAddress(
  '0x00000000000000000000000000000000000000b0'
);

export type LifiSwapDetailsParams = {
  approvalSpender: string;
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amountIn: BigNumber;
  amountOutMinimum: BigNumber;
  callData: string;
};

export type ExecuteTakeParams = {
  outputAmount?: BigNumber;
  amountOutMinimum?: BigNumber;
  quoteAmountDue?: BigNumber;
  approvalSpender?: string;
  detailsAmountIn?: BigNumber;
  allowedSelector?: string;
  callData?: string;
  swapRouter?: string;
};

export async function deployFixture() {
  const base = await deployMockTakerBase();
  const { owner, poolDeployer, pool } = base;
  const collateral = base.collateralToken;
  const quote = base.quoteToken;

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

export function buildDetails(params: LifiSwapDetailsParams) {
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

export function encodeDetails(params: LifiSwapDetailsParams): string {
  return utils.defaultAbiCoder.encode(
    [LIFI_DETAILS_ABI],
    [buildDetails(params)]
  );
}

export function encodeCallbackData(
  params: LifiSwapDetailsParams,
  swapRouter: string
): string {
  return utils.defaultAbiCoder.encode(
    [LIFI_DETAILS_ABI, 'address'],
    [buildDetails(params), swapRouter]
  );
}

export async function executeTake(params: ExecuteTakeParams) {
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
  overrides: Partial<LifiSwapDetailsParams> = {}
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

export async function expectInvalidSwapDetails(params: {
  executeOverrides?: ExecuteTakeParams;
  detailOverrides?: Partial<LifiSwapDetailsParams>;
}) {
  const result = await executeTake(params.executeOverrides ?? {});
  const details = encodeDetailsForExecution(result, params.detailOverrides);

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
  expect((await result.collateral.balanceOf(result.target.address)).eq(0)).to.be
    .true;
}
