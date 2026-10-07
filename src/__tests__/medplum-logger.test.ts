import { log, logCount, logError, logId, logLabel } from 'vintasend';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MedplumLogger } from '../medplum-logger';

describe('MedplumLogger', () => {
  let logger: MedplumLogger;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new MedplumLogger();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('should render info messages to console.log', () => {
    logger.info(log`Notification ${logId('comm-1')} has ${logCount(2)} attachments`);

    expect(consoleLogSpy).toHaveBeenCalledWith('Notification comm-1 has 2 attachments');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('should render error messages to console.error', () => {
    logger.error(log`Send via ${logLabel('email')} failed: ${logError(new TypeError('x'))}`);

    expect(consoleErrorSpy).toHaveBeenCalledWith('Send via email failed: TypeError');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('should render warn messages to console.warn', () => {
    logger.warn(log`Recipient reference has no id for notification ${logId('comm-2')}`);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Recipient reference has no id for notification comm-2',
    );
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('should print a logged error by name only', () => {
    logger.error(
      log`Failed: ${logError(new Error('Patient Jane Synthetic, DOB 1970-01-01, not found'))}`,
    );

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]).toEqual(['Failed: Error']);
  });
});
