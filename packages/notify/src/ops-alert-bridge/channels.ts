import type {
  AlertChannel,
  CanonicalAlert,
  ChannelSendResult,
  DiscordChannelOptions,
  SlackChannelOptions,
  TelegramChannelOptions,
} from './types';

import { escapeHtml } from '../formatters';

export { escapeHtml };

/**
 * Robust fetch wrapper with configurable retries, exponential backoff, and timeout.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  config: {
    retries?: number;
    timeoutMs?: number;
    customFetch?: typeof fetch;
  } = {}
): Promise<Response> {
  const retries = config.retries ?? 2;
  const timeoutMs = config.timeoutMs ?? 10000;
  const fetchFn = config.customFetch ?? fetch;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutTimer);

      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return response;
      }

      // Retry on 5xx or 429 (rate-limit)
      lastError = new Error(`HTTP Error ${response.status}: ${await response.text().catch(() => '')}`);
    } catch (err) {
      clearTimeout(timeoutTimer);
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < retries) {
      const delay = 150 * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Request failed after max retries');
}

/**
 * Telegram Alert Channel
 * Formats alerts into Telegram HTML messages and sends via Telegram Bot API.
 */
export class TelegramChannel implements AlertChannel {
  public readonly name = 'telegram';

  constructor(private readonly options: TelegramChannelOptions) {
    if (!options.botToken) throw new Error('Telegram botToken is required');
    if (!options.chatId) throw new Error('Telegram chatId is required');
  }

