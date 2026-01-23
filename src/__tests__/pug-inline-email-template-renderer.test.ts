import type { ContextGenerator } from 'vintasend/dist/services/notification-context-registry';
import type { DatabaseNotification } from 'vintasend/dist/types/notification';
import { InlineTemplateRendererFactory } from '../pug-inline-email-template-renderer';
import type { BaseEmailTemplateRenderer } from 'vintasend';

type MockConfig = {
  ContextMap: { testContext: ContextGenerator };
  NotificationIdType: string;
  UserIdType: string;
};

describe('InlineTemplateRenderer', () => {
  let renderer: BaseEmailTemplateRenderer<MockConfig>;
  let mockNotification: DatabaseNotification<MockConfig>;

  // Define template strings inline (plain text mode with interpolation)
  const templates = {
    'test-notification': `html
  head
    title Email
  body
    h1 Hello #{name}!
    p Your message: #{message}`,
    'test-subject': `| Welcome #{name}`,
    'invalid-template': `p= undefinedVariable.nonExistentProperty`,
    'invalid-subject': `| = undefinedVariable.nonExistentProperty`,
  };

  beforeEach(() => {
    renderer = new InlineTemplateRendererFactory<MockConfig>().create(templates);
    mockNotification = {
      id: '123',
      notificationType: 'EMAIL' as const,
      contextName: 'testContext',
      contextParameters: {},
      userId: '456',
      title: 'Test Notification',
      bodyTemplate: 'test-notification',
      subjectTemplate: 'test-subject',
      extraParams: {},
      contextUsed: null,
      adapterUsed: null,
      status: 'PENDING_SEND' as const,
      sentAt: null,
      readAt: null,
      sendAfter: new Date(),
    };
  });

  it('should render email template with context', async () => {
    const context = {
      name: 'John',
      message: 'Hello World',
    };

    const result = await renderer.render(mockNotification, context);

    expect(result.subject).toBe('Welcome John');
    expect(result.body).toContain('Hello John!');
    expect(result.body).toContain('Your message: Hello World');
  });

  it('should throw error when subject template is missing', async () => {
    const notification = {
      ...mockNotification,
      id: 'test-notification',
      bodyTemplate: 'test-notification',
      subjectTemplate: null,
      userId: 'user123',
    };

    await expect(renderer.render(notification, {})).rejects.toThrow('Subject template is required');
  });

  it('should handle empty context', async () => {
    const notification = {
      ...mockNotification,
      id: 'test-notification',
      bodyTemplate: 'test-notification',
      subjectTemplate: 'test-subject',
      userId: 'user123',
    };

    const result = await renderer.render(notification, {});

    expect(result.subject).toBe('Welcome ');
    expect(result.body).toContain('Hello !');
    expect(result.body).toContain('Your message: ');
  });

  it('should throw error when template key not found', async () => {
    const notification = {
      ...mockNotification,
      subjectTemplate: 'non-existent-subject',
    };

    await expect(renderer.render(notification, {})).rejects.toThrow('Subject template "non-existent-subject" not found in templates');
  });

  it('should throw error when body template not found', async () => {
    const notification = {
      ...mockNotification,
      bodyTemplate: 'non-existent-body',
    };

    await expect(renderer.render(notification, {})).rejects.toThrow('Body template "non-existent-body" not found in templates');
  });

  it('should handle template runtime errors', async () => {
    const notification = {
      ...mockNotification,
      bodyTemplate: 'invalid-template',
      subjectTemplate: 'invalid-subject',
    };

    await expect(renderer.render(notification, { undefinedVariable: undefined })).rejects.toThrow();
  });

  it('should throw error when bodyTemplate is empty', async () => {
    const notification = {
      ...mockNotification,
      bodyTemplate: '',
    };

    await expect(renderer.render(notification, { name: 'Test' })).rejects.toThrow('Body template is required');
  });

  it('should throw error when subjectTemplate is empty', async () => {
    const notification = {
      ...mockNotification,
      subjectTemplate: '',
    };

    await expect(renderer.render(notification, { name: 'Test' })).rejects.toThrow('Subject template is required');
  });

  it('should create renderer with empty templates object', () => {
    const emptyRenderer = new InlineTemplateRendererFactory<MockConfig>().create({});
    expect(emptyRenderer).toBeDefined();
  });
});
