import * as pug from 'pug';
import { BaseEmailTemplateRenderer } from 'vintasend';
import type { JsonObject } from 'vintasend/dist/types/json-values';
import type { DatabaseNotification } from 'vintasend/dist/types/notification';
import type { BaseNotificationTypeConfig } from 'vintasend/dist/types/notification-type-config';
import type { BaseLogger } from 'vintasend/dist/services/loggers/base-logger';


/**
 * Custom email template renderer that compiles Pug templates from strings
 * instead of reading from file paths.
 *
 * This is necessary for bot deployments where templates are embedded as constants
 * rather than separate files.
 */
export class PugInlineEmailTemplateRenderer<Config extends BaseNotificationTypeConfig>
  implements BaseEmailTemplateRenderer<Config>
{
  private templates: Record<string, string>;
  private logger: BaseLogger | null = null;

  constructor(generatedTemplates: Record<string, string>) {
    this.templates = generatedTemplates;
  }

  /**
   * Inject logger (called by VintaSend when logger exists)
   */
  injectLogger(logger: BaseLogger): void {
    this.logger = logger;
  }

  async render(
    notification: DatabaseNotification<Config>,
    context: JsonObject
  ): Promise<{ subject: string; body: string }> {
    // Check if body template is provided
    const bodyTemplateKey = notification.bodyTemplate;
    if (!bodyTemplateKey) {
      throw new Error('Body template is required');
    }
    if (!(bodyTemplateKey in this.templates)) {
      throw new Error(`Body template "${bodyTemplateKey}" not found in templates`);
    }

    // Check if subject template is provided
    const subjectTemplateKey = notification.subjectTemplate;
    if (!subjectTemplateKey) {
      throw new Error('Subject template is required');
    }
    if (!(subjectTemplateKey in this.templates)) {
      throw new Error(`Subject template "${subjectTemplateKey}" not found in templates`);
    }

    let body: string;
    try {
      // Compile and render the body template from string
      const bodyTemplate = pug.compile(this.templates[bodyTemplateKey]);
      body = bodyTemplate(context);
    } catch (error) {
      if (this.logger) {
        this.logger.error('[PugInlineEmailTemplateRenderer] Error rendering body template');
      }
      throw error;
    }

    let subject: string;
    try {
      // Compile and render the subject template from string
      const subjectTemplate = pug.compile(this.templates[subjectTemplateKey]);
      subject = subjectTemplate(context);
    } catch (error) {
      if (this.logger) {
        this.logger.error('[PugInlineEmailTemplateRenderer] Error rendering subject template');
      }
      throw error;
    }

    return { subject, body };
  }
}

export class PugInlineEmailTemplateRendererFactory<Config extends BaseNotificationTypeConfig> {
  create(generatedTemplates: Record<string, string>): PugInlineEmailTemplateRenderer<Config> {
    return new PugInlineEmailTemplateRenderer<Config>(generatedTemplates);
  }
}
