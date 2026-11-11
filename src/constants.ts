/**
 * How `MedplumNotificationBackend` stores a notification as a FHIR `Communication`.
 *
 * Exported for code that has to search or read those resources itself. Prefer the backend's own
 * methods where one exists: `filterNotificationVersions` counts and selects notifications without
 * reading their content, which a direct search cannot promise unless it limits `_elements` too.
 */

import type { Communication } from '@medplum/fhirtypes';
import type { NotificationStatus } from 'vintasend';

/**
 * The `Communication.identifier` systems the backend writes, one per searchable field.
 *
 * Each identifier's value is the field's value; template versions are decimal strings. Search one
 * with `identifier=<system>|<value>`, or `identifier=<system>|` for "has any value".
 */
export const MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS = {
  bodyTemplate: 'http://vintasend.com/fhir/body-template',
  subjectTemplate: 'http://vintasend.com/fhir/subject-template',
  adapterUsed: 'http://vintasend.com/fhir/adapter-used',
  gitCommitSha: 'http://vintasend.com/fhir/git-commit-sha',
  // Template versions live in identifiers rather than extensions so `identifier` — a token
  // search, exact and repeatable — can filter on them the way it already does for the fields
  // above. Stored as decimal strings and parsed back on read.
  requestedTemplateVersion: 'http://vintasend.com/fhir/requested-template-version',
  usedTemplateVersion: 'http://vintasend.com/fhir/used-template-version',
} as const;

/**
 * The `meta.tag` code every notification carries. Search with `_tag=notification`; the backend
 * adds it to every search so other `Communication` resources are never matched.
 */
export const MEDPLUM_NOTIFICATION_TAG = 'notification';

/**
 * The `Communication.status` the backend writes, and searches for, for each notification status.
 *
 * `SENT` and `READ` share `completed`: Medplum does not store when a notification was read. No
 * notification is stored as `not-done`, because `cancelNotification` deletes the `Communication`,
 * so a search for `CANCELLED` finds nothing.
 */
export const NOTIFICATION_STATUS_TO_COMMUNICATION_STATUS: Readonly<
  Record<NotificationStatus, NonNullable<Communication['status']>>
> = {
  PENDING_SEND: 'in-progress',
  SENT: 'completed',
  READ: 'completed',
  FAILED: 'stopped',
  CANCELLED: 'not-done',
};

/**
 * The notification status the backend reads off a `Communication.status`: `completed` is `SENT`,
 * `stopped` is `FAILED`, and anything else is `PENDING_SEND`.
 */
export function communicationStatusToNotificationStatus(
  status: Communication['status'] | undefined,
): NotificationStatus {
  if (status === 'completed') {
    return 'SENT';
  }
  if (status === 'stopped') {
    return 'FAILED';
  }
  return 'PENDING_SEND';
}
