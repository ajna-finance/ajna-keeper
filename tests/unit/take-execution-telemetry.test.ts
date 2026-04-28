import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber } from 'ethers';
import { LiquiditySource } from '../../src/config';
import { logger } from '../../src/logging';
import {
  logTakeExecutionTelemetry,
  TAKE_EXECUTION_TELEMETRY_VERSION,
} from '../../src/take/execution-telemetry';

describe('take execution telemetry', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('logs versioned fields at debug level when gas divergence is at the warning boundary', () => {
    const debugStub = sinon.stub(logger, 'debug');
    const warnStub = sinon.stub(logger, 'warn');

    logTakeExecutionTelemetry({
      path: 'factory',
      source: LiquiditySource.UNISWAPV3,
      poolName: 'Telemetry Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      borrower: '0x2222222222222222222222222222222222222222',
      receipt: {
        transactionHash: '0xabc',
        gasUsed: BigNumber.from(120),
      } as any,
      routeProfitability: {
        routeGasLimit: BigNumber.from(100),
        expectedNetProfitQuoteRaw: BigNumber.from(50),
        expectedShortfallQuoteRaw: BigNumber.from(0),
      },
      approvedMinOutRaw: BigNumber.from(90),
      selectedFeeTier: 3000,
    });

    expect(warnStub.called).to.be.false;
    expect(debugStub.calledOnce).to.be.true;
    const message = String(debugStub.firstCall.args[0]);
    expect(message).to.include(
      `version=${TAKE_EXECUTION_TELEMETRY_VERSION}`
    );
    expect(message).to.include('path=factory');
    expect(message).to.include('source=UNISWAPV3');
    expect(message).to.include('borrowerHash=0x');
    expect(message).to.not.include('borrower=0x2222222222222222222222222222222222222222');
    expect(message).to.include('gasDivergenceBps=2000');
    expect(message).to.include('approvedMinOutRaw=90');
    expect(message).to.include('expectedShortfallRaw=0');
  });

  it('warns when observed gas divergence exceeds the threshold', () => {
    const debugStub = sinon.stub(logger, 'debug');
    const warnStub = sinon.stub(logger, 'warn');

    logTakeExecutionTelemetry({
      path: 'oneinch',
      source: LiquiditySource.ONEINCH,
      poolName: 'Telemetry Pool',
      poolAddress: '0x1111111111111111111111111111111111111111',
      borrower: '0x2222222222222222222222222222222222222222',
      receipt: {
        transactionHash: '0xdef',
        gasUsed: BigNumber.from(121),
      } as any,
      routeProfitability: {
        routeGasLimit: BigNumber.from(100),
        expectedNetProfitQuoteRaw: BigNumber.from(50),
        expectedShortfallQuoteRaw: BigNumber.from(5),
      },
      approvedMinOutRaw: BigNumber.from(90),
    });

    expect(debugStub.called).to.be.false;
    expect(warnStub.calledOnce).to.be.true;
    expect(String(warnStub.firstCall.args[0])).to.include(
      'gasDivergenceBps=2100'
    );
    expect(String(warnStub.firstCall.args[0])).to.include(
      'expectedShortfallRaw=5'
    );
  });
});
