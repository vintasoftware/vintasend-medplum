import { MockClient } from '@medplum/mock';
import type {
  AttachmentFile,
  BaseEmailTemplateRenderer,
  DatabaseNotification,
  StoredAttachment,
} from 'vintasend';
import { MedplumNotificationAdapter } from '../medplum-adapter';
import type { MedplumNotificationBackend } from '../medplum-backend';

/**
 * Tests for MedplumNotificationAdapter attachments support.
 *
 * NOTE: MockClient from @medplum/mock runs operations in-memory and is NOT a framework mock.
 * To verify method calls, use vi.spyOn() instead of treating it as a mock:
 *
 * ✅ Correct: const spy = vi.spyOn(medplumClient, 'sendEmail').mockResolvedValue({})
 * ❌ Wrong:   medplumClient.sendEmail.mockResolvedValue({})
 *
 * The test.setup.ts file configures the MockClient with proper FHIR search parameters
 * to enable filtering in tests.
 */
describe('MedplumNotificationAdapter - Attachments', () => {
  let medplumClient: MockClient;
  let mockTemplateRenderer: vi.Mocked<BaseEmailTemplateRenderer<any>>;
  let mockBackend: vi.Mocked<MedplumNotificationBackend<any>>;
  let adapter: MedplumNotificationAdapter<typeof mockTemplateRenderer, any>;
  let mockNotification: DatabaseNotification<any>;

  beforeEach(() => {
    medplumClient = new MockClient();

    mockTemplateRenderer = {
      render: vi.fn(),
      renderFromTemplateContent: vi.fn(),
    } as vi.Mocked<BaseEmailTemplateRenderer<any>>;

    mockBackend = {
      getUserEmailFromNotification: vi.fn(),
    } as unknown as vi.Mocked<MedplumNotificationBackend<any>>;

    adapter = new MedplumNotificationAdapter(medplumClient, mockTemplateRenderer, false);
    adapter.injectBackend(mockBackend);

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
      gitCommitSha: null,
      status: 'PENDING_SEND',
      sentAt: null,
      readAt: null,
      sendAfter: new Date(),
    };
  });

  it('should report that it supports attachments', () => {
    expect(adapter.supportsAttachments).toBe(true);
  });

  it('should send email with single attachment', async () => {
    const fileBuffer = Buffer.from('test file content');
    const mockFile: AttachmentFile = {
      read: vi.fn().mockResolvedValue(fileBuffer),
      stream: vi.fn(),
      url: vi.fn(),
      delete: vi.fn(),
    };

    const attachment: StoredAttachment = {
      id: 'att-1',
      fileId: 'file-1',
      filename: 'test.pdf',
      contentType: 'application/pdf',
      size: fileBuffer.length,
      checksum: 'abc123',
      description: 'Test file',
      file: mockFile,
      createdAt: new Date(),
      storageMetadata: { id: 'file-1' },
    };

    const notificationWithAttachments = {
      ...mockNotification,
      attachments: [attachment],
    } as any;

    const context = { foo: 'bar' };
    const renderedTemplate = {
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    };
    const userEmail = 'user@example.com';

    mockTemplateRenderer.render.mockResolvedValue(renderedTemplate);
    mockBackend.getUserEmailFromNotification.mockResolvedValue(userEmail);

    // Spy on sendEmail method
    const sendEmailSpy = vi.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(notificationWithAttachments, context);

    expect(mockFile.read).toHaveBeenCalled();
    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: userEmail,
      subject: renderedTemplate.subject,
      text: renderedTemplate.body,
      attachments: [
        {
          filename: 'test.pdf',
          content: fileBuffer.toString('base64'),
          contentType: 'application/pdf',
        },
      ],
    });
  });

  it('should send email with multiple attachments', async () => {
    const fileBuffer1 = Buffer.from('file 1 content');
    const fileBuffer2 = Buffer.from('file 2 content');

    const mockFile1: AttachmentFile = {
      read: vi.fn().mockResolvedValue(fileBuffer1),
      stream: vi.fn(),
      url: vi.fn(),
      delete: vi.fn(),
    };

    const mockFile2: AttachmentFile = {
      read: vi.fn().mockResolvedValue(fileBuffer2),
      stream: vi.fn(),
      url: vi.fn(),
      delete: vi.fn(),
    };

    const attachment1: StoredAttachment = {
      id: 'att-1',
      fileId: 'file-1',
      filename: 'document.pdf',
      contentType: 'application/pdf',
      size: fileBuffer1.length,
      checksum: 'abc123',
      description: 'PDF document',
      file: mockFile1,
      createdAt: new Date(),
      storageMetadata: { id: 'file-1' },
    };

    const attachment2: StoredAttachment = {
      id: 'att-2',
      fileId: 'file-2',
      filename: 'image.png',
      contentType: 'image/png',
      size: fileBuffer2.length,
      checksum: 'def456',
      description: 'Image file',
      file: mockFile2,
      createdAt: new Date(),
      storageMetadata: { id: 'file-2' },
    };

    const notificationWithAttachments = {
      ...mockNotification,
      attachments: [attachment1, attachment2],
    } as any;

    const context = { foo: 'bar' };
    const renderedTemplate = {
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    };
    const userEmail = 'user@example.com';

    mockTemplateRenderer.render.mockResolvedValue(renderedTemplate);
    mockBackend.getUserEmailFromNotification.mockResolvedValue(userEmail);

    // Spy on sendEmail method
    const sendEmailSpy = vi.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(notificationWithAttachments, context);

    expect(mockFile1.read).toHaveBeenCalled();
    expect(mockFile2.read).toHaveBeenCalled();
    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: userEmail,
      subject: renderedTemplate.subject,
      text: renderedTemplate.body,
      attachments: [
        {
          filename: 'document.pdf',
          content: fileBuffer1.toString('base64'),
          contentType: 'application/pdf',
        },
        {
          filename: 'image.png',
          content: fileBuffer2.toString('base64'),
          contentType: 'image/png',
        },
      ],
    });
  });

  it('should send email without attachments when attachments array is empty', async () => {
    const notificationWithoutAttachments = {
      ...mockNotification,
      attachments: [],
    } as any;

    const context = { foo: 'bar' };
    const renderedTemplate = {
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    };
    const userEmail = 'user@example.com';

    mockTemplateRenderer.render.mockResolvedValue(renderedTemplate);
    mockBackend.getUserEmailFromNotification.mockResolvedValue(userEmail);

    // Spy on sendEmail method
    const sendEmailSpy = vi.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(notificationWithoutAttachments, context);

    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: userEmail,
      subject: renderedTemplate.subject,
      text: renderedTemplate.body,
    });
  });

  it('should send email without attachments when attachments is undefined', async () => {
    const context = { foo: 'bar' };
    const renderedTemplate = {
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    };
    const userEmail = 'user@example.com';

    mockTemplateRenderer.render.mockResolvedValue(renderedTemplate);
    mockBackend.getUserEmailFromNotification.mockResolvedValue(userEmail);

    // Spy on sendEmail method
    const sendEmailSpy = vi.spyOn(medplumClient, 'sendEmail').mockResolvedValue({} as any);

    await adapter.send(mockNotification, context);

    expect(sendEmailSpy).toHaveBeenCalledWith({
      to: userEmail,
      subject: renderedTemplate.subject,
      text: renderedTemplate.body,
    });
  });

  it('should handle attachment read errors gracefully', async () => {
    const mockFile: AttachmentFile = {
      read: vi.fn().mockRejectedValue(new Error('Failed to read file')),
      stream: vi.fn(),
      url: vi.fn(),
      delete: vi.fn(),
    };

    const attachment: StoredAttachment = {
      id: 'att-1',
      fileId: 'file-1',
      filename: 'test.pdf',
      contentType: 'application/pdf',
      size: 1024,
      checksum: 'abc123',
      description: 'Test file',
      file: mockFile,
      createdAt: new Date(),
      storageMetadata: { id: 'file-1' },
    };

    const notificationWithAttachments = {
      ...mockNotification,
      attachments: [attachment],
    } as any;

    mockTemplateRenderer.render.mockResolvedValue({
      subject: 'Test Subject',
      body: '<p>Test Body</p>',
    });
    mockBackend.getUserEmailFromNotification.mockResolvedValue('user@example.com');

    await expect(adapter.send(notificationWithAttachments, {})).rejects.toThrow(
      'Failed to read file',
    );
  });
});
