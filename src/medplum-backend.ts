import { MedplumClient } from '@medplum/core';
import { Attachment, Communication, Media } from '@medplum/fhirtypes';
import type { BaseAttachmentManager } from 'vintasend/dist/services/attachment-manager/base-attachment-manager';
import type { BaseLogger } from 'vintasend/dist/services/loggers/base-logger';
import type { BaseNotificationBackend } from 'vintasend/dist/services/notification-backends/base-notification-backend';
import type {
  AttachmentFile,
  AttachmentFileRecord,
  FileAttachment,
  NotificationAttachment,
  StoredAttachment,
} from 'vintasend/dist/types/attachment';
import type { InputJsonValue } from 'vintasend/dist/types/json-values';
import type {
  AnyDatabaseNotification,
  DatabaseNotification,
  NotificationInput,
} from 'vintasend/dist/types/notification';
import type { BaseNotificationTypeConfig } from 'vintasend/dist/types/notification-type-config';
import type {
  DatabaseOneOffNotification,
  OneOffNotificationInput,
} from 'vintasend/dist/types/one-off-notification';

type MedplumNotificationBackendOptions = {
  emailNotificationSubjectExtensionUrl?: string;
};


export class MedplumNotificationBackend<Config extends BaseNotificationTypeConfig> implements BaseNotificationBackend<Config> {
  private attachmentManager?: BaseAttachmentManager;
  private logger?: BaseLogger;

  constructor(private medplum: MedplumClient, private options: MedplumNotificationBackendOptions = {
    emailNotificationSubjectExtensionUrl: 'http://vintasend.com/fhir/StructureDefinition/email-notification-subject',
  }) {}

  /**
   * Inject attachment manager (called by VintaSend when both service and backend exist)
   */
  injectAttachmentManager(manager: BaseAttachmentManager): void {
    this.attachmentManager = manager;
  }

  /**
   * Inject logger for debugging and monitoring
   */
  injectLogger(logger: BaseLogger): void {
    this.logger = logger;
  }

  /**
   * Get attachment manager with null check
   */
  private getAttachmentManager(): BaseAttachmentManager {
    if (!this.attachmentManager) {
      throw new Error('AttachmentManager is required');
    }
    return this.attachmentManager;
  }

  private mapToDatabaseNotification(communication: Communication): AnyDatabaseNotification<Config> {
    const notificationId = communication.id as Config['NotificationIdType'];
    const referenceString = communication.recipient?.[0]?.reference as Config['UserIdType'];

    // Extract subjectTemplate from payload extension
    const subjectTemplateExtension = communication.payload?.[0]?.extension?.find(
      (ext) => ext.url === this.options.emailNotificationSubjectExtensionUrl
    );
    const subjectTemplate = subjectTemplateExtension?.valueString || null;

    // Extract one-off notification fields from extensions
    const emailOrPhoneExtension = communication.extension?.find(
      (ext) => ext.url === 'http://vintasend.com/fhir/StructureDefinition/emailOrPhone'
    );
    const firstNameExtension = communication.extension?.find(
      (ext) => ext.url === 'http://vintasend.com/fhir/StructureDefinition/firstName'
    );
    const lastNameExtension = communication.extension?.find(
      (ext) => ext.url === 'http://vintasend.com/fhir/StructureDefinition/lastName'
    );

    const emailOrPhone = emailOrPhoneExtension?.valueString;
    const firstName = firstNameExtension?.valueString;
    const lastName = lastNameExtension?.valueString;

    const baseNotification = {
      id: notificationId,
      notificationType: communication.meta?.tag?.[2]?.code as any,
      title: communication.topic?.text || null,
      contextName: communication.meta?.tag?.[1]?.code as any,
      contextParameters: JSON.parse(communication.note?.[0]?.text || '{}'),
      sendAfter: communication.sent ? new Date(communication.sent) : null,
      bodyTemplate: communication.payload?.[0]?.contentString || '',
      subjectTemplate: subjectTemplate,
      extraParams: {},
      status:
        communication.status === 'completed' ? 'SENT' : communication.status === 'stopped' ? 'FAILED' : 'PENDING_SEND',
      contextUsed: null,
      adapterUsed: null,
      sentAt: communication.status === 'completed' ? new Date(communication.sent || new Date()) : null,
      readAt: null,
      createdAt: new Date(communication.meta?.lastUpdated || new Date()),
      updatedAt: new Date(communication.meta?.lastUpdated || new Date()),
    };

    // Check if this is a one-off notification
    if (emailOrPhone && firstName && lastName) {
      return {
        ...baseNotification,
        emailOrPhone,
        firstName,
        lastName,
      } as DatabaseOneOffNotification<Config>;
    }

    // Regular notification
    return {
      ...baseNotification,
      userId: referenceString,
    } as DatabaseNotification<Config>;
  }

