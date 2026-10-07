import { type BaseLogger, type LogMessage, renderLogMessage } from 'vintasend';

/**
 * Console-backed logger for local development.
 *
 * It writes straight to process output, so a host that may log PHI should inject a logger that
 * redacts and ships to managed storage instead. The library itself never touches `console`;
 * this class is the single, reviewed place it enters the package.
 */
export class MedplumLogger implements BaseLogger {
  private logger: Pick<Console, 'log' | 'error' | 'warn'>;

  constructor() {
    // biome-ignore lint/style/noRestrictedGlobals: MedplumLogger is the opt-in console sink; nothing else may reference console.
    this.logger = console;
  }

  info(message: LogMessage): void {
    this.logger.log(renderLogMessage(message));
  }

  error(message: LogMessage): void {
    this.logger.error(renderLogMessage(message));
  }

  warn(message: LogMessage): void {
    this.logger.warn(renderLogMessage(message));
  }
}
