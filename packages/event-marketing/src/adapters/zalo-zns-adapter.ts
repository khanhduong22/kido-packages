import { z } from 'zod';

export const ZaloZnsPayloadSchema = z.object({
  phone: z.string().regex(/^84[1-9][0-9]{8}$/, 'Phone must be valid VN format: 84xxxxxxxxx'),
  template_id: z.string().min(1),
  template_data: z.record(z.union([z.string(), z.number()])),
  tracking_id: z.string().optional(),
  mode: z.enum(['development', 'production']).default('production'),
});
export type ZaloZnsPayload = z.infer<typeof ZaloZnsPayloadSchema>;

export interface ZaloZnsResponse {
  error: number;
  message: string;
  data?: {
    msg_id: string;
    sent_time: string;
  };
}

export class ZaloZnsAdapter {
  private sentMessages: Array<{ payload: ZaloZnsPayload; sentAt: Date }> = [];
  private apiUrl: string;
  private mode: 'development' | 'production';

  constructor(options?: {
    apiUrl?: string;
    mode?: 'development' | 'production';
  }) {
    this.apiUrl = options?.apiUrl ?? 'https://business.openapi.zalo.me/message/template';
    this.mode = options?.mode ?? 'production';
  }

  /**
   * Normalize any Vietnamese phone number into 84xxxxxxxxx format
   * Handles: '0901234567', '+84 90 123 4567', '84901234567', '090-123-4567'
   */
  public static normalizePhoneNumber(phone: string): string {
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+84')) {
      return cleaned.slice(1);
    }
    if (cleaned.startsWith('0')) {
      return '84' + cleaned.slice(1);
    }
    if (!cleaned.startsWith('84') && cleaned.length === 9) {
      return '84' + cleaned;
    }
    return cleaned;
  }

  /**
   * Build validated ZNS payload
   */
  public buildPayload(params: {
    phone: string;
    templateId: string;
    templateData: Record<string, string | number>;
    trackingId?: string;
  }): ZaloZnsPayload {
    const normalizedPhone = ZaloZnsAdapter.normalizePhoneNumber(params.phone);
    return ZaloZnsPayloadSchema.parse({
      phone: normalizedPhone,
      template_id: params.templateId,
      template_data: params.templateData,
      tracking_id: params.trackingId,
      mode: this.mode,
    });
  }

  /**
   * Helper to build T+365d Wedding Anniversary payload
   */
  public buildAnniversaryPayload(params: {
    phone: string;
    clientName: string;
    weddingDate: string;
    voucherCode?: string;
    discountPercent?: number;
    trackingId?: string;
  }): ZaloZnsPayload {
    return this.buildPayload({
      phone: params.phone,
      templateId: 'TRED_ZNS_WEDDING_1YEAR',
      trackingId: params.trackingId ?? `anniversary-${Date.now()}`,
      templateData: {
        customer_name: params.clientName,
        wedding_date: params.weddingDate,
        voucher_code: params.voucherCode ?? 'WEDDING1YEAR',
        discount: `${params.discountPercent ?? 20}%`,
        booking_hotline: '0901.123.888',
      },
    });
  }

  /**
   * Helper to build T+2h Abandoned Quote Reminder with BTS Footage
   */
  public buildAbandonedQuotePayload(params: {
    phone: string;
    clientName: string;
    quoteAmountVnd: number;
    quoteLink?: string;
    btsVideoUrl?: string;
    trackingId?: string;
  }): ZaloZnsPayload {
    return this.buildPayload({
      phone: params.phone,
      templateId: 'TRED_ZNS_QUOTE_NUDGE_BTS',
      trackingId: params.trackingId ?? `abandoned-${Date.now()}`,
      templateData: {
        customer_name: params.clientName,
        quote_amount: new Intl.NumberFormat('vi-VN').format(params.quoteAmountVnd),
        quote_link: params.quoteLink ?? 'https://fotobooth.vn/bao-gia',
        bts_video_link:
          params.btsVideoUrl ?? 'https://fotobooth.vn/showreel-behind-the-scenes',
        support_zalo: '0901.123.888',
      },
    });
  }

  /**
   * Send ZNS message (Mock or real HTTP call depending on token presence)
   */
  public async send(
    payload: ZaloZnsPayload,
    accessToken?: string
  ): Promise<ZaloZnsResponse> {
    const valid = ZaloZnsPayloadSchema.parse(payload);

    // If no access token is provided or in mock mode, record locally
    if (!accessToken || this.mode === 'development') {
      this.sentMessages.push({ payload: valid, sentAt: new Date() });
      return {
        error: 0,
        message: 'Success (Mock/Dev Dispatch)',
        data: {
          msg_id: `zns_mock_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          sent_time: new Date().toISOString(),
        },
      };
    }

    try {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          access_token: accessToken,
        },
        body: JSON.stringify(valid),
      });

      const json = (await res.json()) as ZaloZnsResponse;
      this.sentMessages.push({ payload: valid, sentAt: new Date() });
      return json;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        error: -1,
        message: `HTTP Request Failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Return all in-memory recorded messages (useful for unit tests & auditing)
   */
  public getSentMessages(): Array<{ payload: ZaloZnsPayload; sentAt: Date }> {
    return [...this.sentMessages];
  }

  public clearSentMessages(): void {
    this.sentMessages = [];
  }
}
