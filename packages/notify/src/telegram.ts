import {
  formatAppointmentNotificationHtml,
  formatOrderNotificationHtml,
  formatSystemAlertHtml,
} from './formatters';
import {
  AppointmentNotificationPayload,
  OrderNotificationPayload,
  SystemAlertPayload,
  TelegramConfig,
  TelegramSendOptions,
  TelegramSendResult,
} from './types';

/**
 * Sends a message to a Telegram chat via Telegram Bot API using standard fetch
 */
export async function sendTelegramMessage(options: TelegramSendOptions): Promise<TelegramSendResult> {
  const { botToken, chatId, text, parseMode = 'HTML', disableWebPagePreview = true } = options;

  if (!botToken) {
    return {
      success: false,
      error: 'Telegram Bot Token is required',
    };
  }

  if (!chatId) {
    return {
      success: false,
      error: 'Telegram Chat ID is required',
    };
  }

  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: disableWebPagePreview,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const data = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };

    if (!data.ok) {
      return {
        success: false,
        error: data.description || `HTTP ${res.status}: Failed to send Telegram message`,
      };
    }

    return {
      success: true,
      messageId: data.result?.message_id,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Network/Telegram API error: ${errorMessage}`,
    };
  }
}

/**
 * High-level Telegram Notifier Client
 */
export class TelegramNotifier {
  private botToken: string;
  private defaultChatId?: string | number;

  constructor(config: TelegramConfig) {
    this.botToken = config.botToken;
    this.defaultChatId = config.defaultChatId;
  }

  /**
   * Send Order Notification to Shop Owner / Staff
   */
  async notifyOrder(
    payload: OrderNotificationPayload,
    chatId?: string | number
  ): Promise<TelegramSendResult> {
    const targetChatId = chatId ?? this.defaultChatId;
    if (!targetChatId) {
      return { success: false, error: 'Chat ID must be provided' };
    }

    const html = formatOrderNotificationHtml(payload);
    return sendTelegramMessage({
      botToken: this.botToken,
      chatId: targetChatId,
      text: html,
      parseMode: 'HTML',
    });
  }

  /**
   * Send Spa / Clinic Appointment Notification
   */
  async notifyAppointment(
    payload: AppointmentNotificationPayload,
    chatId?: string | number
  ): Promise<TelegramSendResult> {
    const targetChatId = chatId ?? this.defaultChatId;
    if (!targetChatId) {
      return { success: false, error: 'Chat ID must be provided' };
    }

    const html = formatAppointmentNotificationHtml(payload);
    return sendTelegramMessage({
      botToken: this.botToken,
      chatId: targetChatId,
      text: html,
      parseMode: 'HTML',
    });
  }

  /**
   * Send System Health / Error Alert to Dev / Ops Team
   */
  async notifyAlert(
    payload: SystemAlertPayload,
    chatId?: string | number
  ): Promise<TelegramSendResult> {
    const targetChatId = chatId ?? this.defaultChatId;
    if (!targetChatId) {
      return { success: false, error: 'Chat ID must be provided' };
    }

    const html = formatSystemAlertHtml(payload);
    return sendTelegramMessage({
      botToken: this.botToken,
      chatId: targetChatId,
      text: html,
      parseMode: 'HTML',
    });
  }

  /**
   * Send raw message
   */
  async sendMessage(
    text: string,
    options: Partial<TelegramSendOptions> = {}
  ): Promise<TelegramSendResult> {
    const targetChatId = options.chatId ?? this.defaultChatId;
    if (!targetChatId) {
      return { success: false, error: 'Chat ID must be provided' };
    }

    return sendTelegramMessage({
      botToken: this.botToken,
      chatId: targetChatId,
      text,
      parseMode: options.parseMode || 'HTML',
      disableWebPagePreview: options.disableWebPagePreview,
    });
  }
}

export function createTelegramNotifier(config: TelegramConfig): TelegramNotifier {
  return new TelegramNotifier(config);
}
