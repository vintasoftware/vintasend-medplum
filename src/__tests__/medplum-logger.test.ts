import { MedplumLogger } from '../medplum-logger';

describe('MedplumLogger', () => {
  let logger: MedplumLogger;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new MedplumLogger();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('info', () => {
    it('should log info messages using console.log', () => {
      const message = 'This is an info message';
      
      logger.info(message);
      
      expect(consoleLogSpy).toHaveBeenCalledWith(message);
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle empty strings', () => {
      logger.info('');
      
      expect(consoleLogSpy).toHaveBeenCalledWith('');
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle complex messages', () => {
      const message = 'User logged in: { userId: 123, timestamp: 2026-01-16 }';
      
      logger.info(message);
      
      expect(consoleLogSpy).toHaveBeenCalledWith(message);
    });
  });

  describe('error', () => {
    it('should log error messages using console.error', () => {
      const message = 'This is an error message';
      
      logger.error(message);
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(message);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle empty strings', () => {
      logger.error('');
      
      expect(consoleErrorSpy).toHaveBeenCalledWith('');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle error stack traces', () => {
      const message = 'Error: Something went wrong\n    at Object.<anonymous>';
      
      logger.error(message);
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(message);
    });
  });

  describe('warn', () => {
    it('should log warning messages using console.warn', () => {
      const message = 'This is a warning message';
      
      logger.warn(message);
      
      expect(consoleWarnSpy).toHaveBeenCalledWith(message);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle empty strings', () => {
      logger.warn('');
      
      expect(consoleWarnSpy).toHaveBeenCalledWith('');
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle deprecation warnings', () => {
      const message = 'DEPRECATED: This method will be removed in version 2.0';
      
      logger.warn(message);
      
      expect(consoleWarnSpy).toHaveBeenCalledWith(message);
    });
  });

  describe('multiple log calls', () => {
    it('should handle multiple consecutive info calls', () => {
      logger.info('First message');
      logger.info('Second message');
      logger.info('Third message');
      
      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      expect(consoleLogSpy).toHaveBeenNthCalledWith(1, 'First message');
      expect(consoleLogSpy).toHaveBeenNthCalledWith(2, 'Second message');
      expect(consoleLogSpy).toHaveBeenNthCalledWith(3, 'Third message');
    });

    it('should handle mixed log levels', () => {
      logger.info('Info message');
      logger.warn('Warning message');
      logger.error('Error message');
      
      expect(consoleLogSpy).toHaveBeenCalledWith('Info message');
      expect(consoleWarnSpy).toHaveBeenCalledWith('Warning message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error message');
    });
  });
});
