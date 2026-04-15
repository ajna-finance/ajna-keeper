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
const DEFAULT_RELAY_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RELAY_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_RELAY_MAX_BLOCK_NUMBER_OFFSET = 25;
const DEFAULT_ACCEPTED_PRIVATE_RPC_NONCE_FLOOR_TTL_MS = 15 * 60_000;
const DEFAULT_TAKE_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_TAKE_WRITE_NETWORK_TIMEOUT_MS = 5_000;

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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function waitForReceiptWithTimeout(params: {
  txHash: string;
  wait: () => Promise<providers.TransactionReceipt>;
  timeoutMs: number;
}): Promise<providers.TransactionReceipt> {
  const { txHash, wait, timeoutMs } = params;
  return await withTimeout(
    wait(),
    timeoutMs,
    `Transaction confirmation timeout for ${txHash}`
  ).catch((error) => {
    if (error instanceof Error && error.message.startsWith('Transaction confirmation timeout for')) {
      throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms for ${txHash}`);
    }
    throw error;
  });
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
  const hasTakeWriteRpcUrl =
    Object.prototype.hasOwnProperty.call(config, 'takeWriteRpcUrl') &&
    (config as { takeWriteRpcUrl?: unknown }).takeWriteRpcUrl !== undefined;
  const shorthandRpcUrl = hasTakeWriteRpcUrl
    ? (config as { takeWriteRpcUrl?: unknown }).takeWriteRpcUrl
    : undefined;

  if (config.takeWrite && hasTakeWriteRpcUrl) {
    throw new Error(
      'Configure only one of takeWrite or takeWriteRpcUrl, not both'
    );
  }

  if (config.takeWrite) {
    return config.takeWrite;
  }

  if (hasTakeWriteRpcUrl) {
    if (
      typeof shorthandRpcUrl !== 'string' ||
      shorthandRpcUrl.trim().length === 0
    ) {
      throw new Error('takeWriteRpcUrl cannot be blank');
    }

    return {
      mode: TakeWriteTransportMode.PRIVATE_RPC,
      rpcUrl: shorthandRpcUrl.trim(),
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
    default:
      throw new Error(
        `Unsupported take write transport mode: ${String(normalizedConfig.mode)}`
      );
  }
}

export async function submitTakeTransaction(
  transport: TakeWriteTransport,
  txRequest: providers.TransactionRequest
): Promise<providers.TransactionReceipt> {
  const submission = await transport.submitTransaction(txRequest);
  return await submission.wait();
}

function resolveExplicitNonce(
  txLike: Pick<providers.TransactionRequest, 'nonce'>
): number | undefined {
  if (txLike.nonce === undefined) {
    return undefined;
  }

  return ethers.BigNumber.from(txLike.nonce).toNumber();
}

function getAcceptedSubmissionNonceFloorExpiryMs(
  receiptTimeoutMs: number = DEFAULT_TAKE_RECEIPT_TIMEOUT_MS
): number {
  return Date.now() + Math.max(
    receiptTimeoutMs,
    DEFAULT_ACCEPTED_PRIVATE_RPC_NONCE_FLOOR_TTL_MS
  );
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
        wait: async () => {
          try {
            return await waitForReceiptWithTimeout({
              txHash: response.hash,
              wait: () => response.wait(),
              timeoutMs: receiptTimeoutMs,
            });
          } catch (error) {
            throw new NonceConsumedTransactionError(
              `Public RPC submission ${response.hash} was accepted but receipt wait failed`,
              {
                txHash: response.hash,
                cause: error,
              }
            );
          }
        },
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
  const network = await withTimeout(
    provider.getNetwork(),
    DEFAULT_TAKE_WRITE_NETWORK_TIMEOUT_MS,
    `takeWrite private_rpc getNetwork for ${params.rpcUrl}`
  );
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
        wait: async () => {
          try {
            return await waitForReceiptWithTimeout({
              txHash: response.hash,
              wait: () => response.wait(),
              timeoutMs:
                params.receiptTimeoutMs ?? DEFAULT_TAKE_RECEIPT_TIMEOUT_MS,
            });
          } catch (error) {
            const acceptedNonce = resolveExplicitNonce({
              nonce: response.nonce ?? txRequest.nonce,
            });
            if (acceptedNonce !== undefined) {
              try {
                await NonceTracker.markDurableNonceFloor({
                  signer: params.signer,
                  nonce: acceptedNonce,
                  txHash: response.hash,
                  expiresAtMs: getAcceptedSubmissionNonceFloorExpiryMs(
                    params.receiptTimeoutMs
                  ),
                });
              } catch (durableNonceError) {
                throw new NonceConsumedTransactionError(
                  `Private RPC submission ${response.hash} was accepted but durable nonce floor persistence failed`,
                  {
                    txHash: response.hash,
                    cause: durableNonceError,
                  }
                );
              }
            }

            throw new NonceConsumedTransactionError(
              `Private RPC submission ${response.hash} was accepted but receipt wait failed`,
              {
                txHash: response.hash,
                cause: error,
              }
            );
          }
        },
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
      if (txRequest.nonce === undefined) {
        throw new Error('Relay take submission requires an explicit nonce');
      }

      const populatedTx = await params.signer.populateTransaction({
        ...txRequest,
        chainId: params.expectedChainId,
      });
      if (populatedTx.nonce === undefined) {
        throw new Error('Relay take submission requires a populated nonce');
      }

      const nonce = ethers.BigNumber.from(populatedTx.nonce).toNumber();
      const relayMethod =
        params.relay.sendMethod ?? DEFAULT_RELAY_SEND_METHOD;
      const relaySupportsBlockExpiry =
        relayMethodSupportsBlockExpiry(relayMethod);
      if (!relaySupportsBlockExpiry && params.relay.maxBlockNumberOffset !== undefined) {
        logger.warn(
          `Relay sendMethod=${relayMethod} does not support maxBlockNumberOffset; applying only a local durable nonce expiry`
        );
      }
      const expiresAtBlock = relaySupportsBlockExpiry
        ? (await params.signer.provider!.getBlockNumber()) +
          (params.relay.maxBlockNumberOffset ??
            DEFAULT_RELAY_MAX_BLOCK_NUMBER_OFFSET)
        : undefined;
      const expiresAtMs = relaySupportsBlockExpiry
        ? undefined
        : getAcceptedSubmissionNonceFloorExpiryMs(
            params.relay.receiptTimeoutMs ?? params.defaultReceiptTimeoutMs
          );

      const rawTx = await params.signer.signTransaction(populatedTx);
      const localTxHash = ethers.utils.keccak256(rawTx);
      const relayRequestBody = buildRelayRequestBody(
        relayMethod,
        rawTx,
        expiresAtBlock
      );
      let txHash: string;
      try {
        const response = await axios.post(params.relay.url, relayRequestBody, {
          headers: {
            'Content-Type': 'application/json',
            ...(params.relay.headers ?? {}),
          },
          timeout:
            params.relay.requestTimeoutMs ?? DEFAULT_RELAY_REQUEST_TIMEOUT_MS,
        });
        try {
          txHash = extractRelayTxHash(response.data, localTxHash);
        } catch (error) {
          if (relayResponseMayHideAcceptedTransaction(response.data)) {
            await throwRelayNonceConsumedError({
              signer: params.signer,
              nonce,
              txHash: localTxHash,
              expiresAtBlock,
              expiresAtMs,
              relayUrl: params.relay.url,
              message: `Relay submission for ${localTxHash} may have been accepted but the response body did not contain a usable transaction hash`,
              cause: error,
            });
          }
          throw error;
        }
      } catch (error) {
        const responseTxHash = tryExtractRelayTxHashFromErrorResponse(
          error,
          localTxHash
        );
        if (
          responseTxHash ||
          relayErrorResponseMayHideAcceptedTransaction(error) ||
          isAmbiguousRelaySubmissionFailure(error)
        ) {
          await throwRelayNonceConsumedError({
            signer: params.signer,
            nonce,
            txHash: responseTxHash ?? localTxHash,
            expiresAtBlock,
            expiresAtMs,
            relayUrl: params.relay.url,
            message: responseTxHash
              ? `Relay accepted transaction ${responseTxHash} but the submission response was surfaced as an error`
              : `Relay submission for ${localTxHash} may have been accepted before the HTTP response was lost`,
            cause: error,
          });
        }
        throw error;
      }

      try {
        await NonceTracker.markDurableNonceFloor({
          signer: params.signer,
          nonce,
          txHash,
          expiresAtBlock,
          expiresAtMs,
          relayUrl: params.relay.url,
        });
      } catch (error) {
        throw new NonceConsumedTransactionError(
          `Relay accepted transaction ${txHash} but durable nonce floor persistence failed`,
          {
            txHash,
            cause: error,
          }
        );
      }

      logger.info(
        `Accepted relay take submission via ${relayMethod} | tx: ${txHash}${expiresAtBlock !== undefined ? ` expiresAfterBlock=${expiresAtBlock}` : ''}${expiresAtMs !== undefined ? ` localExpiryAtMs=${expiresAtMs}` : ''}`
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

async function throwRelayNonceConsumedError(params: {
  signer: Wallet;
  nonce: number;
  txHash: string;
  expiresAtBlock?: number;
  expiresAtMs?: number;
  relayUrl: string;
  message: string;
  cause: unknown;
}): Promise<never> {
  let durableFloorPersistenceError: unknown;
  try {
    await NonceTracker.markDurableNonceFloor({
      signer: params.signer,
      nonce: params.nonce,
      txHash: params.txHash,
      expiresAtBlock: params.expiresAtBlock,
      expiresAtMs: params.expiresAtMs,
      relayUrl: params.relayUrl,
    });
  } catch (error) {
    durableFloorPersistenceError = error;
  }

  throw new NonceConsumedTransactionError(
    durableFloorPersistenceError
      ? `${params.message}; durable nonce floor persistence also failed`
      : params.message,
    {
      txHash: params.txHash,
      cause: durableFloorPersistenceError
        ? {
            relaySubmissionError: params.cause,
            durableNonceFloorPersistenceError: durableFloorPersistenceError,
          }
        : params.cause,
    }
  );
}

function isAmbiguousRelaySubmissionFailure(error: unknown): boolean {
  if (axios.isAxiosError(error) && error.response?.data !== undefined) {
    return false;
  }

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ERR_NETWORK' ||
    code === 'EPIPE'
  ) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('network error') ||
    message.includes('connection reset')
  );
}

function tryExtractRelayTxHashFromErrorResponse(
  error: unknown,
  fallbackTxHash: string
): string | undefined {
  if (!axios.isAxiosError(error) || error.response?.data === undefined) {
    return undefined;
  }

  try {
    return extractRelayTxHash(error.response.data, fallbackTxHash);
  } catch {
    return undefined;
  }
}

function relayErrorResponseMayHideAcceptedTransaction(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.data === undefined) {
    return false;
  }

  return relayResponseMayHideAcceptedTransaction(error.response.data);
}

function relayResponseMayHideAcceptedTransaction(responseData: unknown): boolean {
  if (!hasRelayResultPayload(responseData) || hasExplicitRelayError(responseData)) {
    return false;
  }

  const result =
    responseData && typeof responseData === 'object'
      ? (responseData as { result?: unknown }).result
      : undefined;

  if (typeof result === 'string') {
    return result.trim() !== '';
  }

  if (result && typeof result === 'object') {
    const txHash = (result as { txHash?: unknown; hash?: unknown }).txHash;
    const hash = (result as { txHash?: unknown; hash?: unknown }).hash;
    return typeof txHash === 'string' || typeof hash === 'string';
  }

  return false;
}

function relayMethodSupportsBlockExpiry(method: string): boolean {
  return method === DEFAULT_RELAY_SEND_METHOD;
}

function hasRelayResultPayload(responseData: unknown): boolean {
  return (
    !!responseData &&
    typeof responseData === 'object' &&
    'result' in responseData
  );
}

function hasExplicitRelayError(responseData: unknown): boolean {
  return (
    !!responseData &&
    typeof responseData === 'object' &&
    'error' in responseData &&
    (responseData as { error?: unknown }).error !== undefined
  );
}

function isValidRelayTxHash(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function normalizeValidatedRelayTxHash(
  txHash: string,
  fallbackTxHash: string
): string {
  if (!isValidRelayTxHash(txHash)) {
    throw new Error(`Relay submission returned invalid tx hash: ${txHash}`);
  }

  if (txHash.toLowerCase() !== fallbackTxHash.toLowerCase()) {
    throw new Error(
      `Relay submission returned mismatched tx hash ${txHash}; expected ${fallbackTxHash}`
    );
  }

  return fallbackTxHash;
}

function extractRelayTxHash(responseData: unknown, fallbackTxHash: string): string {
  if (hasExplicitRelayError(responseData)) {
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

  if (typeof result === 'string') {
    return normalizeValidatedRelayTxHash(result, fallbackTxHash);
  }

  if (result && typeof result === 'object') {
    const txHash = (result as { txHash?: unknown; hash?: unknown }).txHash;
    if (typeof txHash === 'string') {
      return normalizeValidatedRelayTxHash(txHash, fallbackTxHash);
    }
    const hash = (result as { txHash?: unknown; hash?: unknown }).hash;
    if (typeof hash === 'string') {
      return normalizeValidatedRelayTxHash(hash, fallbackTxHash);
    }
  }

  throw new Error('Relay submission did not return a valid tx hash');
}
