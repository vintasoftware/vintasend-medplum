import { MockClient } from '@medplum/mock';
import type { Communication, Media, Binary } from '@medplum/fhirtypes';
import { MedplumNotificationBackend } from '../medplum-backend';
import type {
  AttachmentFile,
  NotificationAttachment,
} from 'vintasend/dist/types/attachment';
import type { NotificationType } from 'vintasend/dist/types/notification-type';

type TestContexts = {
  testContext: {
    generate: (params: { param1: string }) => Promise<{ value1: string }>;
  };
};

type MediaWithId = Media & { id: string };
type BinaryWithId = Binary & { id: string };

describe('MedplumNotificationBackend - Attachments', () => {
  let medplumClient: MockClient;
  let mockAttachmentManager: any;
  let backend: MedplumNotificationBackend<any>;

  const mockMedia: MediaWithId = {
    resourceType: 'Media',
    id: 'media-123',
    status: 'completed',
    meta: {
      tag: [{ code: 'attachment-file' }],
    },
    content: {
      contentType: 'application/pdf',
      url: 'Binary/binary-123',
      size: 1024,
      title: 'test.pdf',
    },
    identifier: [
      {
        system: 'http://vintasend.com/fhir/attachment-checksum',
        value: 'abc123',
      },
      {
        system: 'http://vintasend.com/fhir/binary-id',
        value: 'binary-123',
      },
    ],
    createdDateTime: '2026-01-15T00:00:00Z',
  };

  const mockBinary: BinaryWithId = {
    resourceType: 'Binary',
    id: 'binary-123',
    contentType: 'application/pdf',
    data: Buffer.from('test content').toString('base64'),
  };

  const createMockCommunication = (overrides = {}): Communication => ({
    resourceType: 'Communication',
    status: 'preparation',
    meta: {
      tag: [{ code: 'notification' }],
    },
    subject: {
      reference: 'Patient/user-123',
    },
    payload: [
      {
        contentString: 'Test Title',
        extension: [{ url: 'title', valueString: 'Test Title' }],
      },
      {
        contentString: '/path/to/template',
        extension: [{ url: 'bodyTemplate', valueString: '/path/to/template' }],
      },
    ],
    extension: [
      {
        url: 'http://vintasend.com/fhir/StructureDefinition/email-notification-subject',
        valueString: 'Test Subject',
      },
      {
        url: 'contextName',
        valueString: 'testContext',
      },
      {
        url: 'contextParameters',
        valueString: JSON.stringify({ param1: 'value1' }),
      },
      {
        url: 'notificationType',
        valueCode: 'EMAIL',
      },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    medplumClient = new MockClient();

    mockAttachmentManager = {
      reconstructAttachmentFile: jest.fn(),
      uploadFile: jest.fn(),
      deleteFile: jest.fn(),
      detectContentType: jest.fn(),
      calculateChecksum: jest.fn(),
      fileToBuffer: jest.fn(),
      getFile: jest.fn(),
    } as any;

    backend = new MedplumNotificationBackend(medplumClient, {
      emailNotificationSubjectExtensionUrl:
        'http://vintasend.com/fhir/StructureDefinition/email-notification-subject',
    });
    backend.injectAttachmentManager(mockAttachmentManager);
  });

  describe('getAttachmentFile', () => {
    it('should retrieve an attachment file by ID', async () => {
      // Create the media resource in the mock client's in-memory storage
      const createdMedia = await medplumClient.createResource(mockMedia);

      const result = await backend.getAttachmentFile(createdMedia.id as string);

      expect(result).toMatchObject({
        id: createdMedia.id,
        filename: 'test.pdf',
        contentType: 'application/pdf',
        size: 1024,
        checksum: 'abc123',
      });
    });

    it('should return null if file not found', async () => {
      const result = await backend.getAttachmentFile('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findAttachmentFileByChecksum', () => {
    it('should retrieve an attachment file by checksum', async () => {
      const createdMedia = await medplumClient.createResource(mockMedia);

      const result = await backend.findAttachmentFileByChecksum('abc123');

      expect(result).toMatchObject({
        id: createdMedia.id,
        filename: 'test.pdf',
        contentType: 'application/pdf',
        checksum: 'abc123',
      });
    });

    it('should return null if file with checksum is not found', async () => {
      const result = await backend.findAttachmentFileByChecksum('missing-checksum');

      expect(result).toBeNull();
    });
  });

  describe('deleteAttachmentFile', () => {
    it('should delete an attachment file and its storage', async () => {
      const createdMedia = await medplumClient.createResource(mockMedia);
      await medplumClient.createResource(mockBinary);

      await backend.deleteAttachmentFile(createdMedia.id as string);

      expect(mockAttachmentManager.deleteFile).toHaveBeenCalledWith(createdMedia.id);

      // Verify the media resource was deleted
      await expect(
        medplumClient.readResource('Media', createdMedia.id as string),
      ).rejects.toThrow();
    });

    it('should delete Binary resource if referenced', async () => {
      const createdMedia = await medplumClient.createResource(mockMedia);
      const createdBinary = await medplumClient.createResource(mockBinary);

      await backend.deleteAttachmentFile(createdMedia.id as string);

      // Verify the binary resource was deleted
      await expect(
        medplumClient.readResource('Binary', createdBinary.id as string),
      ).rejects.toThrow();
    });

    it('should return early if file not found', async () => {
      await backend.deleteAttachmentFile('nonexistent');

      expect(mockAttachmentManager.deleteFile).not.toHaveBeenCalled();
    });
  });

  describe('getOrphanedAttachmentFiles', () => {
    it('should retrieve attachment files not referenced by any notifications', async () => {
      // Create media resource
      await medplumClient.createResource(mockMedia);

      const result = await backend.getOrphanedAttachmentFiles();

      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('test.pdf');
    });

    it('should exclude files that are referenced by notifications', async () => {
      const createdMedia = await medplumClient.createResource(mockMedia);

      const mockCommunication = createMockCommunication({
        payload: [
          {
            contentAttachment: {
              url: `Media/${createdMedia.id}`,
            },
          },
        ],
      });

      // Create communication that references the media
      await medplumClient.createResource(mockCommunication);

      const result = await backend.getOrphanedAttachmentFiles();

      expect(result).toHaveLength(0);
    });
  });

  describe('getAttachments', () => {
    it('should retrieve all attachments for a notification in a single batch query', async () => {
      const mockAttachmentFileInterface: AttachmentFile = {
        read: jest.fn().mockResolvedValue(Buffer.from('test')),
        stream: jest.fn().mockResolvedValue(new ReadableStream()),
        url: jest.fn().mockResolvedValue('https://example.com/file'),
        delete: jest.fn().mockResolvedValue(undefined),
      };

      const createdMedia1 = await medplumClient.createResource({
        ...mockMedia,
        id: 'media-att-1',
      });

      const createdMedia2 = await medplumClient.createResource({
        ...mockMedia,
        id: 'media-att-2',
        content: { ...mockMedia.content, title: 'file2.pdf' },
      });

      const mockCommunication = createMockCommunication({
        payload: [
          {
            contentAttachment: {
              url: `Media/${createdMedia1.id}`,
              title: 'Test attachment 1',
              contentType: 'application/pdf',
            },
          },
          {
            contentAttachment: {
              url: `Media/${createdMedia2.id}`,
              title: 'Test attachment 2',
              contentType: 'application/pdf',
            },
          },
        ],
      });

      const createdCommunication = await medplumClient.createResource(mockCommunication);

      mockAttachmentManager.reconstructAttachmentFile.mockReturnValue(
        mockAttachmentFileInterface,
      );

      const result = await backend.getAttachments(createdCommunication.id as string);

      expect(result).toHaveLength(2);

      expect(result[0]).toMatchObject({
        fileId: createdMedia1.id,
        filename: 'test.pdf',
        description: 'Test attachment 1',
      });

      expect(result[1]).toMatchObject({
        fileId: createdMedia2.id,
        filename: 'file2.pdf',
        description: 'Test attachment 2',
      });
    });

    it('should return an empty array when a notification has no attachments', async () => {
      const mockCommunication = createMockCommunication();
      const createdCommunication = await medplumClient.createResource(mockCommunication);

      const result = await backend.getAttachments(createdCommunication.id as string);

      expect(result).toEqual([]);
      expect(mockAttachmentManager.reconstructAttachmentFile).not.toHaveBeenCalled();
    });

    it('should throw error if AttachmentManager not provided', async () => {
      const clientWithoutManager = new MockClient();
      const backendWithoutManager = new MedplumNotificationBackend(clientWithoutManager, {
        emailNotificationSubjectExtensionUrl:
          'http://vintasend.com/fhir/StructureDefinition/email-notification-subject',
      });

      const createdMedia = await clientWithoutManager.createResource(mockMedia);

      const mockCommunication = createMockCommunication({
        payload: [
          {
            contentAttachment: {
              url: `Media/${createdMedia.id}`,
            },
          },
        ],
      });
      const createdCommunication =
        await clientWithoutManager.createResource(mockCommunication);

      await expect(
        backendWithoutManager.getAttachments(createdCommunication.id as string),
      ).rejects.toThrow('AttachmentManager is required');
    });
  });

  describe('deleteNotificationAttachment', () => {
    it('should delete a notification attachment', async () => {
      const mockCommunication = createMockCommunication({
        payload: [
          {
            contentAttachment: {
              url: 'Media/media-123',
            },
          },
        ],
      });

      const createdCommunication = await medplumClient.createResource(mockCommunication);

      await backend.deleteNotificationAttachment(createdCommunication.id as string, 'media-123');

      const updatedCommunication = await medplumClient.readResource(
        'Communication',
        createdCommunication.id as string,
      );
      // Check that no attachments remain (payload might be [] or undefined depending on MockClient behavior)
      const attachments = updatedCommunication.payload?.filter(p => p.contentAttachment) || [];
      expect(attachments).toEqual([]);
    });

    it('should throw error if attachment does not belong to notification', async () => {
      const mockCommunication = createMockCommunication({
        payload: [
          {
            contentAttachment: {
              url: 'Media/media-123',
            },
          },
        ],
      });

      const createdCommunication = await medplumClient.createResource(mockCommunication);

      await expect(
        backend.deleteNotificationAttachment(createdCommunication.id as string, 'att-999'),
      ).rejects.toThrow(`Attachment att-999 not found for notification ${createdCommunication.id}`);
    });
  });

  describe('persistNotification with attachments', () => {
    it('should deduplicate inline file attachments by checksum when file already exists', async () => {
      const attachmentInput: NotificationAttachment = {
        file: Buffer.from('test content'),
        filename: 'test.pdf',
        contentType: 'application/pdf',
      };

      const input = {
        userId: 'user-123',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
        attachments: [attachmentInput],
      };

      // Create existing media resource
      await medplumClient.createResource(mockMedia);

      // Mock calculateChecksum to return same checksum as existing media
      (mockAttachmentManager.calculateChecksum as any).mockResolvedValue('abc123');

      const result = await backend.persistNotification(input);

      // Should NOT upload new file
      expect(mockAttachmentManager.uploadFile).not.toHaveBeenCalled();
      // Should have checked for existing file by checksum
      expect(mockAttachmentManager.calculateChecksum).toHaveBeenCalled();

      // Verify notification was created with the attachment
      expect(result.id).toBeDefined();
    });

    it('should batch checksum lookups for multiple attachments', async () => {
      await medplumClient.createResource({
        ...mockMedia,
        id: 'media-existing-1',
        identifier: [{ system: 'checksum', value: 'checksum1' }],
      });

      await medplumClient.createResource({
        ...mockMedia,
        id: 'media-existing-2',
        identifier: [{ system: 'checksum', value: 'checksum2' }],
      });

      const input = {
        userId: 'user-123',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
        attachments: [
          { file: Buffer.from('content1'), filename: 'file1.pdf', contentType: 'application/pdf' },
          { file: Buffer.from('content2'), filename: 'file2.pdf', contentType: 'application/pdf' },
          { file: Buffer.from('content3'), filename: 'file3.pdf', contentType: 'application/pdf' },
        ],
      };

      // Mock calculateChecksum to return different checksums
      let callCount = 0;
      (mockAttachmentManager.calculateChecksum as any).mockImplementation(() => {
        callCount++;
        return Promise.resolve(`checksum${callCount}`);
      });

      // Mock upload for the new file
      (mockAttachmentManager.uploadFile as any).mockResolvedValue({
        id: 'media-new-3',
        filename: 'file3.pdf',
        contentType: 'application/pdf',
        size: 8,
        checksum: 'checksum3',
        storageMetadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await backend.persistNotification(input);

      // Should have calculated all checksums
      expect(mockAttachmentManager.calculateChecksum).toHaveBeenCalledTimes(3);

      // Should only upload the one file that didn't exist
      expect(mockAttachmentManager.uploadFile).toHaveBeenCalledTimes(1);

      expect(result.id).toBeDefined();
    });

    it('should handle mixed file references and new uploads efficiently', async () => {
      const existingMedia1 = await medplumClient.createResource({
        ...mockMedia,
        id: 'media-ref-1',
      });

      await medplumClient.createResource({
        ...mockMedia,
        id: 'media-ref-2',
        identifier: [{ system: 'checksum', value: 'checksum-existing' }],
      });

      const input = {
        userId: 'user-123',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
        attachments: [
          { fileId: existingMedia1.id },  // File reference
          { file: Buffer.from('new content'), filename: 'new.pdf', contentType: 'application/pdf' },  // New upload
          { file: Buffer.from('existing content'), filename: 'existing.pdf', contentType: 'application/pdf' },  // Deduped
        ],
      };

      // Mock checksums
      let uploadCallCount = 0;
      (mockAttachmentManager.calculateChecksum as any).mockImplementation(() => {
        uploadCallCount++;
        return Promise.resolve(uploadCallCount === 1 ? 'checksum-new' : 'checksum-existing');
      });

      // Mock upload for the truly new file
      (mockAttachmentManager.uploadFile as any).mockResolvedValue({
        id: 'media-brand-new',
        filename: 'new.pdf',
        contentType: 'application/pdf',
        size: 11,
        checksum: 'checksum-new',
        storageMetadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await backend.persistNotification(input);

      // Should only upload 1 new file (the other is deduplicated)
      expect(mockAttachmentManager.uploadFile).toHaveBeenCalledTimes(1);

      expect(result.id).toBeDefined();
    });

    it('should create notification with inline file attachments', async () => {
      const fileBuffer = Buffer.from('test content');
      const attachmentInput: NotificationAttachment = {
        file: fileBuffer,
        filename: 'test.pdf',
        contentType: 'application/pdf',
        description: 'Test file',
      };

      const input = {
        userId: 'user-123',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
        attachments: [attachmentInput],
      };

      (mockAttachmentManager.calculateChecksum as any).mockResolvedValue('abc123');
      (mockAttachmentManager.uploadFile as any).mockResolvedValue({
        id: 'media-new-123',
        filename: 'test.pdf',
        contentType: 'application/pdf',
        size: fileBuffer.length,
        checksum: 'abc123',
        storageMetadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await backend.persistNotification(input);

      expect(mockAttachmentManager.uploadFile).toHaveBeenCalledWith(
        fileBuffer,
        'test.pdf',
        'application/pdf',
      );
      expect(result.id).toBeDefined();

      // Verify the communication was created with the attachment
      const communication = await medplumClient.readResource('Communication', result.id);
      expect(communication.payload).toBeDefined();
      expect(communication.payload?.length).toBeGreaterThan(1); // body template + attachment
      expect(communication.payload?.some(p => p.contentAttachment?.contentType === 'application/pdf')).toBe(true);
    });

    it('should create notification with file reference attachments', async () => {
      const createdMedia = await medplumClient.createResource(mockMedia);

      const attachmentInput: NotificationAttachment = {
        fileId: createdMedia.id as string,
      };

      const input = {
        userId: 'user-123',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
        attachments: [attachmentInput],
      };

      const result = await backend.persistNotification(input);

      expect(result.id).toBeDefined();

      // Verify the communication was created with the attachment reference
      const communication = await medplumClient.readResource('Communication', result.id);
      expect(communication.payload).toBeDefined();
      expect(communication.payload?.some(
        p => p.contentAttachment?.url?.includes(createdMedia.id)
      )).toBe(true);
    });

    it('should fail when referenced attachment file is missing', async () => {
      const attachmentInput: NotificationAttachment = {
        fileId: 'nonexistent-media-id',
      };

      const input = {
        userId: 'user-123',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
        attachments: [attachmentInput],
      };

      await expect(backend.persistNotification(input)).rejects.toThrow();
    });

    it('should create notification without attachments', async () => {
      const input = {
        userId: 'user-123',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
      };

      const result = await backend.persistNotification(input);

      expect(result.id).toBeDefined();
      expect(mockAttachmentManager.uploadFile).not.toHaveBeenCalled();
    });

    it('should throw error when attachments provided but no AttachmentManager', async () => {
      const backendWithoutManager = new MedplumNotificationBackend(new MockClient(), {
        emailNotificationSubjectExtensionUrl:
          'http://vintasend.com/fhir/StructureDefinition/email-notification-subject',
      });

      const input = {
        userId: 'user-123',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
        attachments: [{ file: Buffer.from('test'), filename: 'test.txt' }],
      };

      await expect(backendWithoutManager.persistNotification(input)).rejects.toThrow(
        'AttachmentManager is required',
      );
    });
  });

  describe('persistOneOffNotification with attachments', () => {
    it('should create one-off notification with attachments using batch optimization', async () => {
      const fileBuffer = Buffer.from('test content');
      const attachmentInput: NotificationAttachment = {
        file: fileBuffer,
        filename: 'test.pdf',
        contentType: 'application/pdf',
        description: 'Test file',
      };

      const input = {
        emailOrPhone: 'oneoff@example.com',
        firstName: 'John',
        lastName: 'Doe',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
        attachments: [attachmentInput],
      };

      (mockAttachmentManager.calculateChecksum as any).mockResolvedValue('abc123');

      (mockAttachmentManager.uploadFile as any).mockResolvedValue({
        id: 'media-one-off-123',
        filename: 'test.pdf',
        contentType: 'application/pdf',
        size: fileBuffer.length,
        checksum: 'abc123',
        storageMetadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await backend.persistOneOffNotification(input);

      expect(mockAttachmentManager.uploadFile).toHaveBeenCalled();
      expect(result.id).toBeDefined();

      // Verify the communication was created with the attachment
      const communication = await medplumClient.readResource('Communication', result.id);
      expect(communication.payload).toBeDefined();
      expect(communication.payload?.some(p => p.contentAttachment?.contentType === 'application/pdf')).toBe(true);
    });

    it('should create one-off notification without attachments', async () => {
      const input = {
        emailOrPhone: 'oneoff@example.com',
        firstName: 'Jane',
        lastName: 'Smith',
        notificationType: 'EMAIL' as NotificationType,
        bodyTemplate: 'Test Body',
        contextName: 'testContext' as keyof TestContexts,
        contextParameters: { param1: 'value1' },
        title: 'Test Title',
        subjectTemplate: 'Test Subject',
        extraParams: null,
        sendAfter: null,
      };

      const result = await backend.persistOneOffNotification(input);

      expect(result.id).toBeDefined();
      expect(mockAttachmentManager.uploadFile).not.toHaveBeenCalled();
    });
  });
});
