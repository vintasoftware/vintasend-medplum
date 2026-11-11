# VintaSend Medplum Implementation

A complete VintaSend implementation using [Medplum](https://www.medplum.com/) as the backend, leveraging FHIR resources for notification management, file storage, and healthcare integration.

## Overview

This implementation uses FHIR (Fast Healthcare Interoperability Resources) standards to store and manage notifications, making it ideal for healthcare applications that need to integrate notifications with patient care workflows.

### Key Components

- **MedplumNotificationBackend**: Stores notifications as FHIR `Communication` resources
- **MedplumNotificationAdapter**: Sends email notifications via Medplum's email API
- **MedplumAttachmentManager**: Manages file attachments using FHIR `Binary` and `Media` resources
- **PugInlineEmailTemplateRenderer**: Renders Pug email templates from pre-compiled JSON (ideal for production)
- **MedplumLogger**: Simple console-based logger

## Quick Start

```bash
# Install the package
npm install vintasend-medplum @medplum/core

# Compile your Pug templates
npx compile-pug-templates ./templates ./src/compiled-templates.json
```

```typescript
import { MedplumClient } from '@medplum/core';
import { 
  MedplumNotificationBackend, 
  MedplumNotificationAdapter,
  PugInlineEmailTemplateRenderer,
  MedplumLogger 
} from 'vintasend-medplum';
import { NotificationService } from 'vintasend';
import compiledTemplates from './compiled-templates.json';

// Initialize Medplum client
const medplum = new MedplumClient({
  baseUrl: 'https://api.medplum.com',
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
});

// Create services
const renderer = new PugInlineEmailTemplateRenderer(compiledTemplates);
const adapter = new MedplumNotificationAdapter(medplum, renderer);
const backend = new MedplumNotificationBackend(medplum);
const logger = new MedplumLogger();

// Initialize notification service
const notificationService = new NotificationService(backend, [adapter], logger);

// Send a notification
await notificationService.createNotification({
  userId: 'Patient/123',
  notificationType: 'EMAIL',
  contextName: 'welcome',
  contextParameters: { firstName: 'John' },
  title: 'Welcome!',
  bodyTemplate: 'welcome.pug',
  subjectTemplate: 'subjects/welcome.pug',
  sendAfter: new Date(),
});

await notificationService.processPendingNotifications();
```

## How It Works

### FHIR Resource Mapping

The implementation maps VintaSend concepts to FHIR resources:

#### Notifications → Communication Resources

```typescript
{
  resourceType: "Communication",
  status: "in-progress",           // PENDING_SEND
  sent: "2024-01-15T10:00:00Z",   // sendAfter
  topic: { text: "Welcome!" },     // title
  recipient: [{ reference: "Patient/123" }],  // userId
  payload: [{
    contentString: "Hello {{name}}",  // bodyTemplate
    extension: [{
      url: "http://vintasend.com/fhir/StructureDefinition/email-notification-subject",
      valueString: "Welcome {{name}}"  // subjectTemplate
    }]
  }],
  note: [{ text: '{"userId": "123"}' }],  // contextParameters
  identifier: [
    { system: "http://vintasend.com/fhir/requested-template-version", value: "3" },
    { system: "http://vintasend.com/fhir/used-template-version", value: "3" }
  ],
  meta: {
    tag: [
      { code: "notification" },
      { code: "user-welcome" },      // contextName
      { code: "EMAIL" }              // notificationType
    ]
  }
}
```

#### Template versions

The two fields VintaSend uses for
[template version pinning](https://github.com/vintasoftware/vintasend-ts#template-version-pinning)
are stored as identifiers rather than extensions, so a token search can filter on them exactly the
way it already does for `bodyTemplate` and `adapterUsed`. Nothing to configure — a notification
whose renderer does not version templates simply carries neither identifier.

FHIR identifier values are strings, so a version round-trips through `String()` on the way in and
`parseInt` on the way out; a value that does not parse as an integer reads back as `null` rather
than as `NaN`.

`requestedTemplateVersion` travels with ordinary create and update writes.
`usedTemplateVersion` is written only by `storeTemplateVersion`, which the service calls at send
time, and replaces any value already there rather than accumulating identifiers.

```typescript
// still pinned to v3
await service.filterNotifications({ requestedTemplateVersion: 3 }, 0, 20);

// went out on v1 or v2 — the query after finding a bug in an old version
await service.filterNotifications({ usedTemplateVersion: [1, 2] }, 0, 20);
```

#### File Attachments → Binary + Media Resources

Files are stored using two FHIR resources:

1. **Binary Resource**: Stores the actual file data (base64 encoded)
2. **Media Resource**: Stores metadata and links to the Binary

```typescript
// Binary resource
{
  resourceType: "Binary",
  contentType: "application/pdf",
  data: "base64EncodedData..."
}

// Media resource
{
  resourceType: "Media",
  status: "completed",
  content: {
    contentType: "application/pdf",
    url: "Binary/binary-id",
    size: 12345,
    title: "invoice.pdf"
  },
  identifier: [{
    system: "http://vintasend.com/fhir/attachment-checksum",
    value: "sha256-checksum"
  }]
}
```

### Status Mapping

| VintaSend Status | FHIR Communication Status |
|-----------------|---------------------------|
| PENDING_SEND    | in-progress               |
| SENT            | completed                 |
| FAILED          | stopped                   |

`READ` is stored as `completed` too, and `CANCELLED` is never stored: `cancelNotification` deletes
the `Communication`.

### Storage constants

For code that still has to search or read the `Communication` resources itself, the package exports
what the backend writes, so nobody has to copy them:

```typescript
import {
  MEDPLUM_NOTIFICATION_IDENTIFIER_SYSTEMS, // { bodyTemplate, subjectTemplate, adapterUsed, gitCommitSha, requestedTemplateVersion, usedTemplateVersion }
  MEDPLUM_NOTIFICATION_TAG, // 'notification', on every notification's meta.tag
  NOTIFICATION_STATUS_TO_COMMUNICATION_STATUS, // NotificationStatus → Communication.status
  communicationStatusToNotificationStatus, // Communication.status → NotificationStatus
} from 'vintasend-medplum';
```

Prefer `filterNotificationVersions` below for counting and selecting: a search of your own returns
whole resources, recipients and contexts included, unless you limit `_elements` yourself.

## Installation

```bash
npm install vintasend-medplum @medplum/core
```

## Setup

### Template Compilation

VintaSend Medplum uses pre-compiled Pug email templates that are embedded in your application as JSON. This approach ensures templates are bundled with your code and don't require file system access at runtime.

**Step 1: Organize Your Templates**

Create a directory structure for your templates:
```
templates/
  welcome.pug
  password-reset.pug
  notifications/
    order-confirmation.pug
    shipment-update.pug
```

**Step 2: Compile Templates**

Run the compilation script using npx:

```bash
npx compile-pug-templates [input-directory] [output-file]
```

Both arguments are optional:
- `input-directory`: Directory containing .pug templates (default: `./templates`)
- `output-file`: Output JSON file path (default: `compiled-templates.json`)

Examples:
```bash
# Use default values (./templates → compiled-templates.json)
npx compile-pug-templates

# Specify only input directory (output to compiled-templates.json)
npx compile-pug-templates ./email-templates

# Specify both arguments
npx compile-pug-templates ./templates ./src/compiled-templates.json
```

Or add it to your package.json scripts:
```json
{
  "scripts": {
    "compile-templates": "compile-pug-templates ./templates ./src/compiled-templates.json"
  }
}
```

This generates a JSON file where keys are relative paths and values are template contents:
```json
{
  "welcome.pug": "doctype html\nhtml\n  body\n    h1 Welcome {{firstName}}!",
  "notifications/order-confirmation.pug": "doctype html\n..."
}
```

**Step 3: Import and Use Compiled Templates**

```typescript
import { PugInlineEmailTemplateRenderer } from 'vintasend-medplum';
import compiledTemplates from './compiled-templates.json';

// Create the template renderer with compiled templates
const templateRenderer = new PugInlineEmailTemplateRenderer(compiledTemplates);

// Use with notification adapter
const adapter = new MedplumNotificationAdapter(medplum, templateRenderer);
```

### Basic Configuration

```typescript
import { MedplumClient } from '@medplum/core';
import { MedplumNotificationBackend } from 'vintasend-medplum';
import { MedplumNotificationAdapter } from 'vintasend-medplum';
import { MedplumAttachmentManager } from 'vintasend-medplum';
import { MedplumLogger } from 'vintasend-medplum';
import { PugTemplateRenderer } from 'vintasend-pug';
import { NotificationService } from 'vintasend';

// Initialize Medplum client
const medplum = new MedplumClient({
  baseUrl: 'https://api.medplum.com',
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
});

// Create template renderer
const templateRenderer = new PugTemplateRenderer({
  templatesDir: './templates',
});

// Create notification adapter
const adapter = new MedplumNotificationAdapter(medplum, templateRenderer);

// Create backend
const backend = new MedplumNotificationBackend(medplum, {
  emailNotificationSubjectExtensionUrl: 'http://your-domain.com/fhir/StructureDefinition/email-notification-subject',
});

// Create attachment manager (optional)
const attachmentManager = new MedplumAttachmentManager(medplum);

// Create logger
const logger = new MedplumLogger();

// Initialize notification service
const notificationService = new NotificationService(
  backend,
  [adapter],
  logger,
  attachmentManager,
);
```

### With Custom Configuration

```typescript
// Custom extension URL for email subjects
const backend = new MedplumNotificationBackend(medplum, {
  emailNotificationSubjectExtensionUrl: 'http://example.com/fhir/email-subject',
});
```

## Usage Examples

### Configuring Templates

When creating notifications, reference your templates using the same paths used during compilation:

```typescript
// If you compiled templates/welcome.pug
await notificationService.createNotification({
  userId: 'Patient/123',
  notificationType: 'EMAIL',
  contextName: 'user-welcome',
  contextParameters: {
    firstName: 'John',
    lastName: 'Doe',
  },
  title: 'Welcome to our platform!',
  bodyTemplate: 'welcome.pug',           // Path from compiled templates
  subjectTemplate: 'subjects/welcome.pug', // Can be in subdirectories
  sendAfter: new Date(),
});

// If you compiled templates/notifications/order-confirmation.pug
await notificationService.createNotification({
  userId: 'Patient/456',
  notificationType: 'EMAIL',
  contextName: 'order-confirmation',
  contextParameters: {
    orderNumber: '12345',
    totalAmount: '$99.99',
  },
  title: 'Order Confirmation',
  bodyTemplate: 'notifications/order-confirmation.pug',
  subjectTemplate: 'notifications/subjects/order-confirmation.pug',
  sendAfter: new Date(),
});
```

**Template Example (welcome.pug):**
```pug
doctype html
html
  head
    title Welcome
  body
    h1 Welcome #{firstName} #{lastName}!
    p Thank you for joining our platform.
    p 
      | If you have any questions, feel free to 
      a(href="mailto:support@example.com") contact us
```

### Sending a Simple Notification

```typescript
// Create a notification
await notificationService.createNotification({
  userId: 'Patient/123',
  notificationType: 'EMAIL',
  contextName: 'user-welcome',
  contextParameters: {
    firstName: 'John',
    lastName: 'Doe',
  },
  title: 'Welcome to our platform!',
  bodyTemplate: 'Hello {{firstName}} {{lastName}}!',
  subjectTemplate: 'Welcome {{firstName}}!',
  sendAfter: new Date(),
});

// Process pending notifications
await notificationService.processPendingNotifications();
```

### Sending Notifications with Attachments

```typescript
import { readFile } from 'fs/promises';

// Create notification with file attachments
await notificationService.createNotification({
  userId: 'Patient/123',
  notificationType: 'EMAIL',
  contextName: 'lab-results',
  contextParameters: {
    patientName: 'John Doe',
  },
  title: 'Your lab results are ready',
  bodyTemplate: 'Dear {{patientName}}, your lab results are attached.',
  subjectTemplate: 'Lab Results - {{patientName}}',
  sendAfter: new Date(),
  attachments: [
    {
      file: await readFile('./lab-results.pdf'),
      filename: 'lab-results.pdf',
      contentType: 'application/pdf',
    },
  ],
});
```

### One-Off Notifications

Send notifications to users without storing them in the system:

```typescript
await notificationService.createOneOffNotification({
  emailOrPhone: 'patient@example.com',
  firstName: 'Jane',
  lastName: 'Smith',
  notificationType: 'EMAIL',
  contextName: 'appointment-reminder',
  contextParameters: {
    appointmentDate: '2024-02-01',
    doctorName: 'Dr. Johnson',
  },
  title: 'Appointment Reminder',
  bodyTemplate: 'Hi {{firstName}}, reminder for your appointment on {{appointmentDate}}.',
  subjectTemplate: 'Appointment on {{appointmentDate}}',
  sendAfter: new Date(),
});
```

### Managing Attachments

```typescript
// Upload a file
const fileRecord = await attachmentManager.uploadFile(
  buffer,
  'document.pdf',
  'application/pdf',
);

// Retrieve file metadata
const file = await attachmentManager.getFile(fileRecord.id);

// Get file data
const attachmentFile = attachmentManager.reconstructAttachmentFile(
  file.storageMetadata,
);
const fileBuffer = await attachmentFile.read();

// Generate temporary URL
const url = await attachmentFile.url(3600); // 1 hour expiry

// Delete file
await attachmentManager.deleteFile(fileRecord.id);
```

### Querying Notifications

```typescript
// Get pending notifications
const pending = await notificationService.getPendingNotifications(0, 10);

// Get future notifications for a user
const future = await notificationService.getFutureNotificationsFromUser(
  'Patient/123',
  0,
  10,
);

// Get unread in-app notifications
const unread = await notificationService.filterInAppUnreadNotifications(
  'Patient/123',
  0,
  10,
);

// Mark as read
await notificationService.markAsRead(notificationId);
```

### Filtering

`filterNotifications` translates a filter into a FHIR search. Fields map to search parameters
(`status`, `_tag`, `recipient`, `identifier`, `sent`, `_lastUpdated`, `_compartment`), several
conditions are ANDed by repeating parameters, and `{ not: ... }` uses the `:not` modifier on a
field filter.

* **`OR`** is supported (`logical.or: true`), although FHIR search cannot express it across
  parameters. The filter is rewritten as an OR of ANDs, each branch is searched on its own, and the
  results are merged by ID, ordered by ID and paged in memory. A page costs up to
  `(page + 1) * pageSize` results per branch, a filter expanding to more than 16 branches is
  refused, and `orderBy` is refused together with `OR` rather than applied to the merge.
* **`hasSendAfter`** (`sent:missing`) and **`hasRequestedTemplateVersion`**
  (`identifier=<system>|`) match notifications with or without a send time or a template pin.
  Negating either asks for the other value.
* Two identifier-backed fields in one filter, such as `bodyTemplate` and
  `requestedTemplateVersion`, are ANDed. Before this release they were sent as one comma-separated
  `identifier` parameter, which FHIR reads as OR.

### Moving notifications safely

To move a template key's pending and failed emails onto a newly published version without reading
them, and without moving one that changed since it was counted:

```typescript
const V = 4;
const pendingOnAnotherVersion = {
  and: [
    { bodyTemplate: 'welcome', status: 'PENDING_SEND', hasSendAfter: true },
    { hasRequestedTemplateVersion: true },
    { not: { requestedTemplateVersion: V } },
  ],
} as const;
const failed = { bodyTemplate: 'welcome', status: 'FAILED' } as const;

// IDs and version tokens only: every search asks for `_elements=id,meta`. The OR of both is what
// an admin is shown as the count.
const toMove = await notificationService.filterNotificationVersions(
  { or: [pendingOnAnotherVersion, failed] },
  0,
  1000,
);

for (const { id, version } of await notificationService.filterNotificationVersions(pendingOnAnotherVersion, 0, 100)) {
  await notificationService.repinNotification(id, { templateVersion: V, expectedVersion: version });
}
for (const { id, version } of await notificationService.filterNotificationVersions(failed, 0, 100)) {
  // Pin and re-queue in one write. `send: false` leaves it to sendPendingNotifications, so this
  // process needs no mail credentials.
  await notificationService.requeueNotification(id, { templateVersion: V, expectedVersion: version, send: false });
}
```

* `version` is the `Communication`'s `meta.versionId`. `expectedVersion` makes the backend refuse
  with `NotificationActionError` reason `CHANGED`, writing nothing, when the notification is at
  another version.
* `repinNotification` and `requeueNotification` both write with `If-Match` on the version they
  read, with or without `expectedVersion`, so a notification that changes between that read and the
  write is refused with `CHANGED` too, instead of being overwritten.
* `requeueNotification(id, { templateVersion })` changes the status and the
  `requested-template-version` identifier in one update.
* Moving notifications changes which ones match, so list again from page 0 rather than moving on to
  the next page.

`getActionCapabilities()` reports all four optional actions (`repin.expectedVersion`,
`requeue.expectedVersion`, `requeue.templateVersion`, `versions.filter`).

### Canceling Notifications

```typescript
// Cancel a scheduled notification
await notificationService.cancelNotification(notificationId);
```

## Healthcare Integration

This implementation is designed for healthcare applications and integrates naturally with Medplum's FHIR-based infrastructure.

### Linking Notifications to Patients

```typescript
// Create notification linked to a patient
await notificationService.createNotification({
  userId: 'Patient/123',  // FHIR Patient reference
  notificationType: 'EMAIL',
  contextName: 'medication-reminder',
  contextParameters: {
    medicationName: 'Aspirin',
    dosage: '100mg',
  },
  // ...
});
```

### Linking Notifications to Practitioners

```typescript
// Notify a healthcare provider
await notificationService.createNotification({
  userId: 'Practitioner/456',  // FHIR Practitioner reference
  notificationType: 'EMAIL',
  contextName: 'new-patient-alert',
  // ...
});
```

### Searching Notifications by Resource

```typescript
// Get all notifications for a patient
const communications = await medplum.searchResources('Communication', {
  _tag: 'notification',
  recipient: 'Patient/123',
});
```

## Features

### ✅ Supported Features

- Email notifications via Medplum's email API
- File attachments using FHIR Binary and Media resources
- One-off notifications (no user account required)
- Scheduled notifications (send later)
- Notification templates with context parameters
- File deduplication via checksum
- Attachment cleanup for orphaned files
- FHIR-compliant data storage

### ❌ Not Yet Supported

- SMS notifications (Medplum limitation)
- Push notifications (Medplum limitation)
- In-app notification UI
- Real-time notification delivery (requires polling or webhooks)

## API Reference

### MedplumNotificationBackend

```typescript
class MedplumNotificationBackend<Config extends BaseNotificationTypeConfig>
```

Main backend for storing notifications as FHIR Communication resources.

**Constructor:**
```typescript
constructor(
  medplum: MedplumClient,
  options?: {
    emailNotificationSubjectExtensionUrl?: string;
  }
)
```

**Key Methods:**
- `persistNotification(notification)` - Create a new notification
- `persistOneOffNotification(notification)` - Create a one-off notification
- `getNotification(id)` - Retrieve a notification by ID
- `getPendingNotifications(page, pageSize)` - Get notifications ready to send
- `markAsSent(id)` - Mark notification as successfully sent
- `markAsFailed(id)` - Mark notification as failed
- `cancelNotification(id)` - Cancel a scheduled notification
- `filterNotificationVersions(filter, page, pageSize)` - IDs and version tokens only, without reading content
- `repinNotification(id, templateVersion, { expectedVersion? })` - Re-pin in one conditional update
- `requeueNotification(id, { sendAfter?, templateVersion?, expectedVersion? })` - Re-queue, optionally re-pinning, in one conditional update

### MedplumNotificationAdapter

```typescript
class MedplumNotificationAdapter<
  TemplateRenderer extends BaseEmailTemplateRenderer<Config>,
  Config extends BaseNotificationTypeConfig
>
```

Adapter for sending email notifications via Medplum.

**Constructor:**
```typescript
constructor(
  medplum: MedplumClient,
  templateRenderer: TemplateRenderer
)
```

**Properties:**
- `supportsAttachments: boolean` - Returns `true`

**Key Methods:**
- `send(notification, context)` - Send an email notification with attachments

### PugInlineEmailTemplateRenderer

```typescript
class PugInlineEmailTemplateRenderer<Config extends BaseNotificationTypeConfig>
  implements BaseEmailTemplateRenderer<Config>
```

Template renderer that compiles Pug templates from pre-compiled JSON strings instead of reading from file paths. This is ideal for production deployments where templates are embedded in the application.

**Constructor:**
```typescript
constructor(generatedTemplates: Record<string, string>)
```

**Parameters:**
- `generatedTemplates` - Object mapping template paths to template content strings (generated by `compile-pug-templates` script)

**Key Methods:**
- `render(notification, context)` - Compile and render both subject and body templates using the notification's template paths

**Example:**
```typescript
import compiledTemplates from './compiled-templates.json';

const renderer = new PugInlineEmailTemplateRenderer(compiledTemplates);
const adapter = new MedplumNotificationAdapter(medplum, renderer);
```

### MedplumAttachmentManager

```typescript
class MedplumAttachmentManager extends BaseAttachmentManager
```

Manages file attachments using FHIR Binary and Media resources.

**Constructor:**
```typescript
constructor(medplum: MedplumClient)
```

**Key Methods:**
- `uploadFile(file, filename, contentType?)` - Upload a file to Medplum storage
- `getFile(fileId)` - Retrieve file metadata by Media resource ID
- `deleteFile(fileId)` - Delete file and its Binary resource
- `reconstructAttachmentFile(storageMetadata)` - Create AttachmentFile from metadata

### MedplumAttachmentFile

```typescript
class MedplumAttachmentFile implements AttachmentFile
```

Provides access to files stored in FHIR Binary resources.

**Methods:**
- `read()` - Read entire file into a Buffer
- `stream()` - Get a ReadableStream for the file
- `url(expiresIn?)` - Generate URL for file access
- `delete()` - Delete the file from storage

## Best Practices

### 1. Template Organization

Organize your templates in a clear directory structure:

```
templates/
  subjects/           # Email subject templates
    welcome.pug
    order-confirmation.pug
  bodies/            # Or organize by feature
    welcome.pug
    order-confirmation.pug
  notifications/     # Group related templates
    orders/
      confirmation.pug
      shipped.pug
    users/
      welcome.pug
      password-reset.pug
```

### 2. Template Naming Conventions

Use consistent, descriptive names:
```typescript
// ✅ Good - clear and descriptive
bodyTemplate: 'notifications/orders/confirmation.pug'
subjectTemplate: 'subjects/order-confirmation.pug'

// ❌ Bad - unclear purpose
bodyTemplate: 'template1.pug'
subjectTemplate: 'subj.pug'
```

### 3. Template Variables

Document the expected context variables in each template:

```pug
//- templates/welcome.pug
//- Expected variables: firstName, lastName, loginUrl
doctype html
html
  body
    h1 Welcome #{firstName} #{lastName}!
    a(href=loginUrl) Login to your account
```

### 4. Compilation in Build Process

Add template compilation to your build pipeline:

```json
{
  "scripts": {
    "compile-templates": "compile-pug-templates ./templates ./src/compiled-templates.json",
    "build": "npm run compile-templates && tsc"
  }
}
```

This ensures templates are always compiled before building your application.

### 5. Use FHIR References Consistently

Always use proper FHIR reference format for user IDs:

```typescript
// ✅ Good
userId: 'Patient/123'
userId: 'Practitioner/456'

// ❌ Bad
userId: '123'
userId: 'user-456'
```

### 6. Configure Custom Extension URLs

Use your own domain for extension URLs in production:

```typescript
const backend = new MedplumNotificationBackend(medplum, {
  emailNotificationSubjectExtensionUrl: 'http://your-domain.com/fhir/email-subject',
});
```

### 7. Handle Large Attachments Carefully

For large files, consider:
- Using file size limits
- Implementing file compression
- Using streaming for file operations

```typescript
// Check file size before upload
const maxSize = 10 * 1024 * 1024; // 10MB
if (buffer.length > maxSize) {
  throw new Error('File too large');
}
```

### 8. Clean Up Orphaned Files

Regularly run cleanup to remove orphaned attachment files:

```typescript
// Get orphaned files
const orphaned = await backend.getOrphanedAttachmentFiles();

// Delete them
for (const file of orphaned) {
  await backend.deleteAttachmentFile(file.id);
}
```

### 9. Use Pagination

Always paginate when fetching large result sets:

```typescript
// ✅ Good
const notifications = await notificationService.getPendingNotifications(0, 50);

// ❌ Bad - could return thousands of records
const notifications = await notificationService.getAllPendingNotifications();
```

## License

MIT

## Support

For issues and questions:
- VintaSend: [GitHub Issues](https://github.com/vintasoftware/vintasend-ts/issues)
- Medplum: [Documentation](https://www.medplum.com/docs)
