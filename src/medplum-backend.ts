import { MedplumClient } from '@medplum/core';
import { Attachment, Communication, Media } from '@medplum/fhirtypes';
import type { BaseAttachmentManager } from 'vintasend/dist/services/attachment-manager/base-attachment-manager';
import type { BaseLogger } from 'vintasend/dist/services/loggers/base-logger';
import type {
  BaseNotificationBackend,
  NotificationFilter,
  NotificationFilterFields,
} from 'vintasend/dist/services/notification-backends/base-notification-backend';
import { isFieldFilter } from 'vintasend/dist/services/notification-backends/base-notification-backend';
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
  Notification,
  NotificationInput,
} from 'vintasend/dist/types/notification';
import type { NotificationStatus } from 'vintasend/dist/types/notification-status';
import type { BaseNotificationTypeConfig } from 'vintasend/dist/types/notification-type-config';
import type {
  DatabaseOneOffNotification,
  OneOffNotificationInput,
} from 'vintasend/dist/types/one-off-notification';
import type { MedplumStorageIdentifiers } from './types';

type MedplumNotificationBackendOptions = {
  emailNotificationSubjectExtensionUrl?: string;
  identifier?: string;
};

type StringFilterLookup = {
  lookup: 'exact' | 'startsWith' | 'endsWith' | 'includes';
  value: string;
  caseSensitive?: boolean;
};

type StringFieldFilter = string | StringFilterLookup;

function isStringFilterLookup(value: StringFieldFilter): value is StringFilterLookup {
  return typeof value === 'object' && value !== null && 'lookup' in value && 'value' in value;
}

/** FHIR identifier systems used by MedplumNotificationBackend for searchable fields. */
const IDENTIFIER_SYSTEMS = {
  bodyTemplate: 'http://vintasend.com/fhir/body-template',
  subjectTemplate: 'http://vintasend.com/fhir/subject-template',
  adapterUsed: 'http://vintasend.com/fhir/adapter-used',
  gitCommitSha: 'http://vintasend.com/fhir/git-commit-sha',
} as const;

export class MedplumNotificationBackend<Config extends BaseNotificationTypeConfig> implements BaseNotificationBackend<Config> {
  private attachmentManager?: BaseAttachmentManager;
  private logger?: BaseLogger;
  private identifier: string;

  constructor(private medplum: MedplumClient, private options: MedplumNotificationBackendOptions = {
    emailNotificationSubjectExtensionUrl: 'http://vintasend.com/fhir/StructureDefinition/email-notification-subject',
    identifier: 'default-medplum',
  }) {
    this.identifier = options.identifier || 'default-medplum';
  }

  getBackendIdentifier(): string {
    return this.identifier;
  }

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
   * Get the filter capabilities supported by Medplum backend.
   * Medplum has limitations with OR operators and negation on date ranges.
   */
  getFilterCapabilities() {
    return {
      'logical.and': true,
      'logical.or': false,
      'logical.not': true,
      'logical.notNested': false,
      'fields.status': true,
      'fields.notificationType': true,
      'fields.adapterUsed': true,
      'fields.userId': true,
      'fields.bodyTemplate': true,
      'fields.subjectTemplate': true,
      'fields.contextName': true,
      'fields.sendAfterRange': true,
      'fields.createdAtRange': true,
      'fields.sentAtRange': true,
      'negation.sendAfterRange': false,
      'negation.createdAtRange': false,
      'negation.sentAtRange': false,
      'stringLookups.startsWith': false,
      'stringLookups.endsWith': false,
      'stringLookups.includes': false,
      'stringLookups.caseInsensitive': false,
    };
  }

