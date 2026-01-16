import { MockClient } from '@medplum/mock';
import type { BaseEmailTemplateRenderer } from 'vintasend/dist/services/notification-template-renderers/base-email-template-renderer';
import type { DatabaseNotification } from 'vintasend/dist/types/notification';
import type { MedplumNotificationBackend } from '../medplum-backend';
import { MedplumNotificationAdapter } from '../medplum-adapter';

/**
 * Tests for MedplumNotificationAdapter basic functionality.
 *
 * NOTE: MockClient from @medplum/mock runs operations in-memory and is NOT a Jest mock.
 * To verify method calls, use jest.spyOn() instead of treating it as a mock:
 *
 * ✅ Correct: const spy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({})
 * ❌ Wrong:   medplumClient.sendEmail.mockResolvedValue({})
 */
describe('MedplumNotificationAdapter', () => {
  let medplumClient: MockClient;
  let mockTemplateRenderer: jest.Mocked<BaseEmailTemplateRenderer<any>>;
  let mockBackend: jest.Mocked<MedplumNotificationBackend<any>>;
  let adapter: MedplumNotificationAdapter<typeof mockTemplateRenderer, any>;
  let mockNotification: DatabaseNotification<any>;

  beforeEach(() => {
    jest.clearAllMocks();

    medplumClient = new MockClient();

    mockTemplateRenderer = {
      render: jest.fn(),
    } as jest.Mocked<BaseEmailTemplateRenderer<any>>;

    mockBackend = {
      getUserEmailFromNotification: jest.fn(),
    } as unknown as jest.Mocked<MedplumNotificationBackend<any>>;

    mockNotification = {
      id: '123',
      notificationType: 'EMAIL',
      contextName: 'testContext',
      contextParameters: {},
      userId: '456',
      title: 'Test Notification',
      bodyTemplate: '/path/to/template',
      subjectTemplate: '/path/to/subject',
      extraParams: {},
      contextUsed: null,
      adapterUsed: null,
      status: 'PENDING_SEND',
      sentAt: null,
      readAt: null,
      sendAfter: new Date(),
    };
  });

  it('should initialize with correct properties', () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);

    expect(adapter.notificationType).toBe('EMAIL');
    expect(adapter.key).toBe('medplum-email');
    expect(adapter.enqueueNotifications).toBe(false);
  });

  it('should send email successfully', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    const context = { foo: 'bar' };
    const renderedTemplate = {
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    };
    const userEmail = 'user@example.com';

    mockTemplateRenderer.render.mockResolvedValue(renderedTemplate);
    mockBackend.getUserEmailFromNotification.mockResolvedValue(userEmail);

    const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(mockNotification, context);

    expect(mockTemplateRenderer.render).toHaveBeenCalledWith(mockNotification, context);
    expect(mockBackend.getUserEmailFromNotification).toHaveBeenCalledWith('123');
    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: userEmail,
      subject: renderedTemplate.subject,
      text: renderedTemplate.body,
    });
  });

  it('should throw error if notification ID is missing', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    mockNotification.id = undefined;

    await expect(adapter.send(mockNotification, {})).rejects.toThrow('Notification ID is required');
  });

  it('should throw error if backend not injected', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);

    mockNotification.id = '123';

    await expect(adapter.send(mockNotification, {})).rejects.toThrow('Backend not injected');
  });

  it('should throw error if user email is not found', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    mockTemplateRenderer.render.mockResolvedValue({
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValue(undefined);

    await expect(adapter.send(mockNotification, {})).rejects.toThrow('User email not found');
  });

  it('should handle complex context objects', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    const complexContext = {
      user: { name: 'John Doe', email: 'john@example.com' },
      data: { items: [1, 2, 3], count: 3 },
      nested: { deep: { value: 'test' } },
    };

    mockTemplateRenderer.render.mockResolvedValue({
      subject: 'Complex Subject',
      body: '<p>Complex Body</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');

    const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(mockNotification, complexContext);

    expect(mockTemplateRenderer.render).toHaveBeenCalledWith(mockNotification, complexContext);
    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: 'user@example.com',
      subject: 'Complex Subject',
      text: '<p>Complex Body</p>',
    });
  });

  it('should handle template rendering errors', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    const renderError = new Error('Template not found');
    mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');
    mockTemplateRenderer.render.mockRejectedValue(renderError);

    const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail');

    await expect(adapter.send(mockNotification, {})).rejects.toThrow('Template not found');
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it('should handle email sending errors', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    mockTemplateRenderer.render.mockResolvedValue({
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');

    const sendError = new Error('SMTP connection failed');
    jest.spyOn(medplumClient, 'sendEmail').mockRejectedValue(sendError);

    await expect(adapter.send(mockNotification, {})).rejects.toThrow('SMTP connection failed');
  });

  it('should send multiple emails successfully', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    // First email
    mockTemplateRenderer.render.mockResolvedValueOnce({
      subject: 'First Subject',
      body: '<p>First Body</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValueOnce('user1@example.com');

    await adapter.send(mockNotification, { test: 1 });

    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: 'user1@example.com',
      subject: 'First Subject',
      text: '<p>First Body</p>',
    });

    // Second email with different notification
    const secondNotification = { ...mockNotification, id: '789' };
    mockTemplateRenderer.render.mockResolvedValueOnce({
      subject: 'Second Subject',
      body: '<p>Second Body</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValueOnce('user2@example.com');

    await adapter.send(secondNotification, { test: 2 });

    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: 'user2@example.com',
      subject: 'Second Subject',
      text: '<p>Second Body</p>',
    });

    expect(sendEmailSpy).toHaveBeenCalledTimes(2);
  });

  it('should handle empty context', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    mockTemplateRenderer.render.mockResolvedValue({
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');

    const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(mockNotification, {});

    expect(mockTemplateRenderer.render).toHaveBeenCalledWith(mockNotification, {});
    expect(sendEmailSpy).toHaveBeenCalled();
  });

  it('should handle different notification types gracefully', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    const smsNotification = { ...mockNotification, notificationType: 'SMS' as const };

    mockTemplateRenderer.render.mockResolvedValue({
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');

    const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    // Should still send via email (adapter is configured for EMAIL type)
    await adapter.send(smsNotification, {});

    expect(sendEmailSpy).toHaveBeenCalled();
  });

  it('should handle special characters in email content', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    mockTemplateRenderer.render.mockResolvedValue({
      subject: 'Test <Subject> with "quotes"',
      body: '<p>Body with special chars: & < > " \'</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');

    const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(mockNotification, {});

    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: 'user@example.com',
      subject: 'Test <Subject> with "quotes"',
      text: '<p>Body with special chars: & < > " \'</p>',
    });
  });

  it('should handle very long email content', async () => {
    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
    adapter.injectBackend(mockBackend);

    const longBody = '<p>' + 'a'.repeat(10000) + '</p>';
    mockTemplateRenderer.render.mockResolvedValue({
      subject: 'Test Subject',
      body: longBody,
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');

    const sendEmailSpy = jest.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(mockNotification, {});

    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: 'user@example.com',
      subject: 'Test Subject',
      text: longBody,
    });
  });

  describe('backend injection', () => {
    it('should allow backend injection after initialization', () => {
      adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);

      expect(() => adapter.injectBackend(mockBackend)).not.toThrow();
    });

    it('should throw when sending without backend', async () => {
      adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);

      await expect(adapter.send(mockNotification, {})).rejects.toThrow('Backend not injected');
    });
  });

  describe('notification validation', () => {
    beforeEach(() => {
      adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer);
      adapter.injectBackend(mockBackend);
    });

    it('should validate notification has required fields', async () => {
      const invalidNotification = {
        ...mockNotification,
        id: null,
      } as any;

      await expect(adapter.send(invalidNotification, {})).rejects.toThrow('Notification ID is required');
    });

    it('should handle null notification ID', async () => {
      mockNotification.id = null as any;

      await expect(adapter.send(mockNotification, {})).rejects.toThrow('Notification ID is required');
    });

    it('should handle undefined notification ID', async () => {
      mockNotification.id = undefined as any;

      await expect(adapter.send(mockNotification, {})).rejects.toThrow('Notification ID is required');
    });
  });
});
