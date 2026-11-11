import { getStatus, type MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { Attachment, Communication, Media } from '@medplum/fhirtypes';
import type {
  AnyDatabaseNotification,
  AttachmentFile,
  AttachmentFileRecord,
  BaseAttachmentManager,
  BaseLogger,
  BaseNotificationBackend,
  BaseNotificationTypeConfig,
  DatabaseNotification,
  DatabaseOneOffNotification,
  FileAttachment,
  InputJsonValue,
  Notification,
  NotificationActionCapabilities,
  NotificationAttachment,
  NotificationFilter,
  NotificationFilterFields,
  NotificationInput,
  NotificationOrderBy,
  NotificationStatus,
  NotificationVersion,
  OneOffNotificationInput,
  RepinNotificationOptions,
  RequeueNotificationOptions,
  StoredAttachment,
} from 'vintasend';
import {
  isFieldFilter,
  log,
  logCount,
  logId,
  logIds,
  NotificationActionError,
  REPINNABLE_NOTIFICATION_STATUSES,
  REQUEUEABLE_NOTIFICATION_STATUSES,
} from 'vintasend';
import {
  communicationStatusToNotificationStatus,
  MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS,
  MEDPLUM_NOTIFICATION_TAG,
  NOTIFICATION_STATUS_TO_COMMUNICATION_STATUS,
} from './constants.js';
import { logMedplumError } from './log-medplum-error.js';
import type { MedplumStorageIdentifiers } from './types.js';

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
const IDENTIFIER_SYSTEMS = MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS;

/**
 * FHIR search parameters for one AND of conditions. Every value is a parameter of its own, which
 * FHIR reads as AND; a comma inside one value is OR.
 */
type SearchParams = Record<string, string[]>;

/** The most separate searches one OR filter may expand to. */
const MAX_OR_BRANCHES = 16;

/** The largest `_count` Medplum serves in one search. */
const MAX_SEARCH_PAGE_SIZE = 1000;

/** What `filterNotificationVersions` asks the server for: nothing of the notification's content. */
const VERSION_ELEMENTS = 'id,meta';

function cloneSearchParams(params: SearchParams): SearchParams {
  return Object.fromEntries(Object.entries(params).map(([key, values]) => [key, [...values]]));
}

/** Both sets of conditions, ANDed: every value of either, each once. */
function mergeSearchParams(left: SearchParams, right: SearchParams): SearchParams {
  const merged = cloneSearchParams(left);
  for (const [key, values] of Object.entries(right)) {
    merged[key] ??= [];
    const existing = merged[key];
    for (const value of values) {
      if (!existing.includes(value)) {
        existing.push(value);
      }
    }
  }
  return merged;
}

/** Add one more parameter, ANDed with any already there under the same name. */
function addSearchParam(params: SearchParams, key: string, value: string): void {
  const values = params[key] ?? [];
  values.push(value);
  params[key] = values;
}

/** The order `_sort=_id` returns resources in. */
function compareIds(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Whether Medplum refused a write because `If-Match` named a version that is no longer current. */
function isPreconditionFailed(error: unknown): boolean {
  return error instanceof OperationOutcomeError && getStatus(error.outcome) === 412;
}

const ONE_OFF_EXTENSION_URLS = {
  emailOrPhone: 'http://vintasend.com/fhir/StructureDefinition/emailOrPhone',
  firstName: 'http://vintasend.com/fhir/StructureDefinition/firstName',
  lastName: 'http://vintasend.com/fhir/StructureDefinition/lastName',
} as const;

export class MedplumNotificationBackend<Config extends BaseNotificationTypeConfig>
  implements BaseNotificationBackend<Config>
{
  private attachmentManager?: BaseAttachmentManager;
  private logger?: BaseLogger;
  private identifier: string;

  constructor(
    private medplum: MedplumClient,
    private options: MedplumNotificationBackendOptions = {
      emailNotificationSubjectExtensionUrl:
        'http://vintasend.com/fhir/StructureDefinition/email-notification-subject',
      identifier: 'default-medplum',
    },
  ) {
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
    this.forwardLoggerToAttachmentManager();
  }

  /**
   * Inject logger for debugging and monitoring
   */
  injectLogger(logger: BaseLogger): void {
    this.logger = logger;
    this.forwardLoggerToAttachmentManager();
  }

  /**
   * VintaSend does not inject a logger into the attachment manager, so the backend hands over the
   * one it was given. Works in either injection order.
   */
  private forwardLoggerToAttachmentManager(): void {
    const manager = this.attachmentManager as
      | (BaseAttachmentManager & { injectLogger?: (logger: BaseLogger) => void })
      | undefined;
    if (this.logger && typeof manager?.injectLogger === 'function') {
      manager.injectLogger(this.logger);
    }
  }

  /**
   * Get the filter capabilities supported by Medplum backend.
   * Medplum cannot negate date ranges or a group, and runs an OR as separate searches: see
   * `filterNotifications`.
   */
  getFilterCapabilities() {
    return {
      'logical.and': true,
      'logical.or': true,
      'logical.not': true,
      'logical.notNested': false,
      'fields.status': true,
      'fields.notificationType': true,
      'fields.adapterUsed': true,
      'fields.userId': true,
      'fields.bodyTemplate': true,
      'fields.subjectTemplate': true,
      'fields.contextName': true,
      'fields.tenant': true,
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
      'orderBy.sendAfter': true,
      'orderBy.sentAt': true,
      'orderBy.readAt': false,
      'orderBy.createdAt': true,
      'orderBy.updatedAt': true,
      // Both are identifier-backed, so a token search finds them exactly, and `identifier:not`
      // negates them — the same shape as adapterUsed and the template fields above.
      'fields.requestedTemplateVersion': true,
      'fields.usedTemplateVersion': true,
      'negation.requestedTemplateVersion': true,
      'negation.usedTemplateVersion': true,
      // `sent:missing` and `identifier=<system>|`; negating either asks for the other value.
      'fields.hasSendAfter': true,
      'negation.hasSendAfter': true,
      'fields.hasRequestedTemplateVersion': true,
      'negation.hasRequestedTemplateVersion': true,
    };
  }

  /**
   * Every optional action: re-pin and re-queue check `expectedVersion` against
   * `meta.versionId`, re-queue pins in the same write, and `filterNotificationVersions` lists
   * without reading content.
   */
  getActionCapabilities(): NotificationActionCapabilities {
    return {
      'repin.expectedVersion': true,
      'requeue.expectedVersion': true,
      'requeue.templateVersion': true,
      'versions.filter': true,
    };
  }

  /**
   * Read a template version back off an identifier.
   *
   * Stored as a decimal string because a FHIR identifier's value is a string. Anything that does
   * not parse as an integer is read as absent rather than as `NaN`: an identifier written by
   * something other than this backend is not worth propagating as a broken number.
   */
  private readTemplateVersion(communication: Communication, system: string): number | null {
    const raw = communication.identifier?.find((identifier) => identifier.system === system)?.value;
    if (raw === undefined) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }

  private isDuplicateReplicationConflict(error: unknown): boolean {
    const normalizedError = String(error).toLowerCase();

    return (
      normalizedError.includes('duplicate') ||
      normalizedError.includes('unique') ||
      normalizedError.includes('already exists') ||
      normalizedError.includes('conflict')
    );
  }

  private convertNotificationOrderByToFhirSort(orderBy: NotificationOrderBy): string {
    const fieldMap: Record<NotificationOrderBy['field'], string> = {
      sendAfter: 'sent',
      sentAt: 'sent',
      createdAt: '_lastUpdated',
      updatedAt: '_lastUpdated',
      readAt: '',
    };

    if (orderBy.field === 'readAt') {
      throw new Error("orderBy field 'readAt' is not supported by MedplumNotificationBackend.");
    }

    const mappedField = fieldMap[orderBy.field];
    return orderBy.direction === 'desc' ? `-${mappedField}` : mappedField;
  }

  private resolveStringFieldForFhir(fieldName: string, value: StringFieldFilter): string {
    if (!isStringFilterLookup(value)) {
      return value;
    }

    if (value.lookup !== 'exact') {
      throw new Error(
        `${fieldName} lookup '${value.lookup}' is not supported by MedplumNotificationBackend. ` +
          'Only exact string matching is supported.',
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
      (ext) => ext.url === this.options.emailNotificationSubjectExtensionUrl,
    );
    const subjectTemplate = subjectTemplateExtension?.valueString || null;

    // Extract one-off notification fields from extensions
    const emailOrPhoneExtension = communication.extension?.find(
      (ext) => ext.url === ONE_OFF_EXTENSION_URLS.emailOrPhone,
    );
    const firstNameExtension = communication.extension?.find(
      (ext) => ext.url === ONE_OFF_EXTENSION_URLS.firstName,
    );
    const lastNameExtension = communication.extension?.find(
      (ext) => ext.url === ONE_OFF_EXTENSION_URLS.lastName,
    );

    const emailOrPhone = emailOrPhoneExtension?.valueString;
    const firstName = firstNameExtension?.valueString;
    const lastName = lastNameExtension?.valueString;

    // Extract contextUsed from extension
    const contextUsedExtension = communication.extension?.find(
      (ext) => ext.url === 'http://vintasend.com/fhir/StructureDefinition/contextUsed',
    );
    const contextUsed = contextUsedExtension?.valueString
      ? JSON.parse(contextUsedExtension.valueString)
      : null;

    // Extract searchable fields from identifiers
    const bodyTemplate =
      communication.identifier?.find((id) => id.system === IDENTIFIER_SYSTEMS.bodyTemplate)
        ?.value ||
      communication.payload?.[0]?.contentString ||
      '';

    const subjectTemplateFromId =
      communication.identifier?.find((id) => id.system === IDENTIFIER_SYSTEMS.subjectTemplate)
        ?.value || subjectTemplate;

    const adapterUsed =
      communication.identifier?.find((id) => id.system === IDENTIFIER_SYSTEMS.adapterUsed)?.value ||
      null;

    const gitCommitSha =
      communication.identifier?.find((id) => id.system === IDENTIFIER_SYSTEMS.gitCommitSha)
        ?.value || null;

    const requestedTemplateVersion = this.readTemplateVersion(
      communication,
      IDENTIFIER_SYSTEMS.requestedTemplateVersion,
    );
    const usedTemplateVersion = this.readTemplateVersion(
      communication,
      IDENTIFIER_SYSTEMS.usedTemplateVersion,
    );

    const baseNotification = {
      id: notificationId,
      // biome-ignore lint/suspicious/noExplicitAny: notificationType is dynamic based on FHIR tags --- IGNORE ---
      notificationType: communication.meta?.tag?.[2]?.code as any,
      title: communication.topic?.text || null,
      // biome-ignore lint/suspicious/noExplicitAny: contextName is dynamic based on notification type --- IGNORE ---
      contextName: communication.meta?.tag?.[1]?.code as any,
      contextParameters: JSON.parse(communication.note?.[0]?.text || '{}'),
      sendAfter: communication.sent ? new Date(communication.sent) : null,
      bodyTemplate,
      subjectTemplate: subjectTemplateFromId,
      extraParams: {},
      tenant: communication.meta?.accounts?.[0]?.reference ?? null,
      status: communicationStatusToNotificationStatus(communication.status),
      contextUsed,
      adapterUsed,
      gitCommitSha,
      requestedTemplateVersion,
      usedTemplateVersion,
      sentAt:
        communication.status === 'completed' ? new Date(communication.sent || new Date()) : null,
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

  async getPendingNotifications(
    page: number,
    pageSize: number,
  ): Promise<AnyDatabaseNotification<Config>[]> {
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

  async getFutureNotifications(
    page: number,
    pageSize: number,
  ): Promise<AnyDatabaseNotification<Config>[]> {
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
    referenceString: Config['UserIdType'],
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
    pageSize: number,
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

  async persistNotification(
    notification: Omit<Notification<Config>, 'id'> & { id?: Config['NotificationIdType'] },
  ): Promise<DatabaseNotification<Config>> {
    const notificationWithOptionalFields = notification as NotificationInput<Config> & {
      gitCommitSha?: string | null;
      requestedTemplateVersion?: number | null;
      tenant?: string | null;
    };

    // Build base payload with body template
    const payload: Communication['payload'] = notification.bodyTemplate
      ? [
          {
            contentString: notification.bodyTemplate,
            extension:
              notification.subjectTemplate && this.options.emailNotificationSubjectExtensionUrl
                ? [
                    {
                      url: this.options.emailNotificationSubjectExtensionUrl,
                      valueString: notification.subjectTemplate,
                    },
                  ]
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
      identifiers.push({
        system: IDENTIFIER_SYSTEMS.subjectTemplate,
        value: notification.subjectTemplate,
      });
    }
    if (notificationWithOptionalFields.gitCommitSha) {
      identifiers.push({
        system: IDENTIFIER_SYSTEMS.gitCommitSha,
        value: notificationWithOptionalFields.gitCommitSha,
      });
    }
    if (
      notificationWithOptionalFields.requestedTemplateVersion !== null &&
      notificationWithOptionalFields.requestedTemplateVersion !== undefined
    ) {
      identifiers.push({
        system: IDENTIFIER_SYSTEMS.requestedTemplateVersion,
        value: String(notificationWithOptionalFields.requestedTemplateVersion),
      });
    }
    // Assign tenant compartment via meta.accounts. Medplum populates meta.compartment
    // server-side from this, which AccessPolicies use for multi-tenant access control.
    // See: https://www.medplum.com/docs/access/multi-tenant-access-policy
    const communication: Communication = {
      resourceType: 'Communication',
      ...(notification.id ? { id: notification.id as string } : {}),
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
        ...(notificationWithOptionalFields.tenant
          ? { accounts: [{ reference: notificationWithOptionalFields.tenant }] }
          : {}),
      },
    };

    const created = await this.medplum.createResource(communication);

    const mappedNotification = this.mapToDatabaseNotification(
      created,
    ) as DatabaseNotification<Config>;

    // Load and attach attachments to the returned notification if they were provided
    if (notification.attachments && notification.attachments.length > 0) {
      this.logger?.info(
        log`[MedplumBackend] Loading ${logCount(notification.attachments.length)} attachments for notification ${logId(mappedNotification.id)}`,
      );
      mappedNotification.attachments = await this.getAttachments(mappedNotification.id);
      this.logger?.info(
        log`[MedplumBackend] Loaded ${logCount(mappedNotification.attachments?.length ?? 0)} attachments for notification ${logId(mappedNotification.id)}`,
      );
    }

    return mappedNotification;
  }

  async persistNotificationUpdate(
    notificationId: Config['NotificationIdType'],
    notification: Partial<Omit<Notification<Config>, 'id'>>,
  ): Promise<DatabaseNotification<Config>> {
    const existing = await this.medplum.readResource('Communication', notificationId as string);
    this.assertTenantUnchanged(existing, notification, notificationId);
    const status = 'status' in notification ? notification.status : undefined;
    const subjectTemplate =
      'subjectTemplate' in notification ? notification.subjectTemplate : undefined;

    const withCommonFields = this.applyCommonFieldUpdates(existing, notification);
    // Update identifiers for searchable fields when they change
    const existingIdentifiers = existing.identifier || [];
    const updatedIdentifiers = this.updateIdentifiers(existingIdentifiers, notification);
    const updatedPayload = this.updatePayloadSubjectTemplate(
      withCommonFields.payload,
      subjectTemplate,
    );

    const updated: Communication = {
      ...withCommonFields,
      ...(status === 'SENT' && { status: 'completed' }),
      ...(status === 'FAILED' && { status: 'stopped' }),
      ...(notification.userId !== undefined && {
        recipient: [{ reference: notification.userId as string }],
      }),
      payload: updatedPayload,
      identifier: updatedIdentifiers,
    };

    const result = await this.medplum.updateResource(updated);
    return this.mapToDatabaseNotification(result) as DatabaseNotification<Config>;
  }

  /**
   * Apply the update fields shared by regular and one-off notifications, written to the same
   * places `persistNotification` / `persistOneOffNotification` write them on create. A field that
   * is absent or `undefined` in the update leaves the stored value as it is; `sendAfter: null`
   * clears `Communication.sent`, as it does on create.
   */
  private applyCommonFieldUpdates(
    existing: Communication,
    notification: Partial<
      Pick<
        Notification<Config>,
        | 'sendAfter'
        | 'title'
        | 'contextName'
        | 'contextParameters'
        | 'notificationType'
        | 'bodyTemplate'
      >
    >,
  ): Communication {
    const { sent: _existingSent, ...updated } = existing;

    let sent = existing.sent;
    if (notification.sendAfter !== undefined) {
      sent = notification.sendAfter?.toISOString();
    }
    if (notification.title !== undefined) {
      updated.topic = { ...existing.topic, text: notification.title || undefined };
    }
    if (notification.contextParameters !== undefined) {
      updated.note = [
        { text: JSON.stringify(notification.contextParameters) },
        ...(existing.note ?? []).slice(1),
      ];
    }

    // Tags are positional, as persistNotification writes them:
    // [notification, contextName, notificationType, (one-off)].
    const tag = [...(existing.meta?.tag ?? [])];
    if (notification.contextName !== undefined) {
      tag[1] = { ...tag[1], code: notification.contextName as string };
    }
    if (notification.notificationType !== undefined) {
      tag[2] = { ...tag[2], code: notification.notificationType as string };
    }

    const firstPayload = existing.payload?.[0];
    if (
      notification.bodyTemplate !== undefined &&
      existing.payload &&
      firstPayload?.contentString !== undefined
    ) {
      updated.payload = [
        { ...firstPayload, contentString: notification.bodyTemplate },
        ...existing.payload.slice(1),
      ];
    }

    return {
      ...updated,
      ...(sent ? { sent } : {}),
      meta: {
        ...existing.meta,
        ...(tag.length > 0 && { tag }),
        lastUpdated: new Date().toISOString(),
      },
    };
  }

  /**
   * Guard against tenant reassignment on update. Changing a Communication's
   * tenant would move it into a different compartment and could leak data
   * across tenant boundaries, so we reject any update that tries to change
   * the tenant. Idempotent updates (same tenant, or no tenant field) are
   * allowed so service-layer code that spreads the full notification through
   * replication still works.
   */
  private assertTenantUnchanged(
    existing: Communication,
    notification: Partial<Record<string, unknown>>,
    notificationId: Config['NotificationIdType'],
  ): void {
    if (!('tenant' in notification)) return;
    const incoming = (notification.tenant as string | null | undefined) ?? null;
    const current = existing.meta?.accounts?.[0]?.reference ?? null;
    if (incoming !== current) {
      throw new Error(
        `Cannot update tenant of notification ${String(notificationId)}: ` +
          `tenant reassignment is not allowed (existing=${current ?? 'null'}, incoming=${incoming ?? 'null'}).`,
      );
    }
  }

  async applyReplicationSnapshotIfNewer(
    snapshot: AnyDatabaseNotification<Config>,
  ): Promise<{ applied: boolean }> {
    const existingNotification = await this.getNotification(snapshot.id, false);

    if (
      existingNotification?.updatedAt &&
      snapshot.updatedAt &&
      existingNotification.updatedAt >= snapshot.updatedAt
    ) {
      return { applied: false };
    }

    if ('emailOrPhone' in snapshot) {
      if (existingNotification) {
        await this.persistOneOffNotificationUpdate(
          snapshot.id,
          snapshot as unknown as Partial<Omit<OneOffNotificationInput<Config>, 'id'>>,
        );

        return { applied: true };
      }

      try {
        await this.persistOneOffNotification(
          snapshot as unknown as Omit<OneOffNotificationInput<Config>, 'id'> & {
            id?: Config['NotificationIdType'];
          },
        );
      } catch (createError) {
        if (!this.isDuplicateReplicationConflict(createError)) {
          throw createError;
        }

        await this.persistOneOffNotificationUpdate(
          snapshot.id,
          snapshot as unknown as Partial<Omit<OneOffNotificationInput<Config>, 'id'>>,
        );
      }

      return { applied: true };
    }

    if (existingNotification) {
      await this.persistNotificationUpdate(
        snapshot.id,
        snapshot as unknown as Partial<Omit<Notification<Config>, 'id'>>,
      );

      return { applied: true };
    }

    try {
      await this.persistNotification(
        snapshot as unknown as Omit<Notification<Config>, 'id'> & {
          id?: Config['NotificationIdType'];
        },
      );
    } catch (createError) {
      if (!this.isDuplicateReplicationConflict(createError)) {
        throw createError;
      }

      await this.persistNotificationUpdate(
        snapshot.id,
        snapshot as unknown as Partial<Omit<Notification<Config>, 'id'>>,
      );
    }

    return { applied: true };
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
    upsert(
      IDENTIFIER_SYSTEMS.subjectTemplate,
      notification.subjectTemplate as string | null | undefined,
    );
    upsert(IDENTIFIER_SYSTEMS.adapterUsed, notification.adapterUsed as string | null | undefined);
    upsert(IDENTIFIER_SYSTEMS.gitCommitSha, notification.gitCommitSha as string | null | undefined);

    const requestedVersion = (notification as { requestedTemplateVersion?: number | null })
      .requestedTemplateVersion;
    upsert(
      IDENTIFIER_SYSTEMS.requestedTemplateVersion,
      requestedVersion === undefined || requestedVersion === null
        ? requestedVersion
        : String(requestedVersion),
    );
    // usedTemplateVersion is deliberately absent: it is written only by storeTemplateVersion.

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

  async getNotifications(
    page: number,
    pageSize: number,
  ): Promise<AnyDatabaseNotification<Config>[]> {
    const communications = await this.medplum.searchResources('Communication', {
      _tag: 'notification',
      _count: pageSize.toString(),
      _offset: (page * pageSize).toString(),
    });
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  async bulkPersistNotifications(
    notifications: Omit<NotificationInput<Config>, 'id'>[],
  ): Promise<Config['NotificationIdType'][]> {
    const ids: Config['NotificationIdType'][] = [];

    for (const notification of notifications) {
      const bulkIdentifiers: Communication['identifier'] = [
        { system: IDENTIFIER_SYSTEMS.bodyTemplate, value: notification.bodyTemplate },
      ];
      if (notification.subjectTemplate) {
        bulkIdentifiers.push({
          system: IDENTIFIER_SYSTEMS.subjectTemplate,
          value: notification.subjectTemplate,
        });
      }
      const notificationWithOptionalFields = notification as Omit<
        NotificationInput<Config>,
        'id'
      > & {
        gitCommitSha?: string | null;
        requestedTemplateVersion?: number | null;
        tenant?: string | null;
      };
      if (notificationWithOptionalFields.gitCommitSha) {
        bulkIdentifiers.push({
          system: IDENTIFIER_SYSTEMS.gitCommitSha,
          value: notificationWithOptionalFields.gitCommitSha,
        });
      }
      if (
        notificationWithOptionalFields.requestedTemplateVersion !== null &&
        notificationWithOptionalFields.requestedTemplateVersion !== undefined
      ) {
        bulkIdentifiers.push({
          system: IDENTIFIER_SYSTEMS.requestedTemplateVersion,
          value: String(notificationWithOptionalFields.requestedTemplateVersion),
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
                extension:
                  notification.subjectTemplate && this.options.emailNotificationSubjectExtensionUrl
                    ? [
                        {
                          url: this.options.emailNotificationSubjectExtensionUrl,
                          valueString: notification.subjectTemplate,
                        },
                      ]
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
          ...(notificationWithOptionalFields.tenant
            ? { accounts: [{ reference: notificationWithOptionalFields.tenant }] }
            : {}),
        },
      };

      const created = await this.medplum.createResource(communication);
      ids.push(created.id as Config['NotificationIdType']);
    }

    return ids;
  }

  async markAsSent(
    notificationId: Config['NotificationIdType'],
    checkIsPending = true,
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
    checkIsPending = true,
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
    checkIsSent = true,
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

  /**
   * Put a failed notification back into `PENDING_SEND` (`Communication.status` `in-progress`).
   *
   * Only `FAILED` can be re-queued here: `cancelNotification` deletes the `Communication`, so a
   * cancelled notification no longer exists to re-queue.
   *
   * `Communication.sent` holds `sendAfter` while a notification is pending, and `sentAt` reads as
   * `null` for anything not `completed`, so moving the status is what clears `sentAt`.
   *
   * The update carries `If-Match` on the version that was read, so a notification changed in
   * between, by a worker or a second re-queue, makes the server refuse it instead of being
   * overwritten. That refusal is a `NotificationActionError` with reason `CHANGED`.
   *
   * `options.templateVersion` pins the notification in the same update, and
   * `options.expectedVersion` refuses with `CHANGED`, writing nothing, unless `meta.versionId` is
   * still that version.
   */
  async requeueNotification(
    notificationId: Config['NotificationIdType'],
    options: RequeueNotificationOptions,
  ): Promise<AnyDatabaseNotification<Config>> {
    const { templateVersion } = options;
    if (
      templateVersion !== undefined &&
      !(Number.isInteger(templateVersion) && templateVersion >= 0)
    ) {
      throw new RangeError(
        `Cannot requeue notification ${String(notificationId)}: templateVersion must be a non-negative integer`,
      );
    }

    let existing: Communication;
    try {
      existing = await this.medplum.readResource('Communication', notificationId as string);
    } catch {
      throw new Error(`Notification ${String(notificationId)} not found`);
    }
    this.assertExpectedVersion('requeue', notificationId, existing, options.expectedVersion);

    const status = communicationStatusToNotificationStatus(existing.status);
    if (!REQUEUEABLE_NOTIFICATION_STATUSES.includes(status)) {
      throw new Error(`Cannot requeue notification ${String(notificationId)} in status ${status}`);
    }

    const { sent: _previousSent, ...withoutSent } = existing;
    let sent: string | undefined = existing.sent;
    if ('sendAfter' in options) {
      sent = options.sendAfter ? options.sendAfter.toISOString() : undefined;
    }

    const updated: Communication = {
      ...withoutSent,
      ...(sent ? { sent } : {}),
      ...(templateVersion === undefined
        ? {}
        : {
            identifier: this.updateIdentifiers(existing.identifier ?? [], {
              requestedTemplateVersion: templateVersion,
            }),
          }),
      status: NOTIFICATION_STATUS_TO_COMMUNICATION_STATUS.PENDING_SEND,
      meta: {
        ...existing.meta,
        lastUpdated: new Date().toISOString(),
      },
    };

    const result = await this.updateIfUnchanged('requeue', notificationId, existing, updated);
    if (templateVersion === undefined) {
      this.logger?.info(log`Notification ${logId(notificationId)} requeued`);
    } else {
      this.logger?.info(
        log`Notification ${logId(notificationId)} requeued on template version ${logCount(templateVersion)}`,
      );
    }
    return this.mapToDatabaseNotification(result);
  }

  /**
   * Pin a notification to a template version, in one update conditional on the version read.
   *
   * Refuses with a `NotificationActionError`, writing nothing: `NOT_FOUND` when there is no such
   * `Communication`, `CHANGED` when `options.expectedVersion` is not its `meta.versionId` or it
   * changes before the update lands (`If-Match`), and `INVALID_STATUS` when it was already sent.
   * Writes nothing either when it is already pinned to `templateVersion`.
   */
  async repinNotification(
    notificationId: Config['NotificationIdType'],
    templateVersion: number,
    options: RepinNotificationOptions,
  ): Promise<AnyDatabaseNotification<Config>> {
    if (!(Number.isInteger(templateVersion) && templateVersion >= 0)) {
      throw new RangeError(
        `Cannot repin notification ${String(notificationId)}: templateVersion must be a non-negative integer`,
      );
    }

    let existing: Communication;
    try {
      existing = await this.medplum.readResource('Communication', notificationId as string);
    } catch {
      throw new NotificationActionError({
        action: 'repin',
        reason: 'NOT_FOUND',
        notificationId,
        message: `Notification ${String(notificationId)} not found`,
      });
    }
    this.assertExpectedVersion('repin', notificationId, existing, options.expectedVersion);

    const status = communicationStatusToNotificationStatus(existing.status);
    if (!REPINNABLE_NOTIFICATION_STATUSES.includes(status)) {
      throw new NotificationActionError({
        action: 'repin',
        reason: 'INVALID_STATUS',
        notificationId,
        status,
        message: `Cannot repin notification ${String(notificationId)} in status ${status}`,
      });
    }

    if (
      this.readTemplateVersion(existing, IDENTIFIER_SYSTEMS.requestedTemplateVersion) ===
      templateVersion
    ) {
      return this.mapToDatabaseNotification(existing);
    }

    const updated: Communication = {
      ...existing,
      identifier: this.updateIdentifiers(existing.identifier ?? [], {
        requestedTemplateVersion: templateVersion,
      }),
      meta: {
        ...existing.meta,
        lastUpdated: new Date().toISOString(),
      },
    };

    const result = await this.updateIfUnchanged('repin', notificationId, existing, updated);
    this.logger?.info(
      log`Notification ${logId(notificationId)} repinned to template version ${logCount(templateVersion)}`,
    );
    return this.mapToDatabaseNotification(result);
  }

  /**
   * Refuse with `CHANGED` when the caller expected another version than the one just read.
   */
  private assertExpectedVersion(
    action: 'requeue' | 'repin',
    notificationId: Config['NotificationIdType'],
    existing: Communication,
    expectedVersion: string | undefined,
  ): void {
    if (expectedVersion === undefined || existing.meta?.versionId === expectedVersion) {
      return;
    }
    throw new NotificationActionError({
      action,
      reason: 'CHANGED',
      notificationId,
      message:
        `Cannot ${action} notification ${String(notificationId)}: ` +
        'it changed since the version that was expected',
    });
  }

  /**
   * Write `updated` only if the stored resource is still the version `existing` was read at.
   *
   * A refusal from the server becomes a `NotificationActionError` with reason `CHANGED`.
   */
  private async updateIfUnchanged(
    action: 'requeue' | 'repin',
    notificationId: Config['NotificationIdType'],
    existing: Communication,
    updated: Communication,
  ): Promise<Communication> {
    const versionId = existing.meta?.versionId;
    try {
      return await this.medplum.updateResource(
        updated,
        versionId ? { headers: { 'If-Match': `W/"${versionId}"` } } : undefined,
      );
    } catch (error) {
      if (isPreconditionFailed(error)) {
        throw new NotificationActionError({
          action,
          reason: 'CHANGED',
          notificationId,
          message:
            `Cannot ${action} notification ${String(notificationId)}: ` +
            'it changed while it was being written',
        });
      }
      throw error;
    }
  }

  async getNotification(
    notificationId: Config['NotificationIdType'],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _forUpdate: boolean,
  ): Promise<AnyDatabaseNotification<Config> | null> {
    try {
      const communication = await this.medplum.readResource(
        'Communication',
        notificationId as string,
      );
      return this.mapToDatabaseNotification(communication);
    } catch {
      return null;
    }
  }

  async filterAllInAppUnreadNotifications(
    refenrenceString: Config['UserIdType'],
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
    pageSize: number,
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

  async getUserEmailFromNotification(
    notificationId: Config['NotificationIdType'],
  ): Promise<string | undefined> {
    try {
      const communication = await this.medplum.readResource(
        'Communication',
        notificationId as string,
      );
      const practitionerRef = communication.recipient?.[0]?.reference;

      if (!practitionerRef) {
        return undefined;
      }

      const [resourceType, id] = practitionerRef.split('/') as ['Patient' | 'Practitioner', string];

      if (!id) {
        this.logger?.warn(
          log`[MedplumBackend.getUserEmailFromNotification] Recipient reference has no id for notification ${logId(notificationId)}`,
        );
        return undefined;
      }

      const resource = await this.medplum.readResource(resourceType, id);
      return resource.telecom?.find((t) => t.system === 'email')?.value;
    } catch (error) {
      this.logger?.error(
        log`[MedplumBackend.getUserEmailFromNotification] Failed to fetch recipient email for notification ${logId(notificationId)}: ${logMedplumError(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Record which version of the template actually rendered this notification.
   *
   * Written as an identifier so the `usedTemplateVersion` filter can find it, replacing any value
   * already there — the service only calls this when the version differs from what is stored.
   */
  async storeTemplateVersion(
    notificationId: Config['NotificationIdType'],
    templateVersion: number,
  ): Promise<void> {
    const existing = await this.medplum.readResource('Communication', notificationId as string);
    const identifiers = (existing.identifier ?? []).filter(
      (identifier) => identifier.system !== IDENTIFIER_SYSTEMS.usedTemplateVersion,
    );

    await this.medplum.updateResource({
      ...existing,
      identifier: [
        ...identifiers,
        {
          system: IDENTIFIER_SYSTEMS.usedTemplateVersion,
          value: String(templateVersion),
        },
      ],
    });
  }

  async storeAdapterAndContextUsed(
    notificationId: Config['NotificationIdType'],
    adapterKey: string,
    context: InputJsonValue,
  ): Promise<void> {
    const communication = await this.medplum.readResource(
      'Communication',
      notificationId as string,
    );
    const contextUsedExtensionUrl = 'http://vintasend.com/fhir/StructureDefinition/contextUsed';
    // Remove any existing contextUsed extension, then add the new one
    const existingExtensions = (communication.extension || []).filter(
      (ext) => ext.url !== contextUsedExtensionUrl,
    );
    // Upsert the adapterUsed identifier
    const existingIdentifiers = (communication.identifier || []).filter(
      (id) => id.system !== IDENTIFIER_SYSTEMS.adapterUsed,
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
    notification: Omit<OneOffNotificationInput<Config>, 'id'> & {
      id?: Config['NotificationIdType'];
    },
  ): Promise<DatabaseOneOffNotification<Config>> {
    const notificationWithOptionalFields = notification as Omit<
      OneOffNotificationInput<Config>,
      'id'
    > & {
      gitCommitSha?: string | null;
      requestedTemplateVersion?: number | null;
      tenant?: string | null;
    };

    // Build base payload with body template
    const payload: Communication['payload'] = notification.bodyTemplate
      ? [
          {
            contentString: notification.bodyTemplate,
            extension:
              notification.subjectTemplate && this.options.emailNotificationSubjectExtensionUrl
                ? [
                    {
                      url: this.options.emailNotificationSubjectExtensionUrl,
                      valueString: notification.subjectTemplate,
                    },
                  ]
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
      oneOffIdentifiers.push({
        system: IDENTIFIER_SYSTEMS.subjectTemplate,
        value: notification.subjectTemplate,
      });
    }
    if (notificationWithOptionalFields.gitCommitSha) {
      oneOffIdentifiers.push({
        system: IDENTIFIER_SYSTEMS.gitCommitSha,
        value: notificationWithOptionalFields.gitCommitSha,
      });
    }
    if (
      notificationWithOptionalFields.requestedTemplateVersion !== null &&
      notificationWithOptionalFields.requestedTemplateVersion !== undefined
    ) {
      oneOffIdentifiers.push({
        system: IDENTIFIER_SYSTEMS.requestedTemplateVersion,
        value: String(notificationWithOptionalFields.requestedTemplateVersion),
      });
    }
    const communication: Communication = {
      resourceType: 'Communication',
      ...(notification.id ? { id: notification.id as string } : {}),
      status: 'in-progress',
      sent: notification.sendAfter?.toISOString(),
      topic: { text: notification.title || undefined },
      payload,
      identifier: oneOffIdentifiers,
      note: [{ text: JSON.stringify(notification.contextParameters) }],
      extension: [
        {
          url: ONE_OFF_EXTENSION_URLS.emailOrPhone,
          valueString: notification.emailOrPhone,
        },
        {
          url: ONE_OFF_EXTENSION_URLS.firstName,
          valueString: notification.firstName,
        },
        {
          url: ONE_OFF_EXTENSION_URLS.lastName,
          valueString: notification.lastName,
        },
      ],
      meta: {
        tag: [
          { code: 'notification' },
          { code: notification.contextName as string },
          { code: notification.notificationType as string },
          { code: 'one-off' },
        ],
        ...(notificationWithOptionalFields.tenant
          ? { accounts: [{ reference: notificationWithOptionalFields.tenant }] }
          : {}),
      },
    };

    const created = await this.medplum.createResource(communication);

    const mappedNotification = this.mapToDatabaseNotification(
      created,
    ) as DatabaseOneOffNotification<Config>;

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
    this.assertTenantUnchanged(existing, notification, notificationId);
    const status = 'status' in notification ? notification.status : undefined;
    const subjectTemplate =
      'subjectTemplate' in notification ? notification.subjectTemplate : undefined;

    const withCommonFields = this.applyCommonFieldUpdates(existing, notification);
    const existingIdentifiers = existing.identifier || [];
    const updatedIdentifiers = this.updateIdentifiers(existingIdentifiers, notification);
    const updatedPayload = this.updatePayloadSubjectTemplate(
      withCommonFields.payload,
      subjectTemplate,
    );

    const recipientExtensions: Record<string, string | undefined> = {
      [ONE_OFF_EXTENSION_URLS.emailOrPhone]: notification.emailOrPhone,
      [ONE_OFF_EXTENSION_URLS.firstName]: notification.firstName,
      [ONE_OFF_EXTENSION_URLS.lastName]: notification.lastName,
    };
    const updatedExtensions = (existing.extension ?? []).map((ext) => {
      const value = recipientExtensions[ext.url];
      return value === undefined ? ext : { ...ext, valueString: value };
    });

    const updated: Communication = {
      ...withCommonFields,
      ...(status === 'SENT' && { status: 'completed' }),
      ...(status === 'FAILED' && { status: 'stopped' }),
      ...(existing.extension && { extension: updatedExtensions }),
      payload: updatedPayload,
      identifier: updatedIdentifiers,
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
    return communications.map(
      (comm) => this.mapToDatabaseNotification(comm) as DatabaseOneOffNotification<Config>,
    );
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
    return communications.map(
      (comm) => this.mapToDatabaseNotification(comm) as DatabaseOneOffNotification<Config>,
    );
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
   *   - `requestedTemplateVersion`, `usedTemplateVersion` → `identifier`
   *   - `hasRequestedTemplateVersion` → `identifier=<system>|` (or `identifier:not`)
   *   - `sendAfterRange`    → `sent` (date comparators)
   *   - `sentAtRange`       → `sent` (date comparators)
   *   - `hasSendAfter`      → `sent:missing`
   *   - `createdAtRange`    → `_lastUpdated` (date comparators)
   *
   * **Logical operators:**
   *   - `AND`  — every sub-filter's parameters, repeated, which FHIR reads as AND
   *   - `OR`   — FHIR search cannot express it across parameters, so the filter is rewritten as
   *     an OR of ANDs and each one is searched separately. The results are merged by ID, ordered
   *     by ID, and paged in memory: a page costs up to `(page + 1) * pageSize` results per branch,
   *     and an `orderBy` is refused rather than applied to the merge.
   *   - `NOT`  — uses FHIR `:not` modifier, on a field filter only
   */
  async filterNotifications(
    filter: NotificationFilter<Config>,
    page: number,
    pageSize: number,
    orderBy?: NotificationOrderBy,
  ): Promise<AnyDatabaseNotification<Config>[]> {
    const conjunctions = this.toConjunctions(filter);

    if (conjunctions.length === 1) {
      const searchParams = conjunctions[0] as SearchParams;
      searchParams._count = [pageSize.toString()];
      searchParams._offset = [(page * pageSize).toString()];
      if (orderBy) {
        searchParams._sort = [this.convertNotificationOrderByToFhirSort(orderBy)];
      }
      const communications = await this.medplum.searchResources(
        'Communication',
        this.paramsToSearchTuples(searchParams),
      );
      return communications.map((comm) => this.mapToDatabaseNotification(comm));
    }

    if (orderBy) {
      throw new Error(
        'orderBy is not supported together with an OR filter by MedplumNotificationBackend: ' +
          'the branches are merged by ID.',
      );
    }
    const communications = await this.searchUnion(conjunctions, page, pageSize, {});
    return communications.map((comm) => this.mapToDatabaseNotification(comm));
  }

  /**
   * The ID and `meta.versionId` of every notification matching `filter`, ordered by ID.
   *
   * Never reads a notification's content: every search asks for `_elements=id,meta`, so the server
   * returns no recipient, context, context parameters, payload, rendered content or attachment, and
   * nothing but `{ id, version }` is returned. The filter itself is evaluated by the server, so it
   * needs no element returned. `meta` carries the version token and the type, context-name and
   * tenant tags.
   *
   * Filters as `filterNotifications` does, `OR` included. `version` is `meta.versionId`; pass it as
   * `expectedVersion` to act on the notification only while it is unchanged.
   */
  async filterNotificationVersions(
    filter: NotificationFilter<Config>,
    page: number,
    pageSize: number,
  ): Promise<NotificationVersion<Config>[]> {
    const conjunctions = this.toConjunctions(filter);
    const elements: SearchParams = { _elements: [VERSION_ELEMENTS] };

    let communications: Communication[];
    if (conjunctions.length === 1) {
      const searchParams: SearchParams = {
        ...(conjunctions[0] as SearchParams),
        _sort: ['_id'],
        _count: [pageSize.toString()],
        _offset: [(page * pageSize).toString()],
        ...elements,
      };
      communications = await this.medplum.searchResources(
        'Communication',
        this.paramsToSearchTuples(searchParams),
      );
    } else {
      communications = await this.searchUnion(conjunctions, page, pageSize, elements);
    }

    return communications.map((communication) => {
      const version = communication.meta?.versionId;
      if (!communication.id || !version) {
        throw new Error(
          `Medplum returned notification ${String(communication.id)} without a version id`,
        );
      }
      return { id: communication.id as Config['NotificationIdType'], version };
    });
  }

  /**
   * Rewrite a filter as an OR of ANDs, one set of FHIR search parameters per AND.
   *
   * A filter with no `or` anywhere comes back as one set, so it is searched exactly as before.
   * An empty `or` matches nothing and comes back as none.
   */
  private toConjunctions(filter: NotificationFilter<Config>): SearchParams[] {
    if ('or' in filter) {
      const branches = (filter as { or: NotificationFilter<Config>[] }).or.flatMap((sub) =>
        this.toConjunctions(sub),
      );
      this.assertBranchLimit(branches.length);
      return branches;
    }

    if ('and' in filter) {
      let result: SearchParams[] = [{}];
      for (const sub of (filter as { and: NotificationFilter<Config>[] }).and) {
        const subBranches = this.toConjunctions(sub);
        const next: SearchParams[] = [];
        for (const left of result) {
          for (const right of subBranches) {
            next.push(mergeSearchParams(left, right));
          }
        }
        this.assertBranchLimit(next.length);
        result = next;
      }
      return result;
    }

    if ('not' in filter) {
      return [this.negateFilter((filter as { not: NotificationFilter<Config> }).not)];
    }

    return [this.fieldFilterToFhirParams(filter as NotificationFilterFields<Config>)];
  }

  private assertBranchLimit(branches: number): void {
    if (branches > MAX_OR_BRANCHES) {
      throw new Error(
        `Filter expands to ${branches} separate searches, more than the ${MAX_OR_BRANCHES} ` +
          'MedplumNotificationBackend runs for one OR filter. Split it into several calls.',
      );
    }
  }

  /**
   * One page of the union of several searches, ordered by ID.
   *
   * Each branch is searched sorted by `_id` for its first `(page + 1) * pageSize` results, which
   * is enough to hold the page wherever it falls in the union. They are merged without
   * duplicates, sorted by ID the way the server sorts them, and sliced.
   */
  private async searchUnion(
    conjunctions: SearchParams[],
    page: number,
    pageSize: number,
    extra: SearchParams,
  ): Promise<Communication[]> {
    const offset = page * pageSize;
    const needed = offset + pageSize;
    if (needed <= 0) {
      return [];
    }

    const byId = new Map<string, Communication>();
    for (const conjunction of conjunctions) {
      for (const communication of await this.searchPrefix(conjunction, needed, extra)) {
        if (communication.id && !byId.has(communication.id)) {
          byId.set(communication.id, communication);
        }
      }
    }

    return [...byId.values()]
      .sort((a, b) => compareIds(a.id as string, b.id as string))
      .slice(offset, needed);
  }

  /** The first `limit` results of one search, sorted by `_id`, fetched in server-sized pages. */
  private async searchPrefix(
    conjunction: SearchParams,
    limit: number,
    extra: SearchParams,
  ): Promise<Communication[]> {
    const results: Communication[] = [];
    while (results.length < limit) {
      const count = Math.min(MAX_SEARCH_PAGE_SIZE, limit - results.length);
      const searchParams: SearchParams = {
        ...cloneSearchParams(conjunction),
        _sort: ['_id'],
        _count: [count.toString()],
        _offset: [results.length.toString()],
        ...extra,
      };
      const batch = await this.medplum.searchResources(
        'Communication',
        this.paramsToSearchTuples(searchParams),
      );
      results.push(...batch);
      if (batch.length < count) {
        break;
      }
    }
    return results;
  }

  /**
   * Ensure the `_tag` parameter always includes `notification`.
   * Mutates the params record in place.
   */
  private ensureNotificationTag(params: SearchParams): void {
    const tags = params._tag;
    if (tags) {
      if (!tags.includes(MEDPLUM_NOTIFICATION_TAG)) {
        tags.unshift(MEDPLUM_NOTIFICATION_TAG);
      }
    } else {
      params._tag = [MEDPLUM_NOTIFICATION_TAG];
    }
  }

  /**
   * Convert search parameters into `string[][]` tuples, one per value.
   *
   * Each value becomes a parameter of its own, which FHIR reads as AND: `_tag=notification&_tag=SMS`,
   * or two `identifier` conditions on different systems. A comma inside one value is OR, which is
   * what a list of values for one field means.
   */
  private paramsToSearchTuples(params: SearchParams): string[][] {
    this.ensureNotificationTag(params);
    const tuples: string[][] = [];
    for (const [key, values] of Object.entries(params)) {
      for (const value of values) {
        tuples.push([key, value]);
      }
    }
    return tuples;
  }

  /**
   * Convert a leaf field filter to FHIR search parameters.
   * Throws for fields that are not queryable via FHIR search.
   */
  private fieldFilterToFhirParams(filter: NotificationFilterFields<Config>): SearchParams {
    const params: SearchParams = {};
    const add = (key: string, value: string): void => addSearchParam(params, key, value);

    // Status → Communication.status (comma-separated = OR)
    if (filter.status !== undefined) {
      const statuses: NotificationStatus[] = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      const fhirStatuses = statuses
        .map((s) => this.mapStatusToFhirStatus(s))
        .filter((s): s is string => s !== null);
      if (fhirStatuses.length > 0) {
        add('status', fhirStatuses.join(','));
      }
    }

    // Notification type → _tag, one parameter per type
    if (filter.notificationType !== undefined) {
      const types = Array.isArray(filter.notificationType)
        ? filter.notificationType
        : [filter.notificationType];
      for (const type of types) {
        add('_tag', type);
      }
    }

    // contextName → _tag
    if (filter.contextName !== undefined) {
      add('_tag', this.resolveStringFieldForFhir('contextName', filter.contextName));
    }

    // UserId → recipient
    if (filter.userId !== undefined) {
      add('recipient', filter.userId as string);
    }

    // Identifier-backed fields. Each field is its own `identifier` parameter, so two fields are
    // ANDed; the values of one field are comma-separated, so they are ORed.
    const addIdentifier = (system: string, values: readonly (string | number)[]): void => {
      add('identifier', values.map((value) => `${system}|${value}`).join(','));
    };

    if (filter.adapterUsed !== undefined) {
      addIdentifier(
        IDENTIFIER_SYSTEMS.adapterUsed,
        Array.isArray(filter.adapterUsed) ? filter.adapterUsed : [filter.adapterUsed],
      );
    }

    if (filter.bodyTemplate !== undefined) {
      addIdentifier(IDENTIFIER_SYSTEMS.bodyTemplate, [
        this.resolveStringFieldForFhir('bodyTemplate', filter.bodyTemplate),
      ]);
    }

    if (filter.subjectTemplate !== undefined) {
      addIdentifier(IDENTIFIER_SYSTEMS.subjectTemplate, [
        this.resolveStringFieldForFhir('subjectTemplate', filter.subjectTemplate),
      ]);
    }

    if (filter.requestedTemplateVersion !== undefined) {
      addIdentifier(
        IDENTIFIER_SYSTEMS.requestedTemplateVersion,
        Array.isArray(filter.requestedTemplateVersion)
          ? filter.requestedTemplateVersion
          : [filter.requestedTemplateVersion],
      );
    }

    if (filter.usedTemplateVersion !== undefined) {
      addIdentifier(
        IDENTIFIER_SYSTEMS.usedTemplateVersion,
        Array.isArray(filter.usedTemplateVersion)
          ? filter.usedTemplateVersion
          : [filter.usedTemplateVersion],
      );
    }

    // `system|` with no value is "any value in this system": the identifier is there.
    if (filter.hasRequestedTemplateVersion !== undefined) {
      add(
        filter.hasRequestedTemplateVersion ? 'identifier' : 'identifier:not',
        `${IDENTIFIER_SYSTEMS.requestedTemplateVersion}|`,
      );
    }

    // tenant → _compartment search parameter (multi-tenant access via meta.accounts)
    if (filter.tenant !== undefined) {
      const tenants: string[] = Array.isArray(filter.tenant) ? filter.tenant : [filter.tenant];
      // FHIR comma-separated values mean OR; Medplum supports this for _compartment
      add('_compartment', tenants.join(','));
    }

    // sendAfterRange → sent date comparators
    if (filter.sendAfterRange) {
      if (filter.sendAfterRange.from) {
        add('sent:ge', filter.sendAfterRange.from.toISOString());
      }
      if (filter.sendAfterRange.to) {
        add('sent:le', filter.sendAfterRange.to.toISOString());
      }
    }

    // hasSendAfter → whether `Communication.sent` is there at all
    if (filter.hasSendAfter !== undefined) {
      add('sent:missing', String(!filter.hasSendAfter));
    }

    // sentAtRange → sent date comparators
    if (filter.sentAtRange) {
      if (filter.sentAtRange.from) {
        add('sent:ge', filter.sentAtRange.from.toISOString());
      }
      if (filter.sentAtRange.to) {
        add('sent:le', filter.sentAtRange.to.toISOString());
      }
    }

    // createdAtRange → _lastUpdated (best approximation in FHIR)
    if (filter.createdAtRange) {
      if (filter.createdAtRange.from) {
        add('_lastUpdated:ge', filter.createdAtRange.from.toISOString());
      }
      if (filter.createdAtRange.to) {
        add('_lastUpdated:le', filter.createdAtRange.to.toISOString());
      }
    }

    return params;
  }

  /**
   * Negate a simple field filter using the FHIR `:not` modifier.
   *
   * Supports every field the capability map reports `negation.*` for: `status`,
   * `notificationType`, `contextName`, `userId`, `adapterUsed`, `bodyTemplate`,
   * `subjectTemplate`, the two template versions, and the two presence fields, which negate by
   * asking for the other value. The date ranges throw, and the map declares them false to match.
   */
  private negateFilter(inner: NotificationFilter<Config>): SearchParams {
    if (!isFieldFilter(inner)) {
      throw new Error(
        'NOT filters are only supported for simple field filters in MedplumNotificationBackend.',
      );
    }

    this.throwIfUnsupportedField(inner);

    const params: Record<string, string> = {};
    const filter = inner as NotificationFilterFields<Config>;

    if (filter.status !== undefined) {
      const statuses: NotificationStatus[] = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
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
      const subjectTemplate = this.resolveStringFieldForFhir(
        'subjectTemplate',
        filter.subjectTemplate,
      );
      params['identifier:not'] = params['identifier:not']
        ? `${params['identifier:not']},${IDENTIFIER_SYSTEMS.subjectTemplate}|${subjectTemplate}`
        : `${IDENTIFIER_SYSTEMS.subjectTemplate}|${subjectTemplate}`;
    }

    // The template versions negate the same way `adapterUsed` does: both are identifier-backed,
    // so `identifier:not` excludes them exactly. Comma-separated values inside one `:not` mean
    // "none of these", which is what negating a list of versions asks for.
    const appendNegatedIdentifier = (value: string): void => {
      params['identifier:not'] = params['identifier:not']
        ? `${params['identifier:not']},${value}`
        : value;
    };

    if (filter.requestedTemplateVersion !== undefined) {
      const versions = Array.isArray(filter.requestedTemplateVersion)
        ? filter.requestedTemplateVersion
        : [filter.requestedTemplateVersion];
      appendNegatedIdentifier(
        versions
          .map((version) => `${IDENTIFIER_SYSTEMS.requestedTemplateVersion}|${version}`)
          .join(','),
      );
    }

    if (filter.usedTemplateVersion !== undefined) {
      const versions = Array.isArray(filter.usedTemplateVersion)
        ? filter.usedTemplateVersion
        : [filter.usedTemplateVersion];
      appendNegatedIdentifier(
        versions.map((version) => `${IDENTIFIER_SYSTEMS.usedTemplateVersion}|${version}`).join(','),
      );
    }

    if (filter.sentAtRange) {
      throw new Error('NOT filter on sentAtRange is not supported by MedplumNotificationBackend.');
    }
    if (filter.sendAfterRange) {
      throw new Error(
        'NOT filter on sendAfterRange is not supported by MedplumNotificationBackend.',
      );
    }
    if (filter.createdAtRange) {
      throw new Error(
        'NOT filter on createdAtRange is not supported by MedplumNotificationBackend.',
      );
    }

    const negated: SearchParams = Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, [value]]),
    );

    // The presence fields negate by asking for the other value, as their own parameters.
    if (filter.hasRequestedTemplateVersion !== undefined) {
      const key = filter.hasRequestedTemplateVersion ? 'identifier:not' : 'identifier';
      addSearchParam(negated, key, `${IDENTIFIER_SYSTEMS.requestedTemplateVersion}|`);
    }
    if (filter.hasSendAfter !== undefined) {
      addSearchParam(negated, 'sent:missing', String(filter.hasSendAfter));
    }

    if (Object.keys(negated).length === 0) {
      throw new Error(
        'NOT filter must contain at least one supported negatable field (status, notificationType, contextName, userId, adapterUsed, bodyTemplate, subjectTemplate, requestedTemplateVersion, usedTemplateVersion, hasRequestedTemplateVersion, hasSendAfter).',
      );
    }

    return negated;
  }

  /**
   * Throw if the filter uses fields not queryable via FHIR search.
   */
  private throwIfUnsupportedField(_filter: NotificationFilterFields<Config>): void {
    // All fields in the current NotificationFilterFields are supported.
    // This method is kept as a guard for future additions.
  }

  /**
   * Map VintaSend NotificationStatus to FHIR Communication status.
   */
  private mapStatusToFhirStatus(status: NotificationStatus): string | null {
    return NOTIFICATION_STATUS_TO_COMMUNICATION_STATUS[status] ?? null;
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
      (id) => id.system === 'http://vintasend.com/fhir/binary-id',
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
      (id) => id.system === 'http://vintasend.com/fhir/attachment-checksum',
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
        `identifier=${checksum}&_tag=vintasend-backend-attachment-metadata`,
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
  private async findAttachmentFilesByChecksums(
    checksums: string[],
  ): Promise<Map<string, AttachmentFileRecord>> {
    if (checksums.length === 0) {
      return new Map();
    }

    try {
      // Build query with all checksums
      const identifierQuery = checksums.join(',');
      const results = await this.medplum.searchResources(
        'Media',
        `identifier=${identifierQuery}&_tag=vintasend-backend-attachment-metadata`,
      );

      // Map results by checksum
      const filesByChecksum = new Map<string, AttachmentFileRecord>();
      for (const media of results) {
        const checksum = media.identifier?.find(
          (id) => id.system === 'http://vintasend.com/fhir/attachment-checksum',
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
    attachments: NotificationAttachment[],
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
          description: attachment.description,
        });
      } else if ('file' in attachment) {
        newUploads.push({
          index: i,
          file: attachment.file,
          filename: attachment.filename,
          contentType: attachment.contentType || 'application/octet-stream',
          description: attachment.description,
        });
      }
    }

    // Fetch all referenced files in parallel
    const referencedFiles = await Promise.all(
      fileReferences.map(async ({ fileId }) => ({
        fileId,
        record: await this.getAttachmentFileRecord(fileId),
      })),
    );

    // Calculate checksums for new uploads using manager's fileToBuffer
    const uploadsWithChecksums = await Promise.all(
      newUploads.map(async (upload) => {
        const buffer = await manager.fileToBuffer(upload.file);
        const checksum = await manager.calculateChecksum(buffer);
        return { ...upload, buffer, checksum };
      }),
    );

    // Batch lookup existing files by checksums
    const checksums = uploadsWithChecksums.map((u) => u.checksum);
    const existingFilesByChecksum = await this.findAttachmentFilesByChecksums(checksums);

    // Process file references
    const fileRecords: Array<{
      index: number;
      record: AttachmentFileRecord;
      description?: string;
    }> = [];

    for (let i = 0; i < fileReferences.length; i++) {
      const { index, description } = fileReferences[i];
      const { record } = referencedFiles[i];
      if (!record) {
        throw new Error(`Attachment file not found: ${fileReferences[i].fileId}`);
      }
      fileRecords.push({
        index,
        record,
        description,
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
        fileRecord = await manager.uploadFile(upload.file, upload.filename, upload.contentType);
        // Store the record in the backend's database
        await this.storeAttachmentFileRecord(fileRecord);
      }

      fileRecords.push({
        index: upload.index,
        record: fileRecord,
        description: upload.description,
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
        comm.payload?.some((p) => p.contentAttachment?.url?.includes(fileId)),
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
      const communication = await this.medplum.readResource(
        'Communication',
        notificationId as string,
      );
      const attachments: StoredAttachment[] = [];

      this.logger?.info(
        log`[MedplumBackend.getAttachments] Fetching attachments for notification ${logId(notificationId)}`,
      );
      this.logger?.info(
        log`[MedplumBackend.getAttachments] Communication has ${logCount(communication.payload?.length ?? 0)} payload items`,
      );

      // Extract all Media IDs from payload
      const mediaIds: string[] = [];
      const payloadMap = new Map<string, { description?: string }>();

      for (const payload of communication.payload || []) {
        const attachment = payload.contentAttachment;
        if (!attachment?.url) continue;

        this.logger?.info(
          log`[MedplumBackend.getAttachments] Found attachment URL: ${logId(attachment.url)}`,
        );

        // Extract Media ID from URL
        const match = attachment.url.match(/Media\/([^/]+)/);
        if (!match) continue;

        const mediaId = match[1];
        this.logger?.info(
          log`[MedplumBackend.getAttachments] Extracted Media ID: ${logId(mediaId)}`,
        );
        mediaIds.push(mediaId);
        payloadMap.set(mediaId, { description: attachment.title });
      }

      this.logger?.info(
        log`[MedplumBackend.getAttachments] Found ${logCount(mediaIds.length)} media IDs: ${logIds(mediaIds)}`,
      );

      // Fetch all Media resources in a single query
      if (mediaIds.length === 0) {
        this.logger?.info(
          log`[MedplumBackend.getAttachments] No media IDs found, returning empty array`,
        );
        return [];
      }

      this.logger?.info(
        log`[MedplumBackend.getAttachments] Searching for Media resources with _id: ${logIds(mediaIds)}`,
      );
      const mediaResources = await this.medplum.searchResources('Media', {
        _id: mediaIds.join(','),
      });
      this.logger?.info(
        log`[MedplumBackend.getAttachments] Search returned ${logCount(mediaResources.length)} Media resources`,
      );

      // Build attachments from the fetched Media resources
      for (const media of mediaResources) {
        if (!media.id) continue;

        this.logger?.info(
          log`[MedplumBackend.getAttachments] Processing Media resource ${logId(media.id)}`,
        );
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
        this.logger?.info(
          log`[MedplumBackend.getAttachments] Added attachment ${logId(media.id)} to list`,
        );
      }

      this.logger?.info(
        log`[MedplumBackend.getAttachments] Returning ${logCount(attachments.length)} attachments`,
      );
      return attachments;
    } catch (error) {
      this.logger?.error(
        log`[MedplumBackend.getAttachments] Failed to fetch attachments for notification ${logId(notificationId)}: ${logMedplumError(error)}`,
      );
      return [];
    }
  }

  async deleteNotificationAttachment(
    notificationId: Config['NotificationIdType'],
    attachmentId: string,
  ): Promise<void> {
    const communication = await this.medplum.readResource(
      'Communication',
      notificationId as string,
    );

    // Check if attachment exists
    const hasAttachment = (communication.payload || []).some((p) => {
      const url = p.contentAttachment?.url;
      return url?.includes(attachmentId);
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
