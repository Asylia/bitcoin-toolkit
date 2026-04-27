/**
 * Tiny structured logger for the Trezor adapter.
 *
 * Every log line is prefixed with `[hw-trezor]` so it is trivial to filter
 * in browser DevTools. We log at INFO level for normal lifecycle events
 * (init, request, response) and at ERROR level for failures, including
 * the full raw SDK payload — that is the single most useful piece of
 * information when debugging "Something went wrong" reports.
 *
 * The logger is always active. Hardware-wallet code is a hard security
 * boundary and the cost of console noise is far smaller than the cost of
 * a silent miswire. Production users still benefit because these logs
 * become the support-ticket attachment.
 */

const PREFIX = '[hw-trezor]';

export type LogContext = Record<string, unknown>;

export const log = {
  info(event: string, context?: LogContext): void {
    if (context) {
      console.info(`${PREFIX} ${event}`, context);
    } else {
      console.info(`${PREFIX} ${event}`);
    }
  },
  warn(event: string, context?: LogContext): void {
    if (context) {
      console.warn(`${PREFIX} ${event}`, context);
    } else {
      console.warn(`${PREFIX} ${event}`);
    }
  },
  error(event: string, context?: LogContext): void {
    if (context) {
      console.error(`${PREFIX} ${event}`, context);
    } else {
      console.error(`${PREFIX} ${event}`);
    }
  },
};