  private resolveStringFieldForFhir(fieldName: string, value: StringFieldFilter): string {
    if (!isStringFilterLookup(value)) {
      return value;
    }

    if (value.lookup !== 'exact') {
      throw new Error(
        `${fieldName} lookup '${value.lookup}' is not supported by MedplumNotificationBackend. ` +
        "Only exact string matching is supported.",
      );
    }

    if (value.caseSensitive === false) {
      throw new Error(
        `${fieldName} lookup with caseSensitive=false is not supported by MedplumNotificationBackend. ` +
        'Only case-sensitive exact matching is supported.',
      );
    }

    return value.value;
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

    // Extract contextUsed from extension
    const contextUsedExtension = communication.extension?.find(
      (ext) => ext.url === 'http://vintasend.com/fhir/StructureDefinition/contextUsed'
    );
    const contextUsed = contextUsedExtension?.valueString
      ? JSON.parse(contextUsedExtension.valueString)
      : null;

    // Extract searchable fields from identifiers
    const bodyTemplate = communication.identifier?.find(
      (id) => id.system === IDENTIFIER_SYSTEMS.bodyTemplate
    )?.value || communication.payload?.[0]?.contentString || '';

    const subjectTemplateFromId = communication.identifier?.find(
      (id) => id.system === IDENTIFIER_SYSTEMS.subjectTemplate
    )?.value || subjectTemplate;

    const adapterUsed = communication.identifier?.find(
      (id) => id.system === IDENTIFIER_SYSTEMS.adapterUsed
    )?.value || null;

    const gitCommitSha = communication.identifier?.find(
      (id) => id.system === IDENTIFIER_SYSTEMS.gitCommitSha
    )?.value || null;

    const baseNotification = {
      id: notificationId,
      notificationType: communication.meta?.tag?.[2]?.code as any,
      title: communication.topic?.text || null,
      contextName: communication.meta?.tag?.[1]?.code as any,
      contextParameters: JSON.parse(communication.note?.[0]?.text || '{}'),
      sendAfter: communication.sent ? new Date(communication.sent) : null,
      bodyTemplate,
      subjectTemplate: subjectTemplateFromId,
      extraParams: {},
      status:
        communication.status === 'completed' ? 'SENT' : communication.status === 'stopped' ? 'FAILED' : 'PENDING_SEND',
      contextUsed,
      adapterUsed,
      gitCommitSha,
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
    const now = new Date().toISOString();
    const communications = await this.medplum.searchResources('Communication', {
      status: 'in-progress',
      _tag: 'notification',
      'sent:le': now,
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
    const notificationWithOptionalGitCommitSha = notification as NotificationInput<Config> & {
      gitCommitSha?: string | null;
    };

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

    const identifiers: Communication['identifier'] = [
      { system: IDENTIFIER_SYSTEMS.bodyTemplate, value: notification.bodyTemplate },
    ];
    if (notification.subjectTemplate) {
      identifiers.push({ system: IDENTIFIER_SYSTEMS.subjectTemplate, value: notification.subjectTemplate });
    }
    if (notificationWithOptionalGitCommitSha.gitCommitSha) {
      identifiers.push({
        system: IDENTIFIER_SYSTEMS.gitCommitSha,
        value: notificationWithOptionalGitCommitSha.gitCommitSha,
      });
    }

    const communication: Communication = {
      resourceType: 'Communication',
      status: 'in-progress',
      sent: notification.sendAfter?.toISOString(),
      topic: { text: notification.title || undefined },
      payload,
      identifier: identifiers,
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
    notification: Partial<Omit<Notification<Config>, 'id'>>,
  ): Promise<DatabaseNotification<Config>> {
    const existing = await this.medplum.readResource('Communication', notificationId as string);
    const status = 'status' in notification ? notification.status : undefined;
    const subjectTemplate = 'subjectTemplate' in notification ? notification.subjectTemplate : undefined;

    // Update identifiers for searchable fields when they change
    const existingIdentifiers = existing.identifier || [];
    const updatedIdentifiers = this.updateIdentifiers(existingIdentifiers, notification);
    const updatedPayload = this.updatePayloadSubjectTemplate(existing.payload, subjectTemplate);

    const updated: Communication = {
      ...existing,
      ...(status === 'SENT' && { status: 'completed' }),
      ...(status === 'FAILED' && { status: 'stopped' }),
      payload: updatedPayload,
      identifier: updatedIdentifiers,
      meta: {
        ...existing.meta,
        lastUpdated: new Date().toISOString(),
      },
    };

    const result = await this.medplum.updateResource(updated);
    return this.mapToDatabaseNotification(result) as DatabaseNotification<Config>;
  }

  /**
   * Update FHIR identifiers from a partial notification update.
   * Replaces identifier values for known systems when new values are provided.
   */
  private updateIdentifiers(
    existing: NonNullable<Communication['identifier']>,
    notification: Partial<Record<string, unknown>>,
  ): NonNullable<Communication['identifier']> {
    const updated = [...existing];

    const upsert = (system: string, value: string | null | undefined) => {
      if (value === undefined) return;
      const idx = updated.findIndex((id) => id.system === system);
      if (value === null) {
        if (idx >= 0) updated.splice(idx, 1);
      } else if (idx >= 0) {
        updated[idx] = { ...updated[idx], system, value };
      } else {
        updated.push({ system, value });
      }
    };

    upsert(IDENTIFIER_SYSTEMS.bodyTemplate, notification.bodyTemplate as string | undefined);
    upsert(IDENTIFIER_SYSTEMS.subjectTemplate, notification.subjectTemplate as string | null | undefined);
    upsert(IDENTIFIER_SYSTEMS.adapterUsed, notification.adapterUsed as string | null | undefined);
    upsert(IDENTIFIER_SYSTEMS.gitCommitSha, notification.gitCommitSha as string | null | undefined);

    return updated;
  }

  private updatePayloadSubjectTemplate(
    existingPayload: Communication['payload'],
    subjectTemplate: string | null | undefined,
  ): Communication['payload'] {
    if (subjectTemplate === undefined || !existingPayload || existingPayload.length === 0) {
      return existingPayload;
    }

    const updatedPayload = [...existingPayload];
    const firstPayload = updatedPayload[0];
    if (!firstPayload) {
      return existingPayload;
    }

    const subjectExtensionUrl = this.options.emailNotificationSubjectExtensionUrl;
    if (!subjectExtensionUrl) {
      return existingPayload;
    }
    const existingExtensions = (firstPayload.extension || []).filter(
      (ext) => ext.url !== subjectExtensionUrl,
    );

    const updatedExtensions =
      subjectTemplate === null
        ? existingExtensions
        : [...existingExtensions, { url: subjectExtensionUrl, valueString: subjectTemplate }];

    updatedPayload[0] = {
      ...firstPayload,
      extension: updatedExtensions.length > 0 ? updatedExtensions : undefined,
    };

    return updatedPayload;
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
      const bulkIdentifiers: Communication['identifier'] = [
        { system: IDENTIFIER_SYSTEMS.bodyTemplate, value: notification.bodyTemplate },
      ];
      if (notification.subjectTemplate) {
        bulkIdentifiers.push({ system: IDENTIFIER_SYSTEMS.subjectTemplate, value: notification.subjectTemplate });
      }
      const notificationWithOptionalGitCommitSha = notification as Omit<
        NotificationInput<Config>,
        'id'
      > & {
        gitCommitSha?: string | null;
      };
      if (notificationWithOptionalGitCommitSha.gitCommitSha) {
        bulkIdentifiers.push({
          system: IDENTIFIER_SYSTEMS.gitCommitSha,
          value: notificationWithOptionalGitCommitSha.gitCommitSha,
        });
      }

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
        identifier: bulkIdentifiers,
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
    const updatePayload = { readAt: new Date() } as Partial<Omit<Notification<Config>, 'id'>>;
    return this.persistNotificationUpdate(notificationId, updatePayload);
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
    const communications = await this.medplum.searchResources('Communication', [
      ['status', 'completed'],
      ['_tag', 'notification'],
      ['_tag', 'in-app'],
      ['recipient', refenrenceString as string],
    ]);
    return communications
      .map((comm) => this.mapToDatabaseNotification(comm))
      .filter((notif): notif is DatabaseNotification<Config> => 'userId' in notif && !notif.readAt);
  }

  async filterInAppUnreadNotifications(
    refenrenceString: Config['UserIdType'],
    page: number,
    pageSize: number
  ): Promise<DatabaseNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', [
      ['status', 'completed'],
      ['_tag', 'notification'],
      ['_tag', 'in-app'],
      ['recipient', refenrenceString as string],
      ['_count', pageSize.toString()],
      ['_offset', (page * pageSize).toString()],
    ]);
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

  async storeAdapterAndContextUsed(notificationId: Config['NotificationIdType'], adapterKey: string, context: InputJsonValue): Promise<void> {
    const communication = await this.medplum.readResource('Communication', notificationId as string);
    const contextUsedExtensionUrl = 'http://vintasend.com/fhir/StructureDefinition/contextUsed';
    // Remove any existing contextUsed extension, then add the new one
    const existingExtensions = (communication.extension || []).filter(
      (ext) => ext.url !== contextUsedExtensionUrl
    );
    // Upsert the adapterUsed identifier
    const existingIdentifiers = (communication.identifier || []).filter(
      (id) => id.system !== IDENTIFIER_SYSTEMS.adapterUsed
    );
    const updated: Communication = {
      ...communication,
      identifier: [
        ...existingIdentifiers,
        { system: IDENTIFIER_SYSTEMS.adapterUsed, value: adapterKey },
      ],
      extension: [
        ...existingExtensions,
        { url: contextUsedExtensionUrl, valueString: JSON.stringify(context) },
      ],
    };
    await this.medplum.updateResource(updated);
  }

  /* One-off notification methods */

  async persistOneOffNotification(
    notification: Omit<OneOffNotificationInput<Config>, 'id'>,
  ): Promise<DatabaseOneOffNotification<Config>> {
    const notificationWithOptionalGitCommitSha = notification as Omit<
      OneOffNotificationInput<Config>,
      'id'
    > & {
      gitCommitSha?: string | null;
    };

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

    const oneOffIdentifiers: Communication['identifier'] = [
      { system: IDENTIFIER_SYSTEMS.bodyTemplate, value: notification.bodyTemplate },
    ];
    if (notification.subjectTemplate) {
      oneOffIdentifiers.push({ system: IDENTIFIER_SYSTEMS.subjectTemplate, value: notification.subjectTemplate });
    }
    if (notificationWithOptionalGitCommitSha.gitCommitSha) {
      oneOffIdentifiers.push({
        system: IDENTIFIER_SYSTEMS.gitCommitSha,
        value: notificationWithOptionalGitCommitSha.gitCommitSha,
      });
    }

    const communication: Communication = {
      resourceType: 'Communication',
      status: 'in-progress',
      sent: notification.sendAfter?.toISOString(),
      topic: { text: notification.title || undefined },
      payload,
      identifier: oneOffIdentifiers,
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
    notification: Partial<Omit<OneOffNotificationInput<Config>, 'id'>>,
  ): Promise<DatabaseOneOffNotification<Config>> {
    const existing = await this.medplum.readResource('Communication', notificationId as string);
    const status = 'status' in notification ? notification.status : undefined;
    const subjectTemplate = 'subjectTemplate' in notification ? notification.subjectTemplate : undefined;

    const existingIdentifiers = existing.identifier || [];
    const updatedIdentifiers = this.updateIdentifiers(existingIdentifiers, notification);
    const updatedPayload = this.updatePayloadSubjectTemplate(existing.payload, subjectTemplate);

    const updated: Communication = {
      ...existing,
      ...(status === 'SENT' && { status: 'completed' }),
      ...(status === 'FAILED' && { status: 'stopped' }),
      payload: updatedPayload,
      identifier: updatedIdentifiers,
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
    const communications = await this.medplum.searchResources('Communication', [
      ['_tag', 'notification'],
      ['_tag', 'one-off'],
    ]);
    return communications.map((comm) => this.mapToDatabaseNotification(comm) as DatabaseOneOffNotification<Config>);
  }

  async getOneOffNotifications(
    page: number,
    pageSize: number,
  ): Promise<DatabaseOneOffNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', [
      ['_tag', 'notification'],
      ['_tag', 'one-off'],
      ['_count', pageSize.toString()],
      ['_offset', (page * pageSize).toString()],
    ]);
    return communications.map((comm) => this.mapToDatabaseNotification(comm) as DatabaseOneOffNotification<Config>);
  }

  /* Notification filtering methods */

  /**
   * Filter notifications using composable query filters.
   * All filtering is delegated to the FHIR server via search parameters.
   *
   * **Supported filter fields** (translated to FHIR search parameters):
   *   - `status`            → `Communication.status`
   *   - `notificationType`  → `_tag`
   *   - `contextName`       → `_tag`
   *   - `userId`            → `recipient`
   *   - `adapterUsed`       → `identifier` (system: vintasend adapter-used)
   *   - `bodyTemplate`      → `identifier` (system: vintasend body-template)
   *   - `subjectTemplate`   → `identifier` (system: vintasend subject-template)
  *   - `sendAfterRange`    → `sent` (date comparators)
   *   - `sentAtRange`       → `sent` (date comparators)
   *   - `createdAtRange`    → `_lastUpdated` (date comparators)
   *
   * **Logical operators:**
   *   - `AND`  — merges FHIR search parameters from sub-filters
   *   - `OR`   — not supported by FHIR search (throws)
   *   - `NOT`  — uses FHIR `:not` modifier (status, notificationType, userId only)
   */
  async filterNotifications(
    filter: NotificationFilter<Config>,
    page: number,
    pageSize: number,
  ): Promise<AnyDatabaseNotification<Config>[]> {
    if ('or' in filter) {
      throw new Error(
        'OR filters are not supported by MedplumNotificationBackend (FHIR search does not support OR logic).',
      );
    }

    const searchParams = this.buildFhirSearchParams(filter);
    searchParams._count = pageSize.toString();
    searchParams._offset = (page * pageSize).toString();

    // Convert to string[][] so that _tag values become repeated AND parameters
    // (comma-separated _tag in a single param means OR in FHIR, which is wrong here)
    const searchTuples = this.paramsToSearchTuples(searchParams);

    const communications = await this.medplum.searchResources('Communication', searchTuples);
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  /**
   * Ensure the `_tag` parameter always includes `notification`.
   * Mutates the params record in place.
   */
  private ensureNotificationTag(params: Record<string, string>): void {
    if (params._tag) {
      if (!params._tag.split(',').includes('notification')) {
        params._tag = `notification,${params._tag}`;
      }
    } else {
      params._tag = 'notification';
    }
  }

  /**
   * Convert a `Record<string, string>` FHIR search params object into `string[][]` tuples.
   *
   * This is needed because the `_tag` parameter uses comma-separated values internally
   * to accumulate multiple tags (notificationType + contextName + 'notification'), but
   * **FHIR treats comma-separated token values as OR**. To get AND semantics we must
   * repeat the parameter: `_tag=notification&_tag=SMS` instead of `_tag=notification,SMS`.
   *
   * All other parameters are passed through as single key-value pairs.
   */
  private paramsToSearchTuples(params: Record<string, string>): string[][] {
    this.ensureNotificationTag(params);
    const tuples: string[][] = [];
    for (const [key, value] of Object.entries(params)) {
      if (key === '_tag') {
        // Split into separate entries for AND semantics
        for (const tag of value.split(',')) {
          tuples.push(['_tag', tag.trim()]);
        }
      } else {
        tuples.push([key, value]);
      }
    }
    return tuples;
  }

  /**
   * Recursively build FHIR search parameters from a NotificationFilter tree.
   * Handles field filters, AND, and NOT. OR is handled at the caller level.
   */
  private buildFhirSearchParams(
    filter: NotificationFilter<Config>,
  ): Record<string, string> {
    if ('or' in filter) {
      throw new Error(
        'OR filters are not supported by MedplumNotificationBackend (FHIR search does not support OR logic).',
      );
    }

    if ('and' in filter) {
      return this.mergeAndFilters(
        (filter as { and: NotificationFilter<Config>[] }).and,
      );
    }

    if ('not' in filter) {
      return this.negateFilter(
        (filter as { not: NotificationFilter<Config> }).not,
      );
    }

    // Leaf field filter
    return this.fieldFilterToFhirParams(filter as NotificationFilterFields<Config>);
  }

  /**
   * Merge FHIR search parameters from multiple AND sub-filters.
   */
  private mergeAndFilters(
    subFilters: NotificationFilter<Config>[],
  ): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const sub of subFilters) {
      const params = this.buildFhirSearchParams(sub);
      for (const [key, value] of Object.entries(params)) {
        if (key in merged && merged[key] !== value) {
          throw new Error(
            `Conflicting values for FHIR search parameter '${key}' in AND filter: ` +
            `'${merged[key]}' vs '${value}'. ` +
            'AND sub-filters must not set different values for the same search parameter.',
          );
        }
        merged[key] = value;
      }
    }
    return merged;
  }

