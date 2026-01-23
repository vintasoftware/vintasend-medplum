import * as pug from 'pug';
import { BaseEmailTemplateRenderer } from 'vintasend';
import type { JsonObject } from 'vintasend/dist/types/json-values';
import type { DatabaseNotification } from 'vintasend/dist/types/notification';
import type { BaseNotificationTypeConfig } from 'vintasend/dist/types/notification-type-config';


function getTemplateNameFromPath(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/**
 * Custom email template renderer that compiles Pug templates from strings
 * instead of reading from file paths.
 *
 * This is necessary for bot deployments where templates are embedded as constants
 * rather than separate files.
 */
export class InlineTemplateRenderer<Config extends BaseNotificationTypeConfig>
  implements BaseEmailTemplateRenderer<Config>
{
  private templates: Record<string, string>;

  constructor(generatedTemplates: Record<string, string>) {
    this.templates = generatedTemplates;
  }

  async render(
    notification: DatabaseNotification<Config>,
    context: JsonObject
  ): Promise<{ subject: string; body: string }> {
    try {
      // Compile and render the body template from string
      const bodyTemplate = pug.compile(this.templates[notification.bodyTemplate || ''] || '');
      const body = bodyTemplate(context);

      // Compile and render the subject template from string
      const subjectTemplate = pug.compile(this.templates[notification.subjectTemplate || ''] || '');
      const subject = subjectTemplate(context);

      return { subject, body };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[InlineTemplateRenderer] Error rendering templates:', error);
      throw error;
    }
  }
}

export class InlineTemplateRendererFactory<Config extends BaseNotificationTypeConfig> {
  create(generatedTemplates: Record<string, string>): BaseEmailTemplateRenderer<Config> {
    return new InlineTemplateRenderer<Config>(generatedTemplates);
  }
}
