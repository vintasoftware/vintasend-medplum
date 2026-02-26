import { MockClient } from '@medplum/mock';
import type { BaseEmailTemplateRenderer } from 'vintasend/dist/services/notification-template-renderers/base-email-template-renderer';
import type { DatabaseNotification, DatabaseOneOffNotification } from 'vintasend/dist/types/notification';
import type { MedplumNotificationBackend } from '../medplum-backend';
import { MedplumNotificationAdapter } from '../medplum-adapter';

/**
 * Tests for MedplumNotificationAdapter one-off notifications support.
 *
 * NOTE: MockClient from @medplum/mock runs operations in-memory and is NOT a Jest mock.
 * To verify method calls, use jest.spyOn() instead of treating it as a mock:
 *
 * ✅ Correct: const spy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({})
 * ❌ Wrong:   medplumClient.sendEmail.mockResolvedValue({})
 *
 * The test.setup.ts file configures the MockClient with proper FHIR search parameters
 * to enable filtering in tests.
 */
describe('MedplumNotificationAdapter - One-Off Notifications', () => {
  let medplumClient: MockClient;
  let mockTemplateRenderer: jest.Mocked<BaseEmailTemplateRenderer<any>>;
  let mockBackend: jest.Mocked<MedplumNotificationBackend<any>>;
  let adapter: MedplumNotificationAdapter<typeof mockTemplateRenderer, any>;

  let mockOneOffNotification: DatabaseOneOffNotification<any>;
  let mockRegularNotification: DatabaseNotification<any>;

  beforeEach(() => {
    medplumClient = new MockClient();

    mockTemplateRenderer = {
      render: jest.fn(),
    } as jest.Mocked<BaseEmailTemplateRenderer<any>>;

    mockBackend = {
      getUserEmailFromNotification: jest.fn(),
    } as unknown as jest.Mocked<MedplumNotificationBackend<any>>;

    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer, false);
    adapter.injectBackend(mockBackend);

    mockOneOffNotification = {
      id: '123',
      emailOrPhone: 'oneoff@example.com',
      firstName: 'John',
      lastName: 'Doe',
      notificationType: 'EMAIL',
      contextName: 'testContext',
      contextParameters: {},
      title: 'Test One-Off Notification',
      bodyTemplate: '/path/to/template',
      subjectTemplate: 'Test Subject',
      extraParams: {},
      contextUsed: null,
      adapterUsed: null,
      gitCommitSha: null,
      status: 'PENDING_SEND',
      sentAt: null,
      readAt: null,
      sendAfter: null,
    };

    mockRegularNotification = {
      id: '456',
      userId: 'user-789',
      notificationType: 'EMAIL',
      contextName: 'testContext',
      contextParameters: {},
      title: 'Test Regular Notification',
      bodyTemplate: '/path/to/template',
      subjectTemplate: 'Test Subject',
      extraParams: {},
      contextUsed: null,
      adapterUsed: null,
      gitCommitSha: null,
      status: 'PENDING_SEND',
      sentAt: null,
      readAt: null,
      sendAfter: new Date(),
    };
  });

  describe('sending one-off notifications', () => {
    it('should send one-off notification to emailOrPhone address', async () => {
      mockTemplateRenderer.render.mockResolvedValue({
        subject: 'Test Subject',
        body: '<p>Test Body</p>',
      });

      const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

      await adapter.send(mockOneOffNotification, {});

      expect(mockTemplateRenderer.render).toHaveBeenCalledWith(mockOneOffNotification, {});
      expect(sendEmailSpy).toHaveBeenCalledWith({
        to: 'oneoff@example.com',
        subject: 'Test Subject',
        text: '<p>Test Body</p>',
      });
      expect(mockBackend.getUserEmailFromNotification).not.toHaveBeenCalled();
    });

    it('should send one-off notification with context', async () => {
      mockTemplateRenderer.render.mockResolvedValue({
        subject: 'Welcome John',
        body: '<p>Hello John Doe</p>',
      });

      const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

      const context = {
        firstName: 'John',
        lastName: 'Doe',
        customField: 'value',
      };

      await adapter.send(mockOneOffNotification, context);

      expect(mockTemplateRenderer.render).toHaveBeenCalledWith(mockOneOffNotification, context);
      expect(sendEmailSpy).toHaveBeenCalledWith({
        to: 'oneoff@example.com',
        subject: 'Welcome John',
        text: '<p>Hello John Doe</p>',
      });
    });

    it('should handle email sending errors for one-off notifications', async () => {
      mockTemplateRenderer.render.mockResolvedValue({
        subject: 'Test Subject',
        body: '<p>Test Body</p>',
      });

      const error = new Error('Email sending failed');
      jest.spyOn(medplumClient, 'sendEmail').mockRejectedValue(error);

      await expect(adapter.send(mockOneOffNotification, {})).rejects.toThrow(
        'Email sending failed',
      );
    });

    it('should throw error if notification ID is missing for one-off notification', async () => {
      const notificationWithoutId = {
        ...mockOneOffNotification,
        id: null,
      } as any;

      await expect(adapter.send(notificationWithoutId, {})).rejects.toThrow(
        'Notification ID is required',
      );
    });
  });

  describe('sending regular notifications (backward compatibility)', () => {
    it('should still send regular notifications using getUserEmailFromNotification', async () => {
      mockTemplateRenderer.render.mockResolvedValue({
        subject: 'Test Subject',
        body: '<p>Test Body</p>',
      });

      mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');
      const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

      await adapter.send(mockRegularNotification, {});

      expect(mockTemplateRenderer.render).toHaveBeenCalledWith(mockRegularNotification, {});
      expect(mockBackend.getUserEmailFromNotification).toHaveBeenCalledWith('456');
      expect(sendEmailSpy).toHaveBeenCalledWith({
        to: 'user@example.com',
        subject: 'Test Subject',
        text: '<p>Test Body</p>',
      });
    });

    it('should handle missing user email for regular notifications', async () => {
      mockTemplateRenderer.render.mockResolvedValue({
        subject: 'Test Subject',
        body: '<p>Test Body</p>',
      });

      mockBackend.getUserEmailFromNotification.mockResolvedValue(undefined);

      await expect(adapter.send(mockRegularNotification, {})).rejects.toThrow(
        'User email not found for notification 456',
      );
    });
  });

  describe('mixed notification sending', () => {
    it('should correctly handle sending both one-off and regular notifications in sequence', async () => {
      mockTemplateRenderer.render.mockResolvedValue({
        subject: 'Test Subject',
        body: '<p>Test Body</p>',
      });

      let sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

      // Send one-off notification
      await adapter.send(mockOneOffNotification, {});
      expect(sendEmailSpy).toHaveBeenCalledWith({
        to: 'oneoff@example.com',
        subject: 'Test Subject',
        text: '<p>Test Body</p>',
      });

      jest.clearAllMocks();
      mockTemplateRenderer.render.mockResolvedValue({
        subject: 'Test Subject 2',
        body: '<p>Test Body 2</p>',
      });

      mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');
      sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

      // Send regular notification
      await adapter.send(mockRegularNotification, {});
      expect(mockBackend.getUserEmailFromNotification).toHaveBeenCalledWith('456');
      expect(sendEmailSpy).toHaveBeenCalledWith({
        to: 'user@example.com',
        subject: 'Test Subject 2',
        text: '<p>Test Body 2</p>',
      });
    });
  });

  describe('error handling', () => {
    it('should throw error if backend not injected for regular notifications', async () => {
      const adapterWithoutBackend = new MedplumNotificationAdapter(
        medplumClient,
        mockTemplateRenderer,
        false,
      );

      mockTemplateRenderer.render.mockResolvedValue({
        subject: 'Test Subject',
        body: '<p>Test Body</p>',
      });

      await expect(adapterWithoutBackend.send(mockRegularNotification, {})).rejects.toThrow(
        'Backend not injected',
      );
    });

    it('should handle template rendering errors for one-off notifications', async () => {
      const error = new Error('Template not found');
      mockTemplateRenderer.render.mockRejectedValue(error);
      const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail');

      await expect(adapter.send(mockOneOffNotification, {})).rejects.toThrow('Template not found');
      expect(sendEmailSpy).not.toHaveBeenCalled();
    });
  });
});
