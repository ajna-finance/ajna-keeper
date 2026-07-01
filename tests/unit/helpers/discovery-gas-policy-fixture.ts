import sinon from 'sinon';
import { BigNumber } from 'ethers';

export const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
export const QUOTE_TOKEN_ADDRESS = '0x9999999999999999999999999999999999999999';
export const ONEINCH_ROUTER_ADDRESS =
  '0x1111111111111111111111111111111111111111';

export function signerWithChain(chainId?: number): any {
  return {
    provider: {},
    ...(chainId !== undefined
      ? { getChainId: sinon.stub().resolves(chainId) }
      : {}),
  };
}

export function readRpcWithGasPrice(gasPrice: BigNumber): any {
  return {
    readRpc: {
      getGasPrice: sinon.stub().resolves(gasPrice),
    },
  };
}

export function oneInchGasConfig(
  takePolicy: Record<string, unknown> = {}
): any {
  return {
    autoDiscover: {
      enabled: true,
      take: {
        enabled: true,
        ...takePolicy,
      },
    },
    oneInchRouters: {
      1: ONEINCH_ROUTER_ADDRESS,
    },
    connectorTokens: [],
    tokenAddresses: {
      weth: WETH_ADDRESS,
    },
  };
}
