import { z } from 'zod';

export const EmailMessageSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email())]),
  from: z.string().min(1),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().optional(),
  cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
  replyTo: z.string().email().optional(),
  tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});
export type EmailMessage = z.infer<typeof EmailMessageSchema>;

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  provider: 'MOCK' | 'RESEND' | 'SENDGRID';
  error?: string;
}

export interface IEmailAdapter {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * In-memory Mock Email Adapter for automated tests and offline development
 */
export class MockEmailAdapter implements IEmailAdapter {
  private sentMessages: Array<{ message: EmailMessage; sentAt: Date; id: string }> = [];

  public async send(message: EmailMessage): Promise<EmailSendResult> {
    const valid = EmailMessageSchema.parse(message);
    const id = `mock_mail_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    this.sentMessages.push({
      message: valid,
      sentAt: new Date(),
      id,
    });

    return {
      success: true,
      messageId: id,
      provider: 'MOCK',
    };
  }

  public getSentMessages(): Array<{ message: EmailMessage; sentAt: Date; id: string }> {
    return [...this.sentMessages];
  }

  public clear(): void {
    this.sentMessages = [];
  }
}

/**
 * Resend Email API Adapter (https://resend.com)
 */
export class ResendEmailAdapter implements IEmailAdapter {
  private apiKey?: string;
  private defaultFrom: string;
  private endpoint = 'https://api.resend.com/emails';

  constructor(options?: { apiKey?: string; defaultFrom?: string }) {
    this.apiKey = options?.apiKey;
    this.defaultFrom = options?.defaultFrom ?? 'T-RED Media <contact@tred.vn>';
  }

  public async send(message: EmailMessage): Promise<EmailSendResult> {
    const valid = EmailMessageSchema.parse({
      ...message,
      from: message.from || this.defaultFrom,
    });

    if (!this.apiKey) {
      // In dev/test when no key is set, log and return mock success
      return {
        success: true,
        messageId: `resend_simulated_${Date.now()}`,
        provider: 'RESEND',
      };
    }

    try {
      const toArray = Array.isArray(valid.to) ? valid.to : [valid.to];
      const payload: Record<string, unknown> = {
        from: valid.from,
        to: toArray,
        subject: valid.subject,
        html: valid.html,
      };

      if (valid.text) payload.text = valid.text;
      if (valid.replyTo) payload.reply_to = valid.replyTo;
      if (valid.cc) payload.cc = Array.isArray(valid.cc) ? valid.cc : [valid.cc];
      if (valid.bcc) payload.bcc = Array.isArray(valid.bcc) ? valid.bcc : [valid.bcc];
      if (valid.tags) payload.tags = valid.tags;

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          success: false,
          provider: 'RESEND',
          error: `Resend API Error (${res.status}): ${errText}`,
        };
      }

      const json = (await res.json()) as { id: string };
      return {
        success: true,
        messageId: json.id,
        provider: 'RESEND',
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        provider: 'RESEND',
        error: errorMsg,
      };
    }
  }
}

/**
 * Twilio SendGrid v3 API Adapter (https://sendgrid.com)
 */
export class SendGridEmailAdapter implements IEmailAdapter {
  private apiKey?: string;
  private defaultFrom: string;
  private endpoint = 'https://api.sendgrid.com/v3/mail/send';

  constructor(options?: { apiKey?: string; defaultFrom?: string }) {
    this.apiKey = options?.apiKey;
    this.defaultFrom = options?.defaultFrom ?? 'contact@tred.vn';
  }

  public async send(message: EmailMessage): Promise<EmailSendResult> {
    const valid = EmailMessageSchema.parse({
      ...message,
      from: message.from || this.defaultFrom,
    });

    if (!this.apiKey) {
      return {
        success: true,
        messageId: `sendgrid_simulated_${Date.now()}`,
        provider: 'SENDGRID',
      };
    }

    try {
      const toEmails = (Array.isArray(valid.to) ? valid.to : [valid.to]).map((email) => ({
        email,
      }));

      const personalizations: Array<{ to: Array<{ email: string }>; subject?: string }> = [
        {
          to: toEmails,
          subject: valid.subject,
        },
      ];

      const content: Array<{ type: string; value: string }> = [
        { type: 'text/html', value: valid.html },
      ];

      if (valid.text) {
        content.unshift({ type: 'text/plain', value: valid.text });
      }

      const payload = {
        personalizations,
        from: { email: valid.from.replace(/.*<([^>]+)>.*/, '$1') },
        subject: valid.subject,
        content,
      };

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok && res.status !== 202) {
        const errText = await res.text();
        return {
          success: false,
          provider: 'SENDGRID',
          error: `SendGrid API Error (${res.status}): ${errText}`,
        };
      }

      const messageId = res.headers.get('x-message-id') ?? `sg_${Date.now()}`;
      return {
        success: true,
        messageId,
        provider: 'SENDGRID',
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        provider: 'SENDGRID',
        error: errorMsg,
      };
    }
  }
}
