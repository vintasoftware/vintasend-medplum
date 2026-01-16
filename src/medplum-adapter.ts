import type { MedplumClient } from '@medplum/core';
import type { BaseEmailTemplateRenderer } from 'vintasend/dist/services/notification-template-renderers/base-email-template-renderer';
import { BaseNotificationAdapter } from 'vintasend/dist/services/notification-adapters/base-notification-adapter';
import type { JsonObject } from 'vintasend/dist/types/json-values';
import type { AnyDatabaseNotification } from 'vintasend/dist/types/notification';
import type { BaseNotificationTypeConfig } from 'vintasend/dist/types/notification-type-config';
import type { StoredAttachment } from 'vintasend/dist/types/attachment';

export class MedplumNotificationAdapter<
  TemplateRenderer extends BaseEmailTemplateRenderer<Config>,
  Config extends BaseNotificationTypeConfig,
> extends BaseNotificationAdapter<TemplateRenderer, Config> {
  public key: string | null = 'medplum-email';

  constructor(
    private medplum: MedplumClient,
    templateRenderer: TemplateRenderer,
  ) {
    const notificationType = 'EMAIL';
    super(templateRenderer, notificationType, false);
  }

  get supportsAttachments(): boolean {
    return true;
  }

  async send(notification: AnyDatabaseNotification<Config>, context: JsonObject): Promise<void> {
    if (!this.backend) {
      throw new Error('Backend not injected');
    }

    if (!notification.id) {
      throw new Error('Notification ID is required');
    }

    // Use the helper method to get recipient email (handles both regular and one-off notifications)
    const recipientEmail = await this.getRecipientEmail(notification);

    const template = await this.templateRenderer.render(notification, context);

    const emailOptions: {
      to: string;
      subject: string;
      text: string;
      attachments?: Array<{
        filename: string;
        content: string;
        contentType: string;
      }>;
    } = {
      to: recipientEmail,
      subject: template.subject,
      text: template.body,
    };

    // Add attachments if present
    // Type assertion needed because npm version may not have attachments field yet
    const notificationWithAttachments = notification as AnyDatabaseNotification<Config> & {
      attachments?: StoredAttachment[];
    };

    if (notificationWithAttachments.attachments && notificationWithAttachments.attachments.length > 0) {
      emailOptions.attachments = await this.prepareAttachments(notificationWithAttachments.attachments);
    }

    await this.medplum.sendEmail(emailOptions);
  }

  protected async prepareAttachments(
    attachments: StoredAttachment[],
  ): Promise<Array<{
    filename: string;
    content: string;
    contentType: string;
  }>> {
    return Promise.all(
      attachments.map(async (att) => {
        const buffer = await att.file.read();
        return {
          filename: att.filename,
          content: buffer.toString('base64'),
          contentType: att.contentType,
        };
      })
    );
  }
}