  /**
   * Convert a leaf field filter to FHIR search parameters.
   * Throws for fields that are not queryable via FHIR search.
   */
  private fieldFilterToFhirParams(
    filter: NotificationFilterFields<Config>,
  ): Record<string, string> {
    const params: Record<string, string> = {};

    // Status → Communication.status (comma-separated = OR)
    if (filter.status !== undefined) {
      const statuses: NotificationStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
      const fhirStatuses = statuses
        .map((s) => this.mapStatusToFhirStatus(s))
        .filter((s): s is string => s !== null);
      if (fhirStatuses.length > 0) {
        params.status = fhirStatuses.join(',');
      }
    }

    // Notification type → _tag (comma-separated = AND in FHIR tags)
    if (filter.notificationType !== undefined) {
      const types = Array.isArray(filter.notificationType)
        ? filter.notificationType
        : [filter.notificationType];
      params._tag = types.join(',');
    }

    // contextName → _tag (appended to existing _tag)
    if (filter.contextName !== undefined) {
      const contextName = this.resolveStringFieldForFhir('contextName', filter.contextName);
      params._tag = params._tag
        ? `${params._tag},${contextName}`
        : contextName;
    }

    // UserId → recipient
    if (filter.userId !== undefined) {
      params.recipient = filter.userId as string;
    }

    // adapterUsed → identifier search with system
    if (filter.adapterUsed !== undefined) {
      const adapters: string[] = Array.isArray(filter.adapterUsed)
        ? filter.adapterUsed
        : [filter.adapterUsed];
      params.identifier = adapters
        .map((a) => `${IDENTIFIER_SYSTEMS.adapterUsed}|${a}`)
        .join(',');
    }

    // bodyTemplate → identifier search with system
    if (filter.bodyTemplate !== undefined) {
      const bodyTemplate = this.resolveStringFieldForFhir('bodyTemplate', filter.bodyTemplate);
      params.identifier = params.identifier
        ? `${params.identifier},${IDENTIFIER_SYSTEMS.bodyTemplate}|${bodyTemplate}`
        : `${IDENTIFIER_SYSTEMS.bodyTemplate}|${bodyTemplate}`;
    }

    // subjectTemplate → identifier search with system
    if (filter.subjectTemplate !== undefined) {
      const subjectTemplate = this.resolveStringFieldForFhir('subjectTemplate', filter.subjectTemplate);
      params.identifier = params.identifier
        ? `${params.identifier},${IDENTIFIER_SYSTEMS.subjectTemplate}|${subjectTemplate}`
        : `${IDENTIFIER_SYSTEMS.subjectTemplate}|${subjectTemplate}`;
    }

    // sendAfterRange → sent date comparators
    if (filter.sendAfterRange) {
      if (filter.sendAfterRange.from) {
        params['sent:ge'] = filter.sendAfterRange.from.toISOString();
      }
      if (filter.sendAfterRange.to) {
        params['sent:le'] = filter.sendAfterRange.to.toISOString();
      }
    }

    // sentAtRange → sent date comparators
    if (filter.sentAtRange) {
      if (filter.sentAtRange.from) {
        params['sent:ge'] = filter.sentAtRange.from.toISOString();
      }
      if (filter.sentAtRange.to) {
        params['sent:le'] = filter.sentAtRange.to.toISOString();
      }
    }

    // createdAtRange → _lastUpdated (best approximation in FHIR)
    if (filter.createdAtRange) {
      if (filter.createdAtRange.from) {
        params['_lastUpdated:ge'] = filter.createdAtRange.from.toISOString();
      }
      if (filter.createdAtRange.to) {
        params['_lastUpdated:le'] = filter.createdAtRange.to.toISOString();
      }
    }

    return params;
  }

