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
  target.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled promise rejection in keeper process', reason);
  });
  target.on('uncaughtException', (error: unknown) => {
    logger.error('Uncaught exception in keeper process', error);
    process.exit(1);
  });
  target.on('SIGTERM', () => {
    logger.info('Received SIGTERM; shutting down keeper.');
    process.exit(0);
  });
  target.on('SIGINT', () => {
    logger.info('Received SIGINT; shutting down keeper.');
    process.exit(0);
  });
}
