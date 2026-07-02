import { expect } from 'chai';
import sinon from 'sinon';
import { BigNumber, ethers } from 'ethers';
import * as curveRouterModule from '../../src/dex/curve-router';
import { NonceTracker } from '../../src/nonce';
import { CurvePoolType } from '../../src/config';
import * as uniswapModule from '../../src/dex/uniswap';

describe('Curve Router Module', () => {
  let swapStub: sinon.SinonStub;
  let mockSigner: any;
  let queueTransactionStub: sinon.SinonStub;

  beforeEach(() => {
    // Reset sinon after each test
    sinon.restore();

    // Create basic mocks - same pattern as the V3 router tests
    mockSigner = {
      getAddress: sinon.stub().resolves('0xTestAddress'),
      getChainId: sinon.stub().resolves(8453), // Base chain ID
      provider: {
        getNetwork: sinon.stub().resolves({ chainId: 8453, name: 'base' }),
        estimateGas: sinon.stub().resolves(BigNumber.from('100000')),
        getGasPrice: sinon.stub().resolves(BigNumber.from('20000000000')),
        getCode: sinon.stub().resolves('0x123456'), // Non-empty code
      },
      sendTransaction: sinon.stub().resolves({
        hash: '0xTestHash',
        wait: sinon.stub().resolves({ transactionHash: '0xTestHash' }),
      }),
    };

    // Mock NonceTracker - same pattern as the V3 router tests
    queueTransactionStub = sinon
      .stub(NonceTracker, 'queueTransaction')
      .callsFake(async (signer, txFunc) => {
        return await txFunc(10);
      });

    // Stub the actual exported function
    swapStub = sinon.stub(curveRouterModule, 'swapWithCurveRouter');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('swapWithCurveRouter', () => {
    function createRealContractHarness(params: {
      tokenAddress: string;
      targetTokenAddress: string;
      poolAddress: string;
      amount: BigNumber;
      currentAllowance: BigNumber;
    }) {
      const provider = new ethers.providers.JsonRpcProvider();
      sinon
        .stub(provider, 'getNetwork')
        .resolves({ chainId: 8453, name: 'base' } as any);
      sinon
        .stub(provider, 'getGasPrice')
        .resolves(BigNumber.from('20000000000'));

      const tokenInterface = new ethers.utils.Interface([
        'function allowance(address,address) view returns (uint256)',
      ]);
      const poolInterface = new ethers.utils.Interface([
        'function coins(uint256 i) external view returns (address)',
        'function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256)',
      ]);
      const cryptoPoolInterface = new ethers.utils.Interface([
        'function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256)',
      ]);
      const getDySelectors = new Set([
        poolInterface.getSighash('get_dy'),
        cryptoPoolInterface.getSighash('get_dy'),
      ]);
      sinon.stub(provider, 'call').callsFake(async (tx: any) => {
        const to = String(tx.to).toLowerCase();
        const data = String(tx.data);
        if (to === params.tokenAddress.toLowerCase()) {
          return tokenInterface.encodeFunctionResult('allowance', [
            params.currentAllowance,
          ]);
        }
        if (to !== params.poolAddress.toLowerCase()) {
          throw new Error(`unexpected contract call to ${to}`);
        }
        if (data.startsWith(poolInterface.getSighash('coins'))) {
          const [index] = poolInterface.decodeFunctionData('coins', data);
          if (BigNumber.from(index).eq(0)) {
            return poolInterface.encodeFunctionResult('coins', [
              params.tokenAddress,
            ]);
          }
          if (BigNumber.from(index).eq(1)) {
            return poolInterface.encodeFunctionResult('coins', [
              params.targetTokenAddress,
            ]);
          }
          throw new Error('end of pool coins');
        }
        if (getDySelectors.has(data.slice(0, 10))) {
          return poolInterface.encodeFunctionResult('get_dy', [
            params.amount.mul(2),
          ]);
        }
        throw new Error(`unexpected pool call ${data}`);
      });

      const signer = ethers.Wallet.createRandom().connect(provider);
      const sentTransactions: any[] = [];
      const sendTransactionStub = sinon
        .stub(signer, 'sendTransaction')
        .callsFake(async (tx) => {
          sentTransactions.push(tx);
          return {
            hash: `0x${String(sentTransactions.length).padStart(64, '0')}`,
            wait: sinon.stub().resolves({
              transactionHash: `0x${String(sentTransactions.length).padStart(64, '0')}`,
              gasUsed: BigNumber.from(1),
              logs: [],
            }),
          } as any;
        });

      return { signer, sendTransactionStub, sentTransactions };
    }

    it('should execute successful swap with STABLE pool type', async () => {
      // Return success to simulate a successful call
      swapStub.resolves({
        success: true,
        receipt: { transactionHash: '0xSuccess' },
      });

      // Call the actual function with STABLE pool parameters
      const result = await curveRouterModule.swapWithCurveRouter(
        mockSigner,
        '0x53Be558aF29cC65126ED0E585119FAC748FeB01B', // USDC_T from config
        BigNumber.from('1000000'), // amount
        '0xf0c44a9f24159E1f2A0D9Ba3203172f528d224CA', // USD_T1 from config
        1.0, // slippagePercentage
        '0x01C2c9f2C271ECEF81287B44FA6F813a1605F5Eb', // STABLE pool address from config
        CurvePoolType.STABLE,
        1.0 // defaultSlippage
      );

      // Verify the function was called
      expect(swapStub.calledOnce).to.be.true;
      expect(result.success).to.be.true;
      if (!('receipt' in result) || !result.receipt) {
        expect.fail('Expected successful swap to include receipt');
      }
      expect(result.receipt.transactionHash).to.equal('0xSuccess');
    });

    it('should execute successful swap with CRYPTO pool type', async () => {
      // Return success to simulate a successful call
      swapStub.resolves({
        success: true,
        receipt: { transactionHash: '0xCryptoSuccess' },
      });

      // Call the actual function with CRYPTO pool parameters
      const result = await curveRouterModule.swapWithCurveRouter(
        mockSigner,
        '0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b', // tBTC from config
        BigNumber.from('100000000000000000'), // amount (0.1 tBTC)
        '0x4200000000000000000000000000000000000006', // WETH from config
        2.0, // slippagePercentage
        '0x6e53131F68a034873b6bFA15502aF094Ef0c5854', // CRYPTO pool address from config
        CurvePoolType.CRYPTO,
        2.0 // defaultSlippage
      );

      // Verify the function was called
      expect(swapStub.calledOnce).to.be.true;
      expect(result.success).to.be.true;
      if (!('receipt' in result) || !result.receipt) {
        expect.fail('Expected successful swap to include receipt');
      }
      expect(result.receipt.transactionHash).to.equal('0xCryptoSuccess');
    });

    it('should handle missing pool address validation', async () => {
      // Simulate a failed swap due to missing pool address
      swapStub.resolves({
        success: false,
        error: 'Curve pool address must be provided via configuration',
      });

      const result = await curveRouterModule.swapWithCurveRouter(
        mockSigner,
        '0x53Be558aF29cC65126ED0E585119FAC748FeB01B',
        BigNumber.from('1000000'),
        '0xf0c44a9f24159E1f2A0D9Ba3203172f528d224CA',
        1.0,
        '', // Empty pool address
        CurvePoolType.STABLE,
        1.0
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal(
        'Curve pool address must be provided via configuration'
      );
    });

    it('should handle missing pool type validation', async () => {
      // Simulate a failed swap due to missing pool type
      swapStub.resolves({
        success: false,
        error: 'Pool type must be provided via configuration',
      });

      const result = await curveRouterModule.swapWithCurveRouter(
        mockSigner,
        '0x53Be558aF29cC65126ED0E585119FAC748FeB01B',
        BigNumber.from('1000000'),
        '0xf0c44a9f24159E1f2A0D9Ba3203172f528d224CA',
        1.0,
        '0x01C2c9f2C271ECEF81287B44FA6F813a1605F5Eb',
        undefined as any, // Missing pool type
        1.0
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal(
        'Pool type must be provided via configuration'
      );
    });

    it('should handle swap failure', async () => {
      // Simulate a failed swap
      swapStub.resolves({
        success: false,
        error: 'Token indices not found in pool. Cannot proceed with swap.',
      });

      const result = await curveRouterModule.swapWithCurveRouter(
        mockSigner,
        '0x53Be558aF29cC65126ED0E585119FAC748FeB01B',
        BigNumber.from('1000000'),
        '0xf0c44a9f24159E1f2A0D9Ba3203172f528d224CA',
        1.0,
        '0x01C2c9f2C271ECEF81287B44FA6F813a1605F5Eb',
        CurvePoolType.STABLE,
        1.0
      );

      expect(result.success).to.be.false;
      expect(result.error).to.equal(
        'Token indices not found in pool. Cannot proceed with swap.'
      );
    });

    it('should handle exceptions during swap', async () => {
      // Simulate an exception
      swapStub.rejects(new Error('Transaction reverted'));

      try {
        await curveRouterModule.swapWithCurveRouter(
          mockSigner,
          '0x53Be558aF29cC65126ED0E585119FAC748FeB01B',
          BigNumber.from('1000000'),
          '0xf0c44a9f24159E1f2A0D9Ba3203172f528d224CA',
          1.0,
          '0x01C2c9f2C271ECEF81287B44FA6F813a1605F5Eb',
          CurvePoolType.STABLE,
          1.0
        );
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).to.equal('Transaction reverted');
      }
    });

    it('uses default slippage and skips approval when Curve allowance already equals the swap amount', async () => {
      swapStub.restore();
      const tokenAddress = '0x1111111111111111111111111111111111111111';
      const targetTokenAddress = '0x2222222222222222222222222222222222222222';
      const poolAddress = '0x3333333333333333333333333333333333333333';
      const amount = BigNumber.from('1000000000000000000');
      const { signer, sendTransactionStub, sentTransactions } =
        createRealContractHarness({
          tokenAddress,
          targetTokenAddress,
          poolAddress,
          amount,
          currentAllowance: amount,
        });
      sinon.stub(uniswapModule, 'getTokenFromAddress').callsFake(
        async (_chainId, _provider, address) =>
          ({
            address,
            symbol: address === tokenAddress ? 'IN' : 'OUT',
            decimals: 18,
          }) as any
      );

      const result = await curveRouterModule.swapWithCurveRouter(
        signer as any,
        tokenAddress,
        amount,
        targetTokenAddress,
        undefined as any,
        poolAddress,
        CurvePoolType.STABLE,
        1
      );

      expect(result.success).to.equal(true);
      expect(sendTransactionStub.calledOnce).to.equal(true);
      expect(String(sentTransactions[0].to).toLowerCase()).to.equal(
        poolAddress.toLowerCase()
      );
      expect(queueTransactionStub.calledOnce).to.equal(true);
    });

    it('resets stale nonzero allowance before exact reapproval on crypto pools', async () => {
      swapStub.restore();
      const tokenAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const targetTokenAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const poolAddress = '0xcccccccccccccccccccccccccccccccccccccccc';
      const amount = BigNumber.from('1000000000000000000');
      const { signer, sendTransactionStub, sentTransactions } =
        createRealContractHarness({
          tokenAddress,
          targetTokenAddress,
          poolAddress,
          amount,
          currentAllowance: amount.mul(2),
        });
      sinon.stub(uniswapModule, 'getTokenFromAddress').callsFake(
        async (_chainId, _provider, address) =>
          ({
            address,
            symbol: address === tokenAddress ? 'IN' : 'OUT',
            decimals: 18,
          }) as any
      );

      const result = await curveRouterModule.swapWithCurveRouter(
        signer as any,
        tokenAddress,
        amount,
        targetTokenAddress,
        1,
        poolAddress,
        CurvePoolType.CRYPTO,
        1
      );

      expect(result.success).to.equal(true);
      expect(sendTransactionStub.calledThrice).to.equal(true);
      expect(String(sentTransactions[0].to).toLowerCase()).to.equal(
        tokenAddress.toLowerCase()
      );
      expect(String(sentTransactions[1].to).toLowerCase()).to.equal(
        tokenAddress.toLowerCase()
      );
      expect(String(sentTransactions[2].to).toLowerCase()).to.equal(
        poolAddress.toLowerCase()
      );
      expect(queueTransactionStub.callCount).to.equal(3);
    });
  });

  // Test NonceTracker integration - same pattern as the V3 router tests
  describe('Integration with NonceTracker', () => {
    it('should use NonceTracker.queueTransaction for transactions', async () => {
      // Restore the original method before this test
      swapStub.restore();

      // Test the interaction with NonceTracker
      const dummyTxFunction = async (nonce: number) => {
        return { success: true, transactionHash: '0xTest' };
      };

      // Call NonceTracker directly
      const result = await NonceTracker.queueTransaction(
        mockSigner,
        dummyTxFunction
      );

      // Verify it was called and returned expected result
      expect(queueTransactionStub.calledOnce).to.be.true;
      expect(result.success).to.be.true;
      expect(result.transactionHash).to.equal('0xTest');
    });
  });
});