  /**
   * Negate a simple field filter using the FHIR `:not` modifier.
   * Only supports `status`, `notificationType`, and `userId`.
   */
  private negateFilter(
    inner: NotificationFilter<Config>,
  ): Record<string, string> {
    if (!isFieldFilter(inner)) {
      throw new Error(
        'NOT filters are only supported for simple field filters in MedplumNotificationBackend.',
      );
    }

    this.throwIfUnsupportedField(inner);

    const params: Record<string, string> = {};
    const filter = inner as NotificationFilterFields<Config>;

    if (filter.status !== undefined) {
      const statuses: NotificationStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
      const fhirStatuses = statuses
        .map((s) => this.mapStatusToFhirStatus(s))
        .filter((s): s is string => s !== null);
      if (fhirStatuses.length > 0) {
        params['status:not'] = fhirStatuses.join(',');
      }
    }

    if (filter.notificationType !== undefined) {
      const types = Array.isArray(filter.notificationType)
        ? filter.notificationType
        : [filter.notificationType];
      params['_tag:not'] = types.join(',');
    }

    if (filter.contextName !== undefined) {
      const contextName = this.resolveStringFieldForFhir('contextName', filter.contextName);
      params['_tag:not'] = params['_tag:not']
        ? `${params['_tag:not']},${contextName}`
        : contextName;
    }

    if (filter.userId !== undefined) {
      params['recipient:not'] = filter.userId as string;
    }

    if (filter.adapterUsed !== undefined) {
      const adapters: string[] = Array.isArray(filter.adapterUsed)
        ? filter.adapterUsed
        : [filter.adapterUsed];
      params['identifier:not'] = adapters
        .map((a) => `${IDENTIFIER_SYSTEMS.adapterUsed}|${a}`)
        .join(',');
    }

    if (filter.bodyTemplate !== undefined) {
      const bodyTemplate = this.resolveStringFieldForFhir('bodyTemplate', filter.bodyTemplate);
      params['identifier:not'] = params['identifier:not']
        ? `${params['identifier:not']},${IDENTIFIER_SYSTEMS.bodyTemplate}|${bodyTemplate}`
        : `${IDENTIFIER_SYSTEMS.bodyTemplate}|${bodyTemplate}`;
    }

    if (filter.subjectTemplate !== undefined) {
      const subjectTemplate = this.resolveStringFieldForFhir('subjectTemplate', filter.subjectTemplate);
      params['identifier:not'] = params['identifier:not']
        ? `${params['identifier:not']},${IDENTIFIER_SYSTEMS.subjectTemplate}|${subjectTemplate}`
        : `${IDENTIFIER_SYSTEMS.subjectTemplate}|${subjectTemplate}`;
    }

    if (filter.sentAtRange) {
      throw new Error('NOT filter on sentAtRange is not supported by MedplumNotificationBackend.');
    }
    if (filter.sendAfterRange) {
      throw new Error('NOT filter on sendAfterRange is not supported by MedplumNotificationBackend.');
    }
    if (filter.createdAtRange) {
      throw new Error('NOT filter on createdAtRange is not supported by MedplumNotificationBackend.');
    }

    if (Object.keys(params).length === 0) {
      throw new Error(
        'NOT filter must contain at least one supported negatable field (status, notificationType, contextName, userId, adapterUsed, bodyTemplate, subjectTemplate).',
      );
    }

    return params;
  }