  async getAllPendingNotifications(): Promise<AnyDatabaseNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', {
      status: 'in-progress',
      _tag: 'notification',
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  async getPendingNotifications(page: number, pageSize: number): Promise<AnyDatabaseNotification<Config>[]> {
    const now = new Date().toISOString();
    const communications = await this.medplum.searchResources('Communication', {
      status: 'in-progress',
      _tag: 'notification',
      'sent:le': now,
      _count: pageSize.toString(),
      _offset: (page * pageSize).toString(),
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  async getAllFutureNotifications(): Promise<AnyDatabaseNotification<Config>[]> {
    const now = new Date().toISOString();
    const communications = await this.medplum.searchResources('Communication', {
      status: 'in-progress',
      _tag: 'notification',
      'sent:gt': now,
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  async getFutureNotifications(page: number, pageSize: number): Promise<AnyDatabaseNotification<Config>[]> {
    const now = new Date().toISOString();
    const communications = await this.medplum.searchResources('Communication', {
      status: 'in-progress',
      _tag: 'notification',
      'sent:gt': now,
      _count: pageSize.toString(),
      _offset: (page * pageSize).toString(),
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  async getAllFutureNotificationsFromUser(
    referenceString: Config['UserIdType']
  ): Promise<DatabaseNotification<Config>[]> {
    const now = new Date().toISOString();
    const communications = await this.medplum.searchResources('Communication', {
      status: 'in-progress',
      _tag: 'notification',
      'sent:gt': now,
      recipient: referenceString,
    });
    return communications
      .map((comm) => this.mapToDatabaseNotification(comm))
      .filter((n): n is DatabaseNotification<Config> => 'userId' in n);
  }

  async getFutureNotificationsFromUser(
    referenceString: Config['UserIdType'],
    page: number,
    pageSize: number
  ): Promise<DatabaseNotification<Config>[]> {
    const now = new Date().toISOString();
    const communications = await this.medplum.searchResources('Communication', {
      status: 'in-progress',
      _tag: 'notification',
      'sent:gt': now,
      recipient: referenceString,
      _count: pageSize.toString(),
      _offset: (page * pageSize).toString(),
    });
    return communications
      .map((comm) => this.mapToDatabaseNotification(comm))
      .filter((n): n is DatabaseNotification<Config> => 'userId' in n);
  }

  async persistNotification(notification: NotificationInput<Config>): Promise<DatabaseNotification<Config>> {
    // Build base payload with body template
    const payload: Communication['payload'] = notification.bodyTemplate
      ? [
          {
            contentString: notification.bodyTemplate,
            extension: notification.subjectTemplate && this.options.emailNotificationSubjectExtensionUrl
              ? [{ url: this.options.emailNotificationSubjectExtensionUrl, valueString: notification.subjectTemplate }]
              : undefined,
          },
        ]
      : [];

    // Handle attachments if present
    if (notification.attachments && notification.attachments.length > 0) {
      const attachmentPayload = await this.processAttachments(notification.attachments);
      if (attachmentPayload) {
        payload.push(...attachmentPayload);
      }
    }

    const communication: Communication = {
      resourceType: 'Communication',
      status: 'in-progress',
      sent: notification.sendAfter?.toISOString(),
      topic: { text: notification.title || undefined },
      payload,
      recipient: [{ reference: notification.userId as string }],
      note: [{ text: JSON.stringify(notification.contextParameters) }],
      meta: {
        tag: [
          { code: 'notification' },
          { code: notification.contextName as string },
          { code: notification.notificationType as string },
        ],
      },
    };

    const created = await this.medplum.createResource(communication);
    const mappedNotification = this.mapToDatabaseNotification(created) as DatabaseNotification<Config>;

    // Load and attach attachments to the returned notification if they were provided
    if (notification.attachments && notification.attachments.length > 0) {
      this.logger?.info(`[MedplumBackend] Loading ${notification.attachments.length} attachments for notification ${mappedNotification.id}`);
      mappedNotification.attachments = await this.getAttachments(mappedNotification.id);
      this.logger?.info(`[MedplumBackend] Loaded ${mappedNotification.attachments?.length || 0} attachments for notification ${mappedNotification.id}`);
    }

    return mappedNotification;
  }

  async persistNotificationUpdate(
    notificationId: Config['NotificationIdType'],
    notification: Partial<Omit<DatabaseNotification<Config>, 'id'>>,
  ): Promise<DatabaseNotification<Config>> {
    const existing = await this.medplum.readResource('Communication', notificationId as string);

    const updated: Communication = {
      ...existing,
      ...(notification.status === 'SENT' && { status: 'completed' }),
      ...(notification.status === 'FAILED' && { status: 'stopped' }),
      meta: {
        ...existing.meta,
        lastUpdated: new Date().toISOString(),
      },
    };

    const result = await this.medplum.updateResource(updated);
    return this.mapToDatabaseNotification(result) as DatabaseNotification<Config>;
  }

  async getAllNotifications(): Promise<AnyDatabaseNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', {
      _tag: 'notification',
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  async getNotifications(page: number, pageSize: number): Promise<AnyDatabaseNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', {
      _tag: 'notification',
      _count: pageSize.toString(),
      _offset: (page * pageSize).toString(),
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  async bulkPersistNotifications(
    notifications: Omit<NotificationInput<Config>, 'id'>[]
  ): Promise<Config['NotificationIdType'][]> {
    const ids: Config['NotificationIdType'][] = [];

    for (const notification of notifications) {
      const communication: Communication = {
        resourceType: 'Communication',
        status: 'in-progress',
        sent: notification.sendAfter?.toISOString(),
        topic: { text: notification.title || undefined },
        payload: notification.bodyTemplate
          ? [
              {
                contentString: notification.bodyTemplate,
                extension: notification.subjectTemplate && this.options.emailNotificationSubjectExtensionUrl
                  ? [{ url: this.options.emailNotificationSubjectExtensionUrl, valueString: notification.subjectTemplate }]
                  : undefined,
              },
            ]
          : [],
        recipient: [{ reference: notification.userId as string }],
        note: [{ text: JSON.stringify(notification.contextParameters) }],
        meta: {
          tag: [
            { code: 'notification' },
            { code: notification.contextName as string },
            { code: notification.notificationType as string },
          ],
        },
      };

      const created = await this.medplum.createResource(communication);
      ids.push(created.id as Config['NotificationIdType']);
    }

    return ids;
  }

  async markAsSent(
    notificationId: Config['NotificationIdType'],
    checkIsPending = true
  ): Promise<AnyDatabaseNotification<Config>> {
    const notification = await this.getNotification(notificationId, false);
    if (checkIsPending && notification?.status !== 'PENDING_SEND') {
      throw new Error('Notification is not pending');
    }
    // Use internal update that returns AnyDatabaseNotification
    const existing = await this.medplum.readResource('Communication', notificationId as string);
    const updated: Communication = {
      ...existing,
      status: 'completed',
      meta: {
        ...existing.meta,
        lastUpdated: new Date().toISOString(),
      },
    };
    const result = await this.medplum.updateResource(updated);
    return this.mapToDatabaseNotification(result);
  }

  async markAsFailed(
    notificationId: Config['NotificationIdType'],
    checkIsPending = true
  ): Promise<AnyDatabaseNotification<Config>> {
    const notification = await this.getNotification(notificationId, false);
    if (checkIsPending && notification?.status !== 'PENDING_SEND') {
      throw new Error('Notification is not pending');
    }
    // Use internal update that returns AnyDatabaseNotification
    const existing = await this.medplum.readResource('Communication', notificationId as string);
    const updated: Communication = {
      ...existing,
      status: 'stopped',
      meta: {
        ...existing.meta,
        lastUpdated: new Date().toISOString(),
      },
    };
    const result = await this.medplum.updateResource(updated);
    return this.mapToDatabaseNotification(result);
  }

  async markAsRead(
    notificationId: Config['NotificationIdType'],
    checkIsSent = true
  ): Promise<DatabaseNotification<Config>> {
    const notification = await this.getNotification(notificationId, false);
    if (checkIsSent && notification?.status !== 'SENT') {
      throw new Error('Notification is not sent');
    }
    // Ensure it's a regular notification (not one-off)
    if (notification && !('userId' in notification)) {
      throw new Error('Cannot mark one-off notification as read');
    }
    return this.persistNotificationUpdate(notificationId, { readAt: new Date() });
  }

  async cancelNotification(notificationId: Config['NotificationIdType']): Promise<void> {
    await this.medplum.deleteResource('Communication', notificationId as string);
  }

  async getNotification(
    notificationId: Config['NotificationIdType'],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _forUpdate: boolean
  ): Promise<AnyDatabaseNotification<Config> | null> {
    try {
      const communication = await this.medplum.readResource('Communication', notificationId as string);
      return this.mapToDatabaseNotification(communication);
    } catch {
      return null;
    }
  }

  async filterAllInAppUnreadNotifications(
    refenrenceString: Config['UserIdType']
  ): Promise<DatabaseNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', {
      status: 'completed',
      _tag: 'notification,in-app',
      recipient: refenrenceString,
    });
    return communications
      .map((comm) => this.mapToDatabaseNotification(comm))
      .filter((notif): notif is DatabaseNotification<Config> => 'userId' in notif && !notif.readAt);
  }

  async filterInAppUnreadNotifications(
    refenrenceString: Config['UserIdType'],
    page: number,
    pageSize: number
  ): Promise<DatabaseNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', {
      status: 'completed',
      _tag: 'notification,in-app',
      recipient: refenrenceString,
      _count: pageSize.toString(),
      _offset: (page * pageSize).toString(),
    });
    return communications
      .map((comm) => this.mapToDatabaseNotification(comm))
      .filter((notif): notif is DatabaseNotification<Config> => 'userId' in notif && !notif.readAt);
  }

  async getUserEmailFromNotification(notificationId: Config['NotificationIdType']): Promise<string | undefined> {
    try {
      const communication = await this.medplum.readResource('Communication', notificationId as string);
      const practitionerRef = communication.recipient?.[0]?.reference;

      if (!practitionerRef) {
        return undefined;
      }

      const [resourceType, id] = practitionerRef.split('/') as ['Patient' | 'Practitioner', string];

      if (!id) {
        // eslint-disable-next-line no-console
        console.error('[getUserEmailFromNotification] Invalid reference format - no ID found');
        return undefined;
      }

      const resource = await this.medplum.readResource(resourceType, id);
      return resource.telecom?.find((t) => t.system === 'email')?.value;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[getUserEmailFromNotification] Error fetching user email:', error);
      return undefined;
    }
  }

  async storeContextUsed(notificationId: Config['NotificationIdType'], context: InputJsonValue): Promise<void> {
    const communication = await this.medplum.readResource('Communication', notificationId as string);
    const updated: Communication = {
      ...communication,
      note: [{ text: JSON.stringify(context) }],
    };
    await this.medplum.updateResource(updated);
  }

  /* One-off notification methods */

  async persistOneOffNotification(
    notification: Omit<OneOffNotificationInput<Config>, 'id'>,
  ): Promise<DatabaseOneOffNotification<Config>> {
    // Build base payload with body template
    const payload: Communication['payload'] = notification.bodyTemplate
      ? [
          {
            contentString: notification.bodyTemplate,
            extension: notification.subjectTemplate && this.options.emailNotificationSubjectExtensionUrl
              ? [{ url: this.options.emailNotificationSubjectExtensionUrl, valueString: notification.subjectTemplate }]
              : undefined,
          },
        ]
      : [];

    // Handle attachments if present
    if (notification.attachments && notification.attachments.length > 0) {
      const attachmentPayload = await this.processAttachments(notification.attachments);
      if (attachmentPayload) {
        payload.push(...attachmentPayload);
      }
    }

    const communication: Communication = {
      resourceType: 'Communication',
      status: 'in-progress',
      sent: notification.sendAfter?.toISOString(),
      topic: { text: notification.title || undefined },
      payload,
      note: [{ text: JSON.stringify(notification.contextParameters) }],
      extension: [
        { url: 'http://vintasend.com/fhir/StructureDefinition/emailOrPhone', valueString: notification.emailOrPhone },
        { url: 'http://vintasend.com/fhir/StructureDefinition/firstName', valueString: notification.firstName },
        { url: 'http://vintasend.com/fhir/StructureDefinition/lastName', valueString: notification.lastName },
      ],
      meta: {
        tag: [
          { code: 'notification' },
          { code: notification.contextName as string },
          { code: notification.notificationType as string },
          { code: 'one-off' },
        ],
      },
    };

    const created = await this.medplum.createResource(communication);
    const mappedNotification = this.mapToDatabaseNotification(created) as DatabaseOneOffNotification<Config>;

    // Load and attach attachments to the returned notification if they were provided
    if (notification.attachments && notification.attachments.length > 0) {
      mappedNotification.attachments = await this.getAttachments(mappedNotification.id);
    }

    return mappedNotification;
  }

  async persistOneOffNotificationUpdate(
    notificationId: Config['NotificationIdType'],
    notification: Partial<Omit<DatabaseOneOffNotification<Config>, 'id'>>,
  ): Promise<DatabaseOneOffNotification<Config>> {
    const existing = await this.medplum.readResource('Communication', notificationId as string);

    const updated: Communication = {
      ...existing,
      ...(notification.status === 'SENT' && { status: 'completed' }),
      ...(notification.status === 'FAILED' && { status: 'stopped' }),
      meta: {
        ...existing.meta,
        lastUpdated: new Date().toISOString(),
      },
    };

    const result = await this.medplum.updateResource(updated);
    return this.mapToDatabaseNotification(result) as DatabaseOneOffNotification<Config>;
  }

  async getOneOffNotification(
    notificationId: Config['NotificationIdType'],
    forUpdate: boolean,
  ): Promise<DatabaseOneOffNotification<Config> | null> {
    const notification = await this.getNotification(notificationId, forUpdate);
    if (!notification) return null;
    // Check if it's a one-off notification
    if ('emailOrPhone' in notification) {
      return notification as DatabaseOneOffNotification<Config>;
    }
    return null;
  }

  async getAllOneOffNotifications(): Promise<DatabaseOneOffNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', {
      _tag: 'notification,one-off',
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm) as DatabaseOneOffNotification<Config>);
  }

