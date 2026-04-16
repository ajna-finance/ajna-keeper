import { Signer } from 'ethers';
import { logger } from './logging';
import {
  clearDurableNonceFloor,
  clearDurableNonceStateForTests,
  getDurableNonceFloor,
  setDurableNonceStateFilePathForTests,
  upsertDurableNonceFloor,
} from './durable-nonce-state';

export class NonceConsumedTransactionError extends Error {
  readonly nonceConsumed = true;
  readonly txHash?: string;

  constructor(message: string, options?: { txHash?: string; cause?: unknown }) {
    super(message);
    this.name = 'NonceConsumedTransactionError';
    this.txHash = options?.txHash;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isNonceConsumedTransactionError(
  error: unknown
): error is NonceConsumedTransactionError {
  return (
    error instanceof NonceConsumedTransactionError ||
    (!!error &&
      typeof error === 'object' &&
      'nonceConsumed' in error &&
      (error as { nonceConsumed?: unknown }).nonceConsumed === true)
  );
}

export class NonceTracker {
  private nonces: Map<string, number> = new Map();
  private queues: Map<string, Promise<unknown>> = new Map();
  private nonceReaders: Map<string, Signer[]> = new Map();
  private static instance: NonceTracker;

  // Universal RPC cache refresh delay - applies to all chains
  private static readonly RPC_CACHE_REFRESH_DELAY = 1000; // 1000ms for aggressive RPC caching
  private static readonly DEFAULT_PENDING_NONCE_READER_TIMEOUT_MS = 2_000;
  private static pendingNonceReaderTimeoutMs =
    NonceTracker.DEFAULT_PENDING_NONCE_READER_TIMEOUT_MS;

  constructor() {
    if (!NonceTracker.instance) {
      NonceTracker.instance = this;
    }
    return NonceTracker.instance;
  }

  static async getNonce(signer: Signer): Promise<number> {
    const tracker = new NonceTracker();
    return tracker.getNonce(signer);
  }

  static async resetNonce(signer: Signer, address: string) {
    const tracker = new NonceTracker();
    return await tracker.resetNonce(signer, address);
  }

  static clearNonces() {
    const tracker = new NonceTracker();
    tracker.nonces = new Map();
    tracker.queues = new Map();
    tracker.nonceReaders = new Map();
    NonceTracker.pendingNonceReaderTimeoutMs =
      NonceTracker.DEFAULT_PENDING_NONCE_READER_TIMEOUT_MS;
    logger.debug('Cleared all nonce tracking data');
  }

  static setDurableNonceStateFilePathForTests(filePath?: string) {
    setDurableNonceStateFilePathForTests(filePath);
  }

  static clearDurableNonceStateForTests() {
    clearDurableNonceStateForTests();
  }

  static setPendingNonceReaderTimeoutMsForTests(timeoutMs?: number) {
    NonceTracker.pendingNonceReaderTimeoutMs =
      timeoutMs ?? NonceTracker.DEFAULT_PENDING_NONCE_READER_TIMEOUT_MS;
  }

  static async markDurableNonceFloor(params: {
    signer: Signer;
    nonce: number;
    txHash?: string;
    expiresAtBlock?: number;
    expiresAtMs?: number;
    relayUrl?: string;
  }) {
    const tracker = new NonceTracker();
    return await tracker.markDurableNonceFloor(params);
  }

  static registerNonceReaders(address: string, signers: Signer[]) {
    const tracker = new NonceTracker();
    tracker.registerNonceReaders(address, signers);
  }

  static async queueTransaction<T>(
    signer: Signer,
    txFunction: (nonce: number) => Promise<T>
  ): Promise<T> {
    const tracker = new NonceTracker();
    return tracker.queueTransaction(signer, txFunction);
  }

  public async getNonce(signer: Signer): Promise<number> {
    const address = await signer.getAddress();
    logger.debug(`Getting nonce for address: ${address}`);

    // If we don't have a nonce stored, get it from the network
    if (this.nonces.get(address) === undefined) {
      await this.resetNonce(signer, address);
    }

    // Get the current nonce value
    const currentNonce = this.nonces.get(address)!;
    logger.debug(`Using nonce: ${currentNonce}`);

    // Increment the stored nonce for next time
    this.nonces.set(address, currentNonce + 1);

    return currentNonce;
  }

  public async resetNonce(signer: Signer, address: string) {
    const latestNonce = await this.getPendingNonce(signer, address);
    logger.debug(`Reset nonce for ${address} to ${latestNonce}`);
    this.nonces.set(address, latestNonce);
    return latestNonce;
  }

  /**
   * Serializes transactions per address using a promise chain.
   * Concurrent calls for the same address wait for prior transactions to complete
   * before acquiring a nonce, preventing race conditions on failure/reset.
   *
   * On error, checks the network's pending nonce to determine if the tx was
   * broadcast before deciding whether to reset. This prevents nonce reuse
   * when a tx times out after being sent to the mempool.
   */
  public async queueTransaction<T>(
    signer: Signer,
    txFunction: (nonce: number) => Promise<T>
  ): Promise<T> {
    const address = await signer.getAddress();
    logger.debug(`Queueing transaction for ${address}`);

    // Synchronous read-then-write: safe because no await between reading
    // the queue and writing the new entry. For local Wallet signers,
    // getAddress() above returns a resolved promise whose continuation
    // runs atomically in a single microtask.
    const previous = this.queues.get(address) || Promise.resolve();

    const done = previous.catch(() => {}).then(async () => {
      const nonce = await this.getNonce(signer);
      logger.debug(`Executing transaction with nonce ${nonce}`);

      try {
        const result = await txFunction(nonce);

        // Universal RPC cache refresh delay after every transaction
        logger.debug(`Transaction with nonce ${nonce} completed, adding ${NonceTracker.RPC_CACHE_REFRESH_DELAY}ms RPC cache refresh delay`);
        await this.delay(NonceTracker.RPC_CACHE_REFRESH_DELAY);

        logger.debug(`Transaction with nonce ${nonce} completed successfully`);
        return result;
      } catch (txError) {
        logger.error(`Transaction with nonce ${nonce} failed: ${txError}`);
        if (isNonceConsumedTransactionError(txError)) {
          await this.reconcileConsumedNonce(signer, address, nonce, txError.txHash);
          throw txError;
        }
        await this.handleFailedNonce(signer, address, nonce);
        throw txError;
      }
    });

    // Store a caught version so the chain never breaks.
    // Clean up the entry when it settles to prevent unbounded growth.
    const caught = done.catch(() => {});
    this.queues.set(address, caught);
    caught.then(() => {
      if (this.queues.get(address) === caught) {
        this.queues.delete(address);
      }
    });

    return done;
  }

  /**
   * After a failed transaction, check the network's pending nonce to decide
   * whether the nonce was consumed (tx was broadcast) or not (pre-broadcast
   * error like gas estimation failure or insufficient funds).
   *
   * - If pendingNonce > nonce: the tx reached the mempool. The stored nonce
   *   (already incremented to nonce+1 by getNonce) is correct. Do NOT reset.
   * - If pendingNonce <= nonce: the tx never made it to the mempool. Reset
   *   to the network value so the nonce can be reused.
   */
  private async handleFailedNonce(signer: Signer, address: string, nonce: number) {
    try {
      const pendingNonce = await this.getPendingNonce(signer, address);
      if (pendingNonce > nonce) {
        // Tx was broadcast — nonce is consumed. Sync to the network's pending nonce
        // in case it advanced by more than one (e.g., another process sent txs).
        this.nonces.set(address, pendingNonce);
        logger.warn(
          `Nonce ${nonce} was consumed (pending=${pendingNonce}), syncing nonce for ${address}`
        );
      } else {
        // Tx was NOT broadcast — safe to reset so the nonce can be reused.
        logger.debug(
          `Nonce ${nonce} was not consumed (pending=${pendingNonce}), resetting nonce for ${address}`
        );
        this.nonces.set(address, pendingNonce);
      }
    } catch (rpcError) {
      // If we can't query the network, preserve the incremented nonce.
      // A skipped nonce is recoverable (next cycle resyncs), but a reused
      // nonce after broadcast risks replacing a live transaction.
      logger.warn(`Failed to check pending nonce for ${address}, preserving incremented nonce: ${rpcError}`);
    }
  }


  private async reconcileConsumedNonce(
    signer: Signer,
    address: string,
    nonce: number,
    txHash?: string
  ) {
    const preservedNextNonce = Math.max(this.nonces.get(address) ?? nonce + 1, nonce + 1);

    try {
      const pendingNonce = await this.getPendingNonce(signer, address);
      const reconciledNonce = Math.max(preservedNextNonce, pendingNonce);
      this.nonces.set(address, reconciledNonce);

      logger.warn(
        `Preserving consumed nonce ${nonce} for ${address}${txHash ? ` after accepted submission ${txHash}` : ''}; reconciled next nonce to ${reconciledNonce}`
      );
    } catch (rpcError) {
      this.nonces.set(address, preservedNextNonce);
      logger.warn(
        `Failed to reconcile consumed nonce ${nonce} for ${address}${txHash ? ` after accepted submission ${txHash}` : ''}, preserving next nonce ${preservedNextNonce}: ${rpcError}`
      );
    }
  }

  private registerNonceReaders(address: string, signers: Signer[]) {
    const existing = this.nonceReaders.get(address) ?? [];
    const merged = [...existing];
    for (const signer of signers) {
      if (!merged.includes(signer)) {
        merged.push(signer);
      }
    }
    this.nonceReaders.set(address, merged);
    logger.debug(
      `Registered ${merged.length} nonce reader(s) for ${address}`
    );
  }

  private async getPendingNonce(signer: Signer, address: string): Promise<number> {
    const readers = this.nonceReaders.get(address) ?? [signer];
    const pendingNonces = await Promise.all(
      readers.map((reader) => this.getPendingNonceFromReader(reader, address))
    );

    const latestNonce = Math.max(...pendingNonces);
    if (latestNonce < 0) {
      throw new Error(`Failed to fetch pending nonce for ${address}`);
    }

    return await this.applyDurableNonceFloor(signer, address, latestNonce);
  }

  private async getPendingNonceFromReader(
    reader: Signer,
    address: string
  ): Promise<number> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.getTransactionCount('pending'),
        new Promise<number>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Pending nonce lookup timed out after ${NonceTracker.pendingNonceReaderTimeoutMs}ms`
              )
            );
          }, NonceTracker.pendingNonceReaderTimeoutMs);
        }),
      ]);
    } catch (error) {
      logger.warn(
        `Failed to fetch pending nonce for ${address} from a registered nonce reader: ${error}`
      );
      return -1;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async markDurableNonceFloor(params: {
    signer: Signer;
    nonce: number;
    txHash?: string;
    expiresAtBlock?: number;
    expiresAtMs?: number;
    relayUrl?: string;
  }): Promise<void> {
    const address = await params.signer.getAddress();
    const chainId = await params.signer.getChainId();
    await upsertDurableNonceFloor({
      chainId,
      address,
      nextNonce: params.nonce + 1,
      txHash: params.txHash,
      submittedAtMs: Date.now(),
      expiresAtBlock: params.expiresAtBlock,
      expiresAtMs: params.expiresAtMs,
      relayUrl: params.relayUrl,
    });

    logger.warn(
      `Persisted durable nonce floor ${params.nonce + 1} for ${address} on chain ${chainId}${params.txHash ? ` after accepted submission ${params.txHash}` : ''}`
    );
  }

  private async applyDurableNonceFloor(
    signer: Signer,
    address: string,
    observedPendingNonce: number
  ): Promise<number> {
    let chainId: number;
    try {
      chainId = await signer.getChainId();
    } catch {
      return observedPendingNonce;
    }
    const durableFloor = await getDurableNonceFloor(chainId, address);
    if (!durableFloor) {
      return observedPendingNonce;
    }

    if (observedPendingNonce >= durableFloor.nextNonce) {
      const cleared = await clearDurableNonceFloor(chainId, address);
      if (cleared) {
        logger.info(
          `Cleared durable nonce floor for ${address} on chain ${chainId} after provider caught up to pending nonce ${observedPendingNonce}`
        );
      }
      return observedPendingNonce;
    }

    if (
      durableFloor.expiresAtMs !== undefined &&
      Date.now() >= durableFloor.expiresAtMs
    ) {
      const cleared = await clearDurableNonceFloor(chainId, address);
      if (cleared) {
        logger.warn(
          `Cleared expired durable nonce floor for ${address} on chain ${chainId} after local expiry ${durableFloor.expiresAtMs}`
        );
      }
      return observedPendingNonce;
    }

    if (
      durableFloor.expiresAtBlock !== undefined &&
      signer.provider != null
    ) {
      try {
        const currentBlock = await signer.provider.getBlockNumber();
        if (currentBlock > durableFloor.expiresAtBlock) {
          const cleared = await clearDurableNonceFloor(chainId, address);
          if (cleared) {
            logger.warn(
              `Cleared expired durable nonce floor for ${address} on chain ${chainId} after block ${currentBlock} exceeded expiry ${durableFloor.expiresAtBlock}`
            );
          }
          return observedPendingNonce;
        }
      } catch (error) {
        logger.warn(
          `Failed to check block height for durable nonce floor on ${address}: ${error}`
        );
      }
    }

    logger.warn(
      `Using durable nonce floor ${durableFloor.nextNonce} for ${address} on chain ${chainId} while provider pending nonce remains ${observedPendingNonce}`
    );
    return durableFloor.nextNonce;
  }

  /**
   * Simple delay function
   */
  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