  /**
   * Throw if the filter uses fields not queryable via FHIR search.
   */
  private throwIfUnsupportedField(
    _filter: NotificationFilterFields<Config>,
  ): void {
    // All fields in the current NotificationFilterFields are supported.
    // This method is kept as a guard for future additions.
  }

  /**
   * Map VintaSend NotificationStatus to FHIR Communication status.
   */
  private mapStatusToFhirStatus(status: NotificationStatus): string | null {
    switch (status) {
      case 'PENDING_SEND':
        return 'in-progress';
      case 'SENT':
      case 'READ':
        return 'completed';
      case 'FAILED':
        return 'stopped';
      case 'CANCELLED':
        return 'not-done';
      default:
        return null;
    }
  }

  /* Attachment management methods */

  /**
   * Store an attachment file record in the backend's database (Media resource).
   * This is called after the AttachmentManager uploads a file and returns storageIdentifiers.
   * The backend stores file metadata along with the storageIdentifiers for later retrieval.
   */
  async storeAttachmentFileRecord(record: AttachmentFileRecord): Promise<void> {
    const storageIds = record.storageIdentifiers as MedplumStorageIdentifiers;

    // Create a Media resource in Medplum to store file metadata
    // This is the backend's database record for the file
    const media: Media = {
      resourceType: 'Media',
      status: 'completed',
      meta: {
        tag: [{ code: 'vintasend-backend-attachment-metadata' }],
      },
      content: {
        contentType: record.contentType,
        url: storageIds.url,
        size: record.size,
        title: record.filename,
        creation: record.createdAt.toISOString(),
      },
      identifier: [
        {
          system: 'http://vintasend.com/fhir/attachment-checksum',
          value: record.checksum,
        },
        {
          system: 'http://vintasend.com/fhir/binary-id',
          value: storageIds.medplumBinaryId,
        },
      ],
    };

    // Store storageIdentifiers as JSON string in an extension
    // This keeps identifiers opaque - backend doesn't inspect specific fields
    media.extension = media.extension || [];
    media.extension.push({
      url: 'http://vintasend.com/fhir/StructureDefinition/storage-identifiers',
      valueString: JSON.stringify(storageIds),
    });

    await this.medplum.createResource(media);
  }

