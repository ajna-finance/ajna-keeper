import { logger } from './logging';

type SignalTarget = {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

/**
 * Install process-level safety handlers for the long-running keeper daemon
 * (surfaced-defects #3). Without these, an unhandled promise rejection escaping
 * one of the fire-and-forget loops can terminate the whole daemon, and there is
 * no graceful shutdown on SIGTERM/SIGINT (container stop / Ctrl-C).
 *
 * `target` is injectable for testing; defaults to the real process.
 */
export function installProcessSafetyHandlers(
  target: SignalTarget = process
): void {
  // Intentional asymmetry (audit Pass-2): unhandledRejection is NON-fatal while
  // uncaughtException exits. The whole point of this handler is that a transient
  // rejection escaping a fire-and-forget loop must NOT terminate the daemon —
  // the supervised loops self-recover next iteration. A synchronous
  // uncaughtException is a harder failure (corrupt sync state) and is fatal.
  target.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled promise rejection in keeper process', reason);
  });
  target.on('uncaughtException', (error: unknown) => {
    logger.error('Uncaught exception in keeper process', error);
    process.exit(1);
  });
  // SIGTERM/SIGINT exit immediately without draining in-flight work. Cross-restart
  // nonce safety relies on the durable nonce floor, which is persisted once a tx
  // is ACCEPTED by the RPC/relay. There is a small unprotected window between
  // dispatching a tx and its acceptance returning: a signal landing there can
  // abort the request before the floor is written, so if that tx still lands
  // on-chain a restarted keeper could collide on the nonce (wasted/stranded tx,
  // not fund loss). Draining that window (an in-flight-submit gate) is left as
  // optional hardening; the immediate exit is the documented behavior.
  target.on('SIGTERM', () => {
    logger.info('Received SIGTERM; shutting down keeper.');
    process.exit(0);
  });
  target.on('SIGINT', () => {
    logger.info('Received SIGINT; shutting down keeper.');
    process.exit(0);
  });
}
