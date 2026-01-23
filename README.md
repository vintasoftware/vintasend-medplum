# VintaSend Medplum Implementation

A complete VintaSend implementation using [Medplum](https://www.medplum.com/) as the backend, leveraging FHIR resources for notification management, file storage, and healthcare integration.

## Overview

This implementation uses FHIR (Fast Healthcare Interoperability Resources) standards to store and manage notifications, making it ideal for healthcare applications that need to integrate notifications with patient care workflows.

### Key Components

- **MedplumNotificationBackend**: Stores notifications as FHIR `Communication` resources
- **MedplumNotificationAdapter**: Sends email notifications via Medplum's email API
- **MedplumAttachmentManager**: Manages file attachments using FHIR `Binary` and `Media` resources
- **InlineTemplateRenderer**: Renders Pug email templates from pre-compiled JSON (ideal for production)
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
  InlineTemplateRenderer,
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
const renderer = new InlineTemplateRenderer(compiledTemplates);
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
  meta: {
    tag: [
      { code: "notification" },
      { code: "user-welcome" },      // contextName
      { code: "EMAIL" }              // notificationType
    ]
  }
}
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
npx compile-pug-templates <input-directory> <output-file>
```

Example:
```bash
# Compile all .pug files from ./templates to ./src/compiled-templates.json
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
import { InlineTemplateRenderer } from 'vintasend-medplum';
import compiledTemplates from './compiled-templates.json';

// Create the template renderer with compiled templates
const templateRenderer = new InlineTemplateRenderer(compiledTemplates);

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

### InlineTemplateRenderer

```typescript
class InlineTemplateRenderer<Config extends BaseNotificationTypeConfig>
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

const renderer = new InlineTemplateRenderer(compiledTemplates);
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