  /**
   * Get an attachment file record from the backend's database.
   * Reads the Media resource created by storeAttachmentFileRecord().
   */
  async getAttachmentFileRecord(fileId: string): Promise<AttachmentFileRecord | null> {
    try {
      const media = await this.medplum.readResource('Media', fileId);
      return this.mediaToAttachmentFileRecord(media);
    } catch {
      return null;
    }
  }

  /**
   * Helper: Convert FHIR Media resource to AttachmentFileRecord
   * Extracts metadata directly from the Media resource using the same logic as MedplumAttachmentManager.getFile
   */
  private mediaToAttachmentFileRecord(media: Media): AttachmentFileRecord | null {
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

    // Create proper MedplumStorageIdentifiers with correct field names
    const storageIdentifiers: MedplumStorageIdentifiers = {
      id: media.id,
      medplumBinaryId: binaryId || '',
      medplumMediaId: media.id,
      url: media.content.url || '',
    };

    return {
      id: media.id,
      filename: media.content.title || 'untitled',
      contentType: media.content.contentType || 'application/octet-stream',
      size: media.content.size || 0,
      checksum,
      storageIdentifiers,
      createdAt: media.meta?.lastUpdated ? new Date(media.meta.lastUpdated) : new Date(),
      updatedAt: media.meta?.lastUpdated ? new Date(media.meta.lastUpdated) : new Date(),
    };
  }