  async getOneOffNotifications(
    page: number,
    pageSize: number,
  ): Promise<DatabaseOneOffNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', {
      _tag: 'notification,one-off',
      _count: pageSize.toString(),
      _offset: (page * pageSize).toString(),
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm) as DatabaseOneOffNotification<Config>);
  }

  /* Attachment management methods */

  /**
   * Helper: Convert FileAttachment to Buffer
   */
  private async fileToBuffer(file: FileAttachment, filename: string): Promise<Buffer> {
    if (Buffer.isBuffer(file)) {
      return file;
    }

    if (typeof file === 'string') {
      // File path - read from filesystem
      const fs = await import('node:fs/promises');
      return await fs.readFile(file);
    }

    // ReadableStream or Readable
    const chunks: Buffer[] = [];

    if ('getReader' in file) {
      // Web ReadableStream
      const reader = file.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      // Node.js Readable
      for await (const chunk of file) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }

    return Buffer.concat(chunks);
  }

  /**
   * Helper: Convert FHIR Media resource to AttachmentFileRecord
   * Extracts metadata directly from the Media resource using the same logic as MedplumAttachmentManager.getFile
   */
  private async mediaToAttachmentFileRecord(media: Media): Promise<AttachmentFileRecord | null> {
    if (!media.id) {
      throw new Error('Invalid Media resource: missing id');
    }

    if (!media.content) {
      return null;
    }

    // Extract Binary ID from identifier
    const binaryIdIdentifier = media.identifier?.find(
      (id) => id.system === 'http://vintasend.com/fhir/binary-id'
    );
    let binaryId = binaryIdIdentifier?.value;

    // If binaryId not found in identifier, try to extract from content.url
    if (!binaryId && media.content.url) {
      const match = media.content.url.match(/Binary\/([^/]+)/);
      if (match) {
        binaryId = match[1];
      }
    }

    // Extract checksum from identifier
    const checksumIdentifier = media.identifier?.find(
      (id) => id.system === 'http://vintasend.com/fhir/attachment-checksum'
    );
    const checksum = checksumIdentifier?.value || '';

    return {
      id: media.id,
      filename: media.content.title || 'untitled',
      contentType: media.content.contentType || 'application/octet-stream',
      size: media.content.size || 0,
      checksum,
      storageMetadata: {
        url: media.content.url,
        binaryId: binaryId,
        creation: media.content.creation,
      },
      createdAt: media.meta?.lastUpdated ? new Date(media.meta.lastUpdated) : new Date(),
      updatedAt: media.meta?.lastUpdated ? new Date(media.meta.lastUpdated) : new Date(),
    };
  }

  /**
   * Helper: Create FHIR Attachment from file record
   */
  private async createFhirAttachment(fileRecord: AttachmentFileRecord): Promise<Attachment> {
    const url = fileRecord.storageMetadata?.url as string | undefined;
    return {
      contentType: fileRecord.contentType,
      url: url,
      size: fileRecord.size,
      title: fileRecord.filename,
      creation: fileRecord.createdAt.toISOString(),
    };
  }

  /**
   * Helper: Create MedplumAttachmentFile from storage metadata
   */
  private createMedplumAttachmentFile(fileRecord: AttachmentFileRecord): AttachmentFile {
    const manager = this.getAttachmentManager();
    return manager.reconstructAttachmentFile(fileRecord.storageMetadata);
  }

  async getAttachmentFile(fileId: string): Promise<AttachmentFileRecord | null> {
    try {
      const media = await this.medplum.readResource('Media', fileId);
      return this.mediaToAttachmentFileRecord(media);
    } catch {
      return null;
    }
  }

  async findAttachmentFileByChecksum(checksum: string): Promise<AttachmentFileRecord | null> {
    try {
      const results = await this.medplum.searchResources(
        'Media',
        `identifier=${checksum}&_tag=attachment-file`
      );

      if (results.length === 0) {
        return null;
      }

      const fileRecord = await this.mediaToAttachmentFileRecord(results[0]);
      return fileRecord;
    } catch {
      return null;
    }
  }

  /**
   * Find multiple attachment files by their checksums in a single query
   */
  private async findAttachmentFilesByChecksums(checksums: string[]): Promise<Map<string, AttachmentFileRecord>> {
    if (checksums.length === 0) {
      return new Map();
    }

    try {
      // Build query with all checksums
      const identifierQuery = checksums.join(',');
      const results = await this.medplum.searchResources(
        'Media',
        `identifier=${identifierQuery}&_tag=attachment-file`
      );

      // Map results by checksum
      const filesByChecksum = new Map<string, AttachmentFileRecord>();
      for (const media of results) {
        const checksum = media.identifier?.[0]?.value;
        if (checksum) {
          const fileRecord = await this.mediaToAttachmentFileRecord(media);
          if (fileRecord) {
            filesByChecksum.set(checksum, fileRecord);
          }
        }
      }

      return filesByChecksum;
    } catch {
      return new Map();
    }
  }

  /**
   * Helper: Process attachments and return payload items
   * Optimizes by batching checksum lookups
   */
  private async processAttachments(
    attachments: NotificationAttachment[]
  ): Promise<Communication['payload']> {
    const manager = this.getAttachmentManager();
    const payload: Communication['payload'] = [];

    // Separate attachments by type: file references vs new uploads
    const fileReferences: Array<{ index: number; fileId: string; description?: string }> = [];
    const newUploads: Array<{
      index: number;
      file: FileAttachment;
      filename: string;
      contentType: string;
      description?: string;
    }> = [];

    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      if ('fileId' in attachment) {
        fileReferences.push({
          index: i,
          fileId: attachment.fileId,
          description: attachment.description
        });
      } else if ('file' in attachment) {
        newUploads.push({
          index: i,
          file: attachment.file,
          filename: attachment.filename,
          contentType: attachment.contentType || 'application/octet-stream',
          description: attachment.description
        });
      }
    }

    // Fetch all referenced files in parallel
    const referencedFiles = await Promise.all(
      fileReferences.map(async ({ fileId }) => ({
        fileId,
        record: await this.getAttachmentFile(fileId)
      }))
    );

    // Calculate checksums for new uploads
    const uploadsWithChecksums = await Promise.all(
      newUploads.map(async (upload) => {
        const buffer = await this.fileToBuffer(upload.file, upload.filename);
        const checksum = await manager.calculateChecksum(buffer);
        return { ...upload, buffer, checksum };
      })
    );

    // Batch lookup existing files by checksums
    const checksums = uploadsWithChecksums.map(u => u.checksum);
    const existingFilesByChecksum = await this.findAttachmentFilesByChecksums(checksums);

    // Process file references
    const fileRecords: Array<{ index: number; record: AttachmentFileRecord; description?: string }> = [];

    for (let i = 0; i < fileReferences.length; i++) {
      const { index, description } = fileReferences[i];
      const { record } = referencedFiles[i];
      if (!record) {
        throw new Error(`Attachment file not found: ${fileReferences[i].fileId}`);
      }
      fileRecords.push({
        index,
        record,
        description
      });
    }

    // Process new uploads (using cached checksum lookups or uploading)
    for (const upload of uploadsWithChecksums) {
      let fileRecord: AttachmentFileRecord;

      const existingFile = existingFilesByChecksum.get(upload.checksum);
      if (existingFile) {
        // File already exists, reuse it
        fileRecord = existingFile;
      } else {
        // Upload new file
        fileRecord = await manager.uploadFile(
          upload.file,
          upload.filename,
          upload.contentType
        );
      }

      fileRecords.push({
        index: upload.index,
        record: fileRecord,
        description: upload.description
      });
    }

    // Sort by original index and build payload
    fileRecords.sort((a, b) => a.index - b.index);

    for (const { record, description } of fileRecords) {
      const fhirAttachment = await this.createFhirAttachment(record);
      payload.push({
        contentAttachment: {
          ...fhirAttachment,
          url: `Media/${record.id}`,
          title: description || record.filename,
        },
      });
    }

    return payload;
  }

  async deleteAttachmentFile(fileId: string): Promise<void> {
    // Check if file exists first
    const fileRecord = await this.getAttachmentFile(fileId);
    if (!fileRecord) {
      // File not found, return early
      return;
    }

    // Check if file is still referenced by any notifications
    const communications = await this.medplum.searchResources('Communication', {
      _tag: 'notification',
    });

    const isReferenced = communications.some((comm) =>
      comm.payload?.some((p) => p.contentAttachment?.url?.includes(fileId))
    );

    if (isReferenced) {
      throw new Error('Cannot delete attachment file: still referenced by notifications');
    }

    // Delete from storage backend
    if (fileRecord && this.attachmentManager) {
      await this.attachmentManager.deleteFile(fileId);
    }

    // Delete Binary resource if it exists
    if (fileRecord.storageMetadata?.url) {
      const binaryId = (fileRecord.storageMetadata.url as string).replace('Binary/', '');
      try {
        await this.medplum.deleteResource('Binary', binaryId);
      } catch {
        // Binary may not exist or already deleted
      }
    }

    // Delete Media resource
    await this.medplum.deleteResource('Media', fileId);
  }

  async getOrphanedAttachmentFiles(): Promise<AttachmentFileRecord[]> {
    // Get all Media resources tagged as attachment-files
    const allMedia = await this.medplum.searchResources('Media', {
      _tag: 'attachment-file',
    });

    // Get all notifications
    const communications = await this.medplum.searchResources('Communication', {
      _tag: 'notification',
    });

    // Build set of referenced file IDs
    const referencedIds = new Set<string>();
    for (const comm of communications) {
      for (const payload of comm.payload || []) {
        const url = payload.contentAttachment?.url;
        if (url) {
          // Extract Media ID from URL (assuming format like Media/{id})
          const match = url.match(/Media\/([^/]+)/);
          if (match) referencedIds.add(match[1]);
        }
      }
    }

    // Filter orphaned media
    const orphaned = allMedia.filter((media) => media.id && !referencedIds.has(media.id));
    const fileRecords = await Promise.all(
      orphaned.map((media) => this.mediaToAttachmentFileRecord(media))
    );
    return fileRecords.filter((record): record is AttachmentFileRecord => record !== null);
  }

  async getAttachments(notificationId: Config['NotificationIdType']): Promise<StoredAttachment[]> {
    this.getAttachmentManager(); // Ensure attachment manager is injected
    try {
      const communication = await this.medplum.readResource('Communication', notificationId as string);
      const attachments: StoredAttachment[] = [];

      this.logger?.info(`[MedplumBackend.getAttachments] Fetching attachments for notification ${notificationId}`);
      this.logger?.info(`[MedplumBackend.getAttachments] Communication has ${communication.payload?.length || 0} payload items`);

      // Extract all Media IDs from payload
      const mediaIds: string[] = [];
      const payloadMap = new Map<string, { description?: string }>();

      for (const payload of communication.payload || []) {
        this.logger?.info(`[MedplumBackend.getAttachments] Payload item: ${JSON.stringify(payload, null, 2)}`);
        const attachment = payload.contentAttachment;
        if (!attachment || !attachment.url) continue;

        this.logger?.info(`[MedplumBackend.getAttachments] Found attachment URL: ${attachment.url}`);

        // Extract Media ID from URL
        const match = attachment.url.match(/Media\/([^/]+)/);
        if (!match) continue;

        const mediaId = match[1];
        this.logger?.info(`[MedplumBackend.getAttachments] Extracted Media ID: ${mediaId}`);
        mediaIds.push(mediaId);
        payloadMap.set(mediaId, { description: attachment.title });
      }

      this.logger?.info(`[MedplumBackend.getAttachments] Found ${mediaIds.length} media IDs: ${mediaIds.join(', ')}`);

      // Fetch all Media resources in a single query
      if (mediaIds.length === 0) {
        this.logger?.info(`[MedplumBackend.getAttachments] No media IDs found, returning empty array`);
        return [];
      }

      this.logger?.info(`[MedplumBackend.getAttachments] Searching for Media resources with _id: ${mediaIds.join(',')}`);
      const mediaResources = await this.medplum.searchResources('Media', {
        _id: mediaIds.join(','),
      });
      this.logger?.info(`[MedplumBackend.getAttachments] Search returned ${mediaResources.length} Media resources`);

      // Build attachments from the fetched Media resources
      for (const media of mediaResources) {
        if (!media.id) continue;

        this.logger?.info(`[MedplumBackend.getAttachments] Processing Media resource ${media.id}`);
        const fileRecord = await this.mediaToAttachmentFileRecord(media);
        if (!fileRecord) continue;

        const attachmentFile = this.createMedplumAttachmentFile(fileRecord);
        const payloadData = payloadMap.get(media.id);

        attachments.push({
          id: `${notificationId}-${media.id}`,
          fileId: media.id,
          filename: fileRecord.filename,
          contentType: fileRecord.contentType,
          size: fileRecord.size,
          checksum: fileRecord.checksum,
          createdAt: fileRecord.createdAt,
          file: attachmentFile,
          description: payloadData?.description,
          storageMetadata: fileRecord.storageMetadata,
        });
        this.logger?.info(`[MedplumBackend.getAttachments] Added attachment ${media.id} to list`);
      }

      this.logger?.info(`[MedplumBackend.getAttachments] Returning ${attachments.length} attachments`);
      return attachments;
    } catch (error) {
      this.logger?.info(`[MedplumBackend.getAttachments] Error fetching attachments: ${error}`);
      return [];
    }
  }

  async deleteNotificationAttachment(
    notificationId: Config['NotificationIdType'],
    attachmentId: string,
  ): Promise<void> {
    const communication = await this.medplum.readResource('Communication', notificationId as string);

    // Check if attachment exists
    const hasAttachment = (communication.payload || []).some((p) => {
      const url = p.contentAttachment?.url;
      return url && url.includes(attachmentId);
    });

    if (!hasAttachment) {
      throw new Error(`Attachment ${attachmentId} not found for notification ${notificationId}`);
    }

    // Filter out the attachment from payload
    const updatedPayload = (communication.payload || []).filter((p) => {
      const url = p.contentAttachment?.url;
      if (!url) return true;
      return !url.includes(attachmentId);
    });

    const updated: Communication = {
      ...communication,
      payload: updatedPayload,
    };

    await this.medplum.updateResource(updated);
  }
}

export class MedplumNotificationBackendFactory<Config extends BaseNotificationTypeConfig> {
  create(medplum: MedplumClient) {
    return new MedplumNotificationBackend<Config>(medplum);
  }
}
