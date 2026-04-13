import { Signer } from '@ajna-finance/sdk';
import axios from 'axios';
import { ethers, providers, Wallet } from 'ethers';
import {
  KeeperConfig,
  TakeWriteConfig,
  TakeWriteRelayConfig,
  TakeWriteTransportMode,
} from '../config';
import { logger } from '../logging';
import { JsonRpcProvider } from '../provider';
import { NonceConsumedTransactionError, NonceTracker } from '../nonce';

const DEFAULT_RELAY_SEND_METHOD = 'eth_sendPrivateTransaction';
const DEFAULT_RELAY_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_RELAY_MAX_BLOCK_NUMBER_OFFSET = 25;
const DEFAULT_TAKE_RECEIPT_TIMEOUT_MS = 120_000;

export interface TakeWriteSubmission {
  txHash: string;
  wait(): Promise<providers.TransactionReceipt>;
}

export interface TakeWriteTransport {
  mode: TakeWriteTransportMode;
  signer: Signer;
  submitTransaction(
    txRequest: providers.TransactionRequest
  ): Promise<TakeWriteSubmission>;
}

export interface TakeWriteTransportConfig {
  takeWriteTransport?: TakeWriteTransport;
}

async function waitForReceiptWithTimeout(params: {
  txHash: string;
  wait: () => Promise<providers.TransactionReceipt>;
  timeoutMs: number;
}): Promise<providers.TransactionReceipt> {
  const { txHash, wait, timeoutMs } = params;
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      wait(),
      new Promise<providers.TransactionReceipt>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(
              `Transaction confirmation timeout after ${timeoutMs}ms for ${txHash}`
            )
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function resolveTakeWriteTransport(
  signer: Signer,
  config?: TakeWriteTransportConfig
): TakeWriteTransport {
  return config?.takeWriteTransport ?? createPublicRpcTakeWriteTransport(signer);
}

export function resolveTakeWriteConfig(
  config: Pick<KeeperConfig, 'takeWrite' | 'takeWriteRpcUrl'>
): TakeWriteConfig | undefined {
  if (config.takeWrite && config.takeWriteRpcUrl) {
    throw new Error(
      'Configure only one of takeWrite or takeWriteRpcUrl, not both'
    );
  }

  if (config.takeWrite) {
    return config.takeWrite;
  }

  if (config.takeWriteRpcUrl) {
    return {
      mode: TakeWriteTransportMode.PRIVATE_RPC,
      rpcUrl: config.takeWriteRpcUrl,
    };
  }

  return undefined;
}

export async function createTakeWriteTransport(params: {
  signer: Wallet;
  config: Pick<KeeperConfig, 'takeWrite' | 'takeWriteRpcUrl'>;
  expectedChainId: number;
}): Promise<TakeWriteTransport> {
  const normalizedConfig = resolveTakeWriteConfig(params.config);
  if (!normalizedConfig) {
    return createPublicRpcTakeWriteTransport(params.signer);
  }

  switch (normalizedConfig.mode) {
    case TakeWriteTransportMode.PUBLIC_RPC:
      logger.info(
        `Configured take write transport mode=${TakeWriteTransportMode.PUBLIC_RPC}`
      );
      return createPublicRpcTakeWriteTransport(
        params.signer,
        normalizedConfig.receiptTimeoutMs
      );

    case TakeWriteTransportMode.PRIVATE_RPC:
      if (!normalizedConfig.rpcUrl) {
        throw new Error(
          'takeWrite.mode=private_rpc requires takeWrite.rpcUrl'
        );
      }
      return await createPrivateRpcTakeWriteTransport({
        signer: params.signer,
        rpcUrl: normalizedConfig.rpcUrl,
        expectedChainId: params.expectedChainId,
        receiptTimeoutMs: normalizedConfig.receiptTimeoutMs,
      });

    case TakeWriteTransportMode.RELAY:
      if (!normalizedConfig.relay?.url) {
        throw new Error('takeWrite.mode=relay requires takeWrite.relay.url');
      }
      return await createRelayTakeWriteTransport({
        signer: params.signer,
        relay: normalizedConfig.relay,
        expectedChainId: params.expectedChainId,
        defaultReceiptTimeoutMs: normalizedConfig.receiptTimeoutMs,
      });
  }
}

export async function submitTakeTransaction(
  transport: TakeWriteTransport,
  txRequest: providers.TransactionRequest
): Promise<providers.TransactionReceipt> {
  const submission = await transport.submitTransaction(txRequest);
  return await submission.wait();
}

function createPublicRpcTakeWriteTransport(
  signer: Signer,
  receiptTimeoutMs: number = DEFAULT_TAKE_RECEIPT_TIMEOUT_MS
): TakeWriteTransport {
  return {
    mode: TakeWriteTransportMode.PUBLIC_RPC,
    signer,
    submitTransaction: async (
      txRequest: providers.TransactionRequest
    ): Promise<TakeWriteSubmission> => {
      const response = await signer.sendTransaction(txRequest);
      return {
        txHash: response.hash,
        wait: async () =>
          await waitForReceiptWithTimeout({
            txHash: response.hash,
            wait: () => response.wait(),
            timeoutMs: receiptTimeoutMs,
          }),
      };
    },
  };
}

async function createPrivateRpcTakeWriteTransport(params: {
  signer: Wallet;
  rpcUrl: string;
  expectedChainId: number;
  receiptTimeoutMs?: number;
}): Promise<TakeWriteTransport> {
  const provider = new JsonRpcProvider(params.rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== params.expectedChainId) {
    throw new Error(
      `Configured take write rpc chainId ${network.chainId} does not match keeper chainId ${params.expectedChainId}`
    );
  }

  const writeSigner = params.signer.connect(provider);
  NonceTracker.registerNonceReaders(writeSigner.address, [
    params.signer,
    writeSigner,
  ]);

  logger.info(
    `Configured take write transport mode=${TakeWriteTransportMode.PRIVATE_RPC} for ${writeSigner.address} on chain ${network.chainId}`
  );

  return {
    mode: TakeWriteTransportMode.PRIVATE_RPC,
    signer: writeSigner,
    submitTransaction: async (
      txRequest: providers.TransactionRequest
    ): Promise<TakeWriteSubmission> => {
      const response = await writeSigner.sendTransaction(txRequest);
      return {
        txHash: response.hash,
        wait: async () =>
          await waitForReceiptWithTimeout({
            txHash: response.hash,
            wait: () => response.wait(),
            timeoutMs:
              params.receiptTimeoutMs ?? DEFAULT_TAKE_RECEIPT_TIMEOUT_MS,
          }),
      };
    },
  };
}

async function createRelayTakeWriteTransport(params: {
  signer: Wallet;
  relay: TakeWriteRelayConfig;
  expectedChainId: number;
  defaultReceiptTimeoutMs?: number;
}): Promise<TakeWriteTransport> {
  const chainId = await params.signer.getChainId();
  if (chainId !== params.expectedChainId) {
    throw new Error(
      `Configured relay signer chainId ${chainId} does not match keeper chainId ${params.expectedChainId}`
    );
  }

  if (!params.signer.provider) {
    throw new Error(
      'Relay take write transport requires the keeper signer to be connected to a provider for tx population and receipt tracking'
    );
  }

  logger.info(
    `Configured take write transport mode=${TakeWriteTransportMode.RELAY} for ${await params.signer.getAddress()} on chain ${chainId}`
  );

  return {
    mode: TakeWriteTransportMode.RELAY,
    signer: params.signer,
    submitTransaction: async (
      txRequest: providers.TransactionRequest
    ): Promise<TakeWriteSubmission> => {
      const populatedTx = await params.signer.populateTransaction({
        ...txRequest,
        chainId: params.expectedChainId,
      });
      if (populatedTx.nonce === undefined) {
        throw new Error('Relay take submission requires a populated nonce');
      }

      const nonce = ethers.BigNumber.from(populatedTx.nonce).toNumber();
      const currentBlock = await params.signer.provider!.getBlockNumber();
      const relayMethod =
        params.relay.sendMethod ?? DEFAULT_RELAY_SEND_METHOD;
      const maxBlockNumberOffset =
        relayMethod === DEFAULT_RELAY_SEND_METHOD
          ? params.relay.maxBlockNumberOffset ??
            DEFAULT_RELAY_MAX_BLOCK_NUMBER_OFFSET
          : undefined;
      const expiresAtBlock =
        maxBlockNumberOffset !== undefined
          ? currentBlock + maxBlockNumberOffset
          : undefined;

      const rawTx = await params.signer.signTransaction(populatedTx);
      const localTxHash = ethers.utils.keccak256(rawTx);
      const relayRequestBody = buildRelayRequestBody(
        relayMethod,
        rawTx,
        expiresAtBlock
      );
      const response = await axios.post(params.relay.url, relayRequestBody, {
        headers: {
          'Content-Type': 'application/json',
          ...(params.relay.headers ?? {}),
        },
        timeout:
          params.relay.receiptTimeoutMs ??
          params.defaultReceiptTimeoutMs ??
          DEFAULT_RELAY_RECEIPT_TIMEOUT_MS,
      });
      const txHash = extractRelayTxHash(response.data, localTxHash);

      await NonceTracker.markDurableNonceFloor({
        signer: params.signer,
        nonce,
        txHash,
        expiresAtBlock,
        relayUrl: params.relay.url,
      });

      logger.info(
        `Accepted relay take submission via ${relayMethod} | tx: ${txHash}${expiresAtBlock !== undefined ? ` expiresAfterBlock=${expiresAtBlock}` : ''}`
      );

      return {
        txHash,
        wait: async () => {
          try {
            const receipt = await params.signer.provider!.waitForTransaction(
              txHash,
              1,
              params.relay.receiptTimeoutMs ??
                params.defaultReceiptTimeoutMs ??
                DEFAULT_RELAY_RECEIPT_TIMEOUT_MS
            );
            if (!receipt) {
              throw new Error(
                `No receipt returned for accepted relay transaction ${txHash}`
              );
            }
            return receipt;
          } catch (error) {
            throw new NonceConsumedTransactionError(
              `Relay accepted transaction ${txHash} but receipt wait failed`,
              {
                txHash,
                cause: error,
              }
            );
          }
        },
      };
    },
  };
}

function buildRelayRequestBody(
  method: string,
  rawTx: string,
  expiresAtBlock?: number
): {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
} {
  if (method === DEFAULT_RELAY_SEND_METHOD) {
    const param: {
      tx: string;
      maxBlockNumber?: string;
    } = {
      tx: rawTx,
    };
    if (expiresAtBlock !== undefined) {
      param.maxBlockNumber = ethers.utils.hexValue(expiresAtBlock);
    }
    return {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params: [param],
    };
  }

  return {
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params: [rawTx],
  };
}

function extractRelayTxHash(responseData: unknown, fallbackTxHash: string): string {
  if (
    responseData &&
    typeof responseData === 'object' &&
    'error' in responseData &&
    (responseData as { error?: unknown }).error !== undefined
  ) {
    throw new Error(
      `Relay submission failed: ${JSON.stringify(
        (responseData as { error: unknown }).error
      )}`
    );
  }

  const result =
    responseData && typeof responseData === 'object'
      ? (responseData as { result?: unknown }).result
      : undefined;

  if (typeof result === 'string' && result.startsWith('0x')) {
    return result;
  }

  if (result && typeof result === 'object') {
    const txHash = (result as { txHash?: unknown; hash?: unknown }).txHash;
    if (typeof txHash === 'string' && txHash.startsWith('0x')) {
      return txHash;
    }
    const hash = (result as { txHash?: unknown; hash?: unknown }).hash;
    if (typeof hash === 'string' && hash.startsWith('0x')) {
      return hash;
    }
  }

  return fallbackTxHash;
}