  /**
   * Helper: Create FHIR Attachment from file record
   */
  private async createFhirAttachment(fileRecord: AttachmentFileRecord): Promise<Attachment> {
    const url = fileRecord.storageIdentifiers?.url as string | undefined;
    return {
      contentType: fileRecord.contentType,
      url: url,
      size: fileRecord.size,
      title: fileRecord.filename,
      creation: fileRecord.createdAt.toISOString(),
    };
  }

  /**
   * Helper: Create MedplumAttachmentFile from storage identifiers
   */
  private createMedplumAttachmentFile(fileRecord: AttachmentFileRecord): AttachmentFile {
    const manager = this.getAttachmentManager();
    return manager.reconstructAttachmentFile(fileRecord.storageIdentifiers);
  }

  async findAttachmentFileByChecksum(checksum: string): Promise<AttachmentFileRecord | null> {
    try {
      const results = await this.medplum.searchResources(
        'Media',
        `identifier=${checksum}&_tag=vintasend-backend-attachment-metadata`
      );

      if (results.length === 0) {
        return null;
      }

      const fileRecord = this.mediaToAttachmentFileRecord(results[0]);
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
        `identifier=${identifierQuery}&_tag=vintasend-backend-attachment-metadata`
      );

      // Map results by checksum
      const filesByChecksum = new Map<string, AttachmentFileRecord>();
      for (const media of results) {
        const checksum = media.identifier?.find(
          (id) => id.system === 'http://vintasend.com/fhir/attachment-checksum'
        )?.value;
        if (checksum) {
          const fileRecord = this.mediaToAttachmentFileRecord(media);
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
   * Works with any AttachmentManager implementation
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
        record: await this.getAttachmentFileRecord(fileId)
      }))
    );

    // Calculate checksums for new uploads using manager's fileToBuffer
    const uploadsWithChecksums = await Promise.all(
      newUploads.map(async (upload) => {
        const buffer = await manager.fileToBuffer(upload.file);
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
        // Upload new file to the manager
        fileRecord = await manager.uploadFile(
          upload.file,
          upload.filename,
          upload.contentType
        );
        // Store the record in the backend's database
        await this.storeAttachmentFileRecord(fileRecord);
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
    const manager = this.getAttachmentManager();

    // Check if file exists first
    const fileRecord = await this.getAttachmentFileRecord(fileId);
    if (!fileRecord) {
      // File not found, return early
      return;
    }

    // Check if file is still referenced by any notifications
    if (await this.isFileReferencedByNotifications(fileId)) {
      throw new Error('Cannot delete attachment file: still referenced by notifications');
    }

    // Delete from storage backend using storageIdentifiers
    await manager.deleteFileByIdentifiers(fileRecord.storageIdentifiers);

    // Delete backend's database record (Media resource)
    await this.medplum.deleteResource('Media', fileId);
  }

  /**
   * Check if a file is referenced by any active notifications
   */
  private async isFileReferencedByNotifications(fileId: string): Promise<boolean> {
    try {
      const communications = await this.medplum.searchResources('Communication', {
        _tag: 'notification',
      });

      return communications.some((comm) =>
        comm.payload?.some((p) => p.contentAttachment?.url?.includes(fileId))
      );
    } catch {
      return false;
    }
  }

  async getOrphanedAttachmentFiles(): Promise<AttachmentFileRecord[]> {
    // Get all backend's file metadata records (Media resources tagged as backend metadata)
    const allMedia = await this.medplum.searchResources('Media', {
      _tag: 'vintasend-backend-attachment-metadata',
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
    const fileRecords: (AttachmentFileRecord | null)[] = [];
    for (const media of orphaned) {
      fileRecords.push(this.mediaToAttachmentFileRecord(media));
    }
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
          storageMetadata: fileRecord.storageIdentifiers,
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
  create(medplum: MedplumClient, options?: MedplumNotificationBackendOptions) {
    return new MedplumNotificationBackend<Config>(medplum, options);
  }
}
