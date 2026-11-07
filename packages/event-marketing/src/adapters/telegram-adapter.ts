import { z } from 'zod';
import { EventDetails, EventRoiTelemetry } from '../types';
import { formatVndCurrency } from '../roi-calculator';

export const TelegramPayloadSchema = z.object({
  chat_id: z.union([z.string(), z.number()]),
  text: z.string().min(1),
  parse_mode: z.enum(['Markdown', 'MarkdownV2', 'HTML']).default('Markdown'),
  disable_web_page_preview: z.boolean().default(false),
});
export type TelegramPayload = z.infer<typeof TelegramPayloadSchema>;

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  description?: string;
}

export class TelegramAdapter {
  private sentMessages: Array<{ payload: TelegramPayload; sentAt: Date }> = [];
  private botToken?: string;
  private defaultChatId?: string | number;

  constructor(options?: { botToken?: string; defaultChatId?: string | number }) {
    this.botToken = options?.botToken;
    this.defaultChatId = options?.defaultChatId;
  }

  /**
   * Format Markdown briefing for Crew & Ops Team (T-24h Call-Time)
   */
  public formatCrewBriefingMarkdown(
    event: EventDetails,
    options?: { timeZone?: string }
  ): string {
    const tz = options?.timeZone ?? 'Asia/Ho_Chi_Minh';
    const venueName = event.venue?.name ?? 'Chưa cập nhật sảnh';
    const venueAddress = event.venue?.address ? `\n📍 *Địa chỉ:* ${event.venue.address}` : '';
    const mapLink = event.venue?.mapUrl ? `\n🗺️ *Bản đồ:* [Google Maps](${event.venue.mapUrl})` : '';

    const callTimeStr = event.callTime
      ? new Date(event.callTime).toLocaleTimeString('vi-VN', {
          timeZone: tz,
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'Trước giờ show 90p';

    const eventDateStr = new Date(event.eventDate).toLocaleDateString('vi-VN', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    let crewListStr = '_Chưa phân bổ nhân sự_';
    if (event.assignedCrew && event.assignedCrew.length > 0) {
      crewListStr = event.assignedCrew
        .map((c, i) => `${i + 1}. *${c.name}* (${c.role}) - 📞 \`${c.phone}\``)
        .join('\n');
    }

    return (
      `🚨 *[THÔNG BÁO T-24H] ĐIỀU PHỐI EKIP SỰ KIỆN*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎪 *Sự kiện:* ${event.name}\n` +
      `🏢 *Khách hàng:* ${event.clientName}${event.clientCompany ? ` (${event.clientCompany})` : ''}\n` +
      `📅 *Ngày diễn ra:* ${eventDateStr}\n` +
      `⏰ *CALL-TIME TẬP TRUNG:* \`${callTimeStr}\`\n` +
      `🏛️ *Địa điểm:* *${venueName}*${venueAddress}${mapLink}\n\n` +
      `👥 *DANH SÁCH EKIP PHỤ TRÁCH:*\n` +
      `${crewListStr}\n\n` +
      `📋 *CHECKLIST KỸ THUẬT:*\n` +
      `• Kiểm tra cuộn giấy in DNP & mực dự phòng (> 500 ảnh)\n` +
      `• Kiểm tra đường truyền 4G/Wifi & iPad Live Gallery\n` +
      `• Đồng phục T-RED chỉnh tề, có mặt đúng giờ quy định!\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    );
  }

  /**
   * Format Executive ROI Telemetry brief for Management (T+24h)
   */
  public formatRoiReportMarkdown(
    event: EventDetails,
    roi: EventRoiTelemetry
  ): string {
    const cpiFormatted = formatVndCurrency(roi.costPerImpressionVnd);
    const cplFormatted = formatVndCurrency(roi.costPerLeadVnd);

    return (
      `📊 *[TELEMETRY T+24H] BÁO CÁO HIỆU QUẢ SỰ KIỆN*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎪 *Sự kiện:* ${event.name}\n` +
      `🏢 *Nhãn hàng đối tác:* ${event.clientName}${event.clientCompany ? ` (${event.clientCompany})` : ''}\n\n` +
      `📈 *CHỈ SỐ TƯƠNG TÁC THỰC TẾ:*\n` +
      `• 🎯 *Tổng điểm chạm thương hiệu:* \`${roi.totalInteractions.toLocaleString('vi-VN')}\`\n` +
      `• 📸 *Lượt quay/chụp:* \`${roi.totalSessions.toLocaleString('vi-VN')}\` sessions\n` +
      `• 🖨️ *Ảnh in lấy liền:* \`${roi.totalPhotosPrinted.toLocaleString('vi-VN')}\` bản\n` +
      `• 📲 *Lượt quét QR Cloud Gallery:* \`${roi.qrScans.toLocaleString('vi-VN')}\` scans\n` +
      `• 📥 *Data Lead thu thập:* \`${roi.leadsCaptured.toLocaleString('vi-VN')}\` contacts (CVR: *${roi.conversionRatePercent}%*)\n\n` +
      `🚀 *LAN TỎA MXH & HIỆU SUẤT ĐẦU TƯ:*\n` +
      `• 🌐 *Viral Social Reach (ước tính):* \`${roi.estimatedSocialReach.toLocaleString('vi-VN')}\` views\n` +
      `• 💰 *Cost-Per-Impression (CPI):* \`${cpiFormatted}\` (*${roi.cpiRating}*)\n` +
      `• 🏷️ *Cost-Per-Lead (CPL):* \`${cplFormatted}\`\n\n` +
      `💡 *Đánh giá vận hành:* Đạt hiệu quả truyền thông xuất sắc, đã sẵn sàng gửi hồ sơ pitching Year-End Party cho CMO!\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    );
  }

  /**
   * Format Abandoned Quote Nudge Alert for Sales Team (T+2h)
   */
  public formatAbandonedQuoteAlertMarkdown(event: EventDetails): string {
    const quote = event.quoteDetails;
    const amountStr = quote ? formatVndCurrency(quote.totalAmountVnd) : 'Chưa rõ';

    return (
      `⚠️ *[T+2H BOT ALERT] NHẮC BÁO GIÁ CHƯA CỌC*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Khách hàng:* ${event.clientName} (📞 \`${event.clientPhone ?? 'N/A'}\`)\n` +
      `💵 *Giá trị báo giá:* \`${amountStr}\`\n` +
      `⏳ *Thời gian gửi:* 2 giờ trước\n` +
      `🤖 *Hành động hệ thống:* Đã tự động kích hoạt tin nhắn Zalo kèm Video Hậu Trường (BTS) cho khách.\n` +
      `👉 *Sales phụ trách:* Vui lòng theo dõi nếu khách tương tác lại để chốt lịch đặt cọc ngay!\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    );
  }

  /**
   * Send message to Telegram Chat (Mock or Real via Bot API)
   */
  public async sendMessage(
    chatId: string | number | undefined,
    text: string,
    options?: {
      parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
      disableWebPagePreview?: boolean;
    }
  ): Promise<TelegramSendResult> {
    const targetChatId = chatId ?? this.defaultChatId;
    if (!targetChatId) {
      throw new Error('Telegram chatId must be specified or configured as defaultChatId');
    }

    const payload: TelegramPayload = {
      chat_id: targetChatId,
      text,
      parse_mode: options?.parseMode ?? 'Markdown',
      disable_web_page_preview: options?.disableWebPagePreview ?? false,
    };

    const validated = TelegramPayloadSchema.parse(payload);
    this.sentMessages.push({ payload: validated, sentAt: new Date() });

    // Mock mode if no bot token
    if (!this.botToken) {
      return {
        ok: true,
        messageId: Math.floor(Math.random() * 100000),
        description: 'Sent via Mock Dispatcher',
      };
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validated),
      });

      const json = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
      return {
        ok: json.ok,
        messageId: json.result?.message_id,
        description: json.description,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        description: errorMsg,
      };
    }
  }

  public getSentMessages(): Array<{ payload: TelegramPayload; sentAt: Date }> {
    return [...this.sentMessages];
  }

  public clearSentMessages(): void {
    this.sentMessages = [];
  }
}

/**
 * Backward compatibility alias
 */
export const TelegramWebhookDispatcher = TelegramAdapter;