  public async send(alerts: CanonicalAlert[]): Promise<ChannelSendResult[]> {
    const results: ChannelSendResult[] = [];
    const apiUrl = `https://api.telegram.org/bot${this.options.botToken}/sendMessage`;

    for (const alert of alerts) {
      const text = this.formatAlertHtml(alert);

      const payload: Record<string, unknown> = {
        chat_id: this.options.chatId,
        text,
        parse_mode: this.options.parseMode || 'HTML',
        disable_web_page_preview: this.options.disableWebPagePreview ?? true,
      };

      if (this.options.messageThreadId) {
        payload.message_thread_id = this.options.messageThreadId;
      }

      try {
        const res = await fetchWithRetry(
          apiUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          {
            retries: this.options.retries,
            timeoutMs: this.options.timeoutMs,
            customFetch: this.options.customFetch,
          }
        );

        results.push({
          channel: this.name,
          success: res.ok,
          alertId: alert.id,
          statusCode: res.status,
          error: res.ok ? undefined : `Telegram API returned status ${res.status}`,
        });
      } catch (err) {
        results.push({
          channel: this.name,
          success: false,
          alertId: alert.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  public formatAlertHtml(alert: CanonicalAlert): string {
    const prefix = this.options.headerPrefix ? `${this.options.headerPrefix} ` : '';
    const statusIcon = alert.status === 'firing' ? '🔴' : '✅';
    const statusText = alert.status.toUpperCase();
    const severityBadge = alert.severity.toUpperCase();

    const lines: string[] = [
      `${statusIcon} <b>${prefix}[${statusText}] ${escapeHtml(alert.title)}</b>`,
      '',
      `<b>Severity:</b> <code>${severityBadge}</code>`,
      `<b>Service:</b> <code>${escapeHtml(alert.service || 'infra')}</code>`,
      `<b>Source:</b> <code>${escapeHtml(alert.source)}</code>`,
      `<b>Started:</b> <code>${escapeHtml(alert.startsAt)}</code>`,
    ];

    if (alert.endsAt) {
      lines.push(`<b>Ended:</b> <code>${escapeHtml(alert.endsAt)}</code>`);
    }

    lines.push('', `<b>Summary:</b> ${escapeHtml(alert.summary)}`);

    if (alert.description && alert.description !== alert.summary) {
      lines.push('', `<b>Description:</b>\n<pre>${escapeHtml(alert.description)}</pre>`);
    }

    if (alert.url) {
      lines.push('', `🔗 <a href="${escapeHtml(alert.url)}">View Dashboard / Runbook</a>`);
    }

    return lines.join('\n');
  }
}

/**
 * Discord Alert Channel
 * Formats alerts into Discord Webhook Rich Embeds.
 */
export class DiscordChannel implements AlertChannel {
  public readonly name = 'discord';

  constructor(private readonly options: DiscordChannelOptions) {
    if (!options.webhookUrl) throw new Error('Discord webhookUrl is required');
  }

  public async send(alerts: CanonicalAlert[]): Promise<ChannelSendResult[]> {
    const results: ChannelSendResult[] = [];

    for (const alert of alerts) {
      const embed = this.formatEmbed(alert);
      const payload: Record<string, unknown> = {
        username: this.options.username || 'Ops Alert Bridge',
        embeds: [embed],
      };

      if (this.options.avatarUrl) {
        payload.avatar_url = this.options.avatarUrl;
      }

      try {
        const res = await fetchWithRetry(
          this.options.webhookUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          {
            retries: this.options.retries,
            timeoutMs: this.options.timeoutMs,
            customFetch: this.options.customFetch,
          }
        );

        results.push({
          channel: this.name,
          success: res.ok,
          alertId: alert.id,
          statusCode: res.status,
          error: res.ok ? undefined : `Discord webhook returned status ${res.status}`,
        });
      } catch (err) {
        results.push({
          channel: this.name,
          success: false,
          alertId: alert.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  public formatEmbed(alert: CanonicalAlert): Record<string, unknown> {
    // Colors: Red 0xDC2626 (firing/critical), Orange 0xF59E0B (warning), Green 0x16A34A (resolved), Blue 0x3B82F6 (info)
    let color = 0x16A34A;
    if (alert.status === 'firing') {
      color = alert.severity === 'critical' ? 0xDC2626 : 0xF59E0B;
    }

    const fields = [
      { name: 'Status', value: alert.status.toUpperCase(), inline: true },
      { name: 'Severity', value: alert.severity.toUpperCase(), inline: true },
      { name: 'Service', value: alert.service || 'infra', inline: true },
      { name: 'Source', value: alert.source, inline: true },
      { name: 'Starts At', value: alert.startsAt, inline: true },
    ];

    if (alert.endsAt) {
      fields.push({ name: 'Ends At', value: alert.endsAt, inline: true });
    }

    return {
      title: alert.title,
      description: alert.summary + (alert.description && alert.description !== alert.summary ? `\n\n${alert.description}` : ''),
      color,
      fields,
      url: alert.url,
      timestamp: alert.startsAt,
      footer: {
        text: 'KT Portfolio Ops Alert Bridge',
      },
    };
  }
}

/**
 * Slack Alert Channel
 * Formats alerts into Slack Block Kit and attachments.
 */
export class SlackChannel implements AlertChannel {
  public readonly name = 'slack';

  constructor(private readonly options: SlackChannelOptions) {
    if (!options.webhookUrl) throw new Error('Slack webhookUrl is required');
  }

  public async send(alerts: CanonicalAlert[]): Promise<ChannelSendResult[]> {
    const results: ChannelSendResult[] = [];

    for (const alert of alerts) {
      const payload = this.formatPayload(alert);

      try {
        const res = await fetchWithRetry(
          this.options.webhookUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          {
            retries: this.options.retries,
            timeoutMs: this.options.timeoutMs,
            customFetch: this.options.customFetch,
          }
        );

        results.push({
          channel: this.name,
          success: res.ok,
          alertId: alert.id,
          statusCode: res.status,
          error: res.ok ? undefined : `Slack webhook returned status ${res.status}`,
        });
      } catch (err) {
        results.push({
          channel: this.name,
          success: false,
          alertId: alert.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  public formatPayload(alert: CanonicalAlert): Record<string, unknown> {
    const color = alert.status === 'firing'
      ? (alert.severity === 'critical' ? '#DC2626' : '#F59E0B')
      : '#16A34A';

    const blocks: unknown[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: alert.title.slice(0, 150),
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Summary:* ${alert.summary}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Status:*\n\`${alert.status.toUpperCase()}\`` },
          { type: 'mrkdwn', text: `*Severity:*\n\`${alert.severity.toUpperCase()}\`` },
          { type: 'mrkdwn', text: `*Service:*\n\`${alert.service || 'infra'}\`` },
          { type: 'mrkdwn', text: `*Source:*\n\`${alert.source}\`` },
        ],
      },
    ];

    if (alert.url) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Dashboard', emoji: true },
            url: alert.url,
            style: alert.status === 'firing' ? 'danger' : 'primary',
          },
        ],
      });
    }

    return {
      username: this.options.username || 'Ops Alert Bridge',
      icon_emoji: this.options.iconEmoji || (alert.status === 'firing' ? ':rotating_light:' : ':white_check_mark:'),
      channel: this.options.channel,
      attachments: [
        {
          color,
          blocks,
        },
      ],
    };
  }
}
