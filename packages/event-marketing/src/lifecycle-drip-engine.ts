import {
  DripScheduleRule,
  DripTriggerType,
  EventCategory,
  EventDetails,
  ScheduledDripMessage,
} from './types';

/**
 * Standard Drip Schedule Rules for T-RED Media and T-RED Photobooth
 */
export const DEFAULT_DRIP_RULES: DripScheduleRule[] = [
  // T-24h: Nhắc nhở danh sách nhân sự, call time, định vị sảnh tiệc cho ekip và khách hàng
  {
    id: 'rule-t-minus-24h',
    name: 'Call-Time & Event Briefing Roster (T-24h)',
    triggerType: 'T_MINUS_24H',
    channel: 'TELEGRAM',
    offsetMinutes: -24 * 60, // -1440 mins
    targetAudience: 'CREW',
    templateId: 'tpl-crew-briefing-t24h',
    description:
      'Gửi thông báo Telegram cho ekip & ban tổ chức: Call-time, vị trí sảnh tiệc, checklist thiết bị',
  },
  // T+24h: Bắn Báo Cáo Hiệu Quả Truyền Thông (Event ROI Telemetry) cho Giám đốc Marketing nhãn hàng
  {
    id: 'rule-t-plus-24h',
    name: 'Post-Event ROI Telemetry Report (T+24h)',
    triggerType: 'T_PLUS_24H',
    channel: 'EMAIL',
    offsetMinutes: 24 * 60, // +1440 mins
    targetAudience: 'CLIENT',
    templateId: 'tpl-b2b-roi-report-t24h',
    description:
      'Bắn báo cáo ROI Telemetry chi tiết cho Giám đốc Marketing để chốt show Year-End Party tiếp theo',
    conditions: {
      categories: ['B2B_CORPORATE', 'GENERAL'],
    },
  },
  // T+3d: (B2C Tiệc Cưới) Gửi bộ ảnh kỷ niệm chất lượng cao
  {
    id: 'rule-t-plus-3d',
    name: 'High-Res Wedding Gallery Delivery (T+3d)',
    triggerType: 'T_PLUS_3D',
    channel: 'EMAIL',
    offsetMinutes: 3 * 24 * 60, // +4320 mins
    targetAudience: 'CLIENT',
    templateId: 'tpl-wedding-gallery-t3d',
    description:
      'Gửi link Cloud Gallery tải toàn bộ ảnh & video 4K chất lượng cao không nén cho cô dâu chú rể',
    conditions: {
      categories: ['B2C_WEDDING', 'GENERAL'],
    },
  },
  // T+365d: (B2C Tiệc Cưới) Tin nhắn Zalo chúc mừng kỷ niệm 1 năm ngày cưới + ưu đãi chụp em bé / gia đình
  {
    id: 'rule-t-plus-365d',
    name: 'First Wedding Anniversary & Family Studio Voucher (T+365d)',
    triggerType: 'T_PLUS_365D',
    channel: 'ZALO_ZNS',
    offsetMinutes: 365 * 24 * 60, // +525600 mins (handled with year addition in engine)
    targetAudience: 'CLIENT',
    templateId: 'tpl-zns-wedding-anniversary-t365d',
    description:
      'Gửi tin nhắn ZNS chúc mừng kỷ niệm 1 năm ngày cưới kèm voucher giảm 20% gói chụp ảnh gia đình/em bé',
    conditions: {
      categories: ['B2C_WEDDING'],
    },
  },
  // T+2h: (Báo Giá Bỏ Dở) Nhắc khách chưa cọc kèm clip hậu trường
  {
    id: 'rule-t-plus-2h',
    name: 'Abandoned Quote Nudge with BTS Footage (T+2h)',
    triggerType: 'T_PLUS_2H',
    channel: 'ZALO_ZNS',
    offsetMinutes: 2 * 60, // +120 mins from quote creation
    targetAudience: 'LEAD',
    templateId: 'tpl-zns-abandoned-quote-t2h',
    description:
      'Nhắc khách hàng chưa chốt cọc báo giá sau 2 giờ, đính kèm clip hậu trường các show tầm cỡ',
    conditions: {
      requiresQuoteAbandoned: true,
    },
  },
];

export class EventLifecycleDripEngine {
  private rules: DripScheduleRule[];

  constructor(customRules?: DripScheduleRule[]) {
    this.rules = customRules ?? [...DEFAULT_DRIP_RULES];
  }

  /**
   * Return the list of active rules in the engine
   */
  public getRules(): DripScheduleRule[] {
    return [...this.rules];
  }

  /**
   * Add or replace a rule in the engine
   */
  public registerRule(rule: DripScheduleRule): void {
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
  }

  /**
   * Determine if a rule is applicable to the given event
   */
  public isRuleApplicable(rule: DripScheduleRule, event: EventDetails): boolean {
    const { conditions } = rule;
    if (!conditions) {
      return true;
    }

    // Category filter
    if (conditions.categories && conditions.categories.length > 0) {
      if (!conditions.categories.includes(event.category)) {
        return false;
      }
    }

    // Abandoned quote filter (T+2h)
    if (conditions.requiresQuoteAbandoned) {
      if (!event.quoteDetails) {
        return false;
      }
      const validAbandonedStatuses = ['ABANDONED', 'SENT', 'DRAFT'];
      if (!validAbandonedStatuses.includes(event.quoteDetails.status)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Calculate exact scheduled trigger time for a specific rule and event
   */
  public calculateScheduledTime(rule: DripScheduleRule, event: EventDetails): Date {
    const eventTime = new Date(event.eventDate).getTime();

    switch (rule.triggerType) {
      case 'T_MINUS_24H': {
        // Exactly 24 hours before event
        return new Date(eventTime - 24 * 60 * 60 * 1000);
      }

      case 'T_PLUS_24H': {
        // Exactly 24 hours after event
        return new Date(eventTime + 24 * 60 * 60 * 1000);
      }

      case 'T_PLUS_3D': {
        // Exactly 3 days (72 hours) after event
        return new Date(eventTime + 3 * 24 * 60 * 60 * 1000);
      }

      case 'T_PLUS_365D': {
        // Exactly 1 year after event date (calendar year aware)
        const d = new Date(event.eventDate);
        d.setFullYear(d.getFullYear() + 1);
        return d;
      }

      case 'T_PLUS_2H': {
        // 2 hours after quote creation time
        if (event.quoteDetails?.createdAt) {
          const quoteTime = new Date(event.quoteDetails.createdAt).getTime();
          return new Date(quoteTime + 2 * 60 * 60 * 1000);
        }
        // Fallback to offset relative to eventDate if no quoteDetails
        return new Date(eventTime + rule.offsetMinutes * 60 * 1000);
      }

      case 'CUSTOM':
      default: {
        return new Date(eventTime + rule.offsetMinutes * 60 * 1000);
      }
    }
  }

  /**
   * Generate all scheduled drip messages for an event based on applicable rules
   */
  public generateSchedule(event: EventDetails): ScheduledDripMessage[] {
    const scheduledMessages: ScheduledDripMessage[] = [];

    for (const rule of this.rules) {
      if (!this.isRuleApplicable(rule, event)) {
        continue;
      }

      const scheduledAt = this.calculateScheduledTime(rule, event);

      // Determine recipient details based on targetAudience
      let recipient: ScheduledDripMessage['recipient'];

      if (rule.targetAudience === 'CREW') {
        recipient = {
          name: 'Ekip Vận Hành & Kỹ Thuật T-RED',
          telegramChatId: (event.metadata?.telegramCrewChatId as string | number) ?? '@tred_crew_ops',
          role: 'CREW',
        };
      } else {
        recipient = {
          name: event.clientName,
          email: event.clientEmail,
          phone: event.clientPhone,
          role: rule.targetAudience,
        };
      }

      // Build context payload
      const payload: Record<string, unknown> = {
        eventId: event.id,
        eventName: event.name,
        clientName: event.clientName,
        eventDate: event.eventDate,
        templateId: rule.templateId,
      };

      if (rule.triggerType === 'T_MINUS_24H') {
        payload.callTime = event.callTime ?? event.eventDate;
        payload.venue = event.venue;
        payload.assignedCrew = event.assignedCrew;
      } else if (rule.triggerType === 'T_PLUS_2H') {
        payload.quoteId = event.quoteDetails?.id;
        payload.quoteAmountVnd = event.quoteDetails?.totalAmountVnd;
        payload.quoteLink = event.quoteDetails?.quoteLink;
        payload.btsVideoUrl = event.quoteDetails?.btsVideoUrl;
      } else if (rule.triggerType === 'T_PLUS_3D') {
        payload.galleryUrl = event.galleryDetails?.url;
        payload.pinCode = event.galleryDetails?.pinCode;
      } else if (rule.triggerType === 'T_PLUS_365D') {
        payload.anniversaryYear = 1;
        payload.discountCode = 'WEDDING1YEAR';
        payload.discountPercent = 20;
      }

      scheduledMessages.push({
        id: `msg-${event.id}-${rule.id}`,
        eventId: event.id,
        ruleId: rule.id,
        triggerType: rule.triggerType,
        channel: rule.channel,
        scheduledAt,
        recipient,
        status: 'PENDING',
        payload,
      });
    }

    return scheduledMessages.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  }

  /**
   * Filter messages that are due for delivery at `currentTime`
   */
  public filterDueMessages(
    messages: ScheduledDripMessage[],
    currentTime: Date = new Date()
  ): ScheduledDripMessage[] {
    const nowTime = currentTime.getTime();
    return messages.filter(
      (m) => m.status === 'PENDING' && m.scheduledAt.getTime() <= nowTime
    );
  }

  /**
   * Group messages by status at a given point in time
   */
  public evaluateStatus(
    messages: ScheduledDripMessage[],
    currentTime: Date = new Date()
  ): {
    due: ScheduledDripMessage[];
    upcoming: ScheduledDripMessage[];
    dispatched: ScheduledDripMessage[];
  } {
    const nowTime = currentTime.getTime();
    const due: ScheduledDripMessage[] = [];
    const upcoming: ScheduledDripMessage[] = [];
    const dispatched: ScheduledDripMessage[] = [];

    for (const msg of messages) {
      if (msg.status === 'DISPATCHED') {
        dispatched.push(msg);
      } else if (msg.status === 'PENDING') {
        if (msg.scheduledAt.getTime() <= nowTime) {
          due.push(msg);
        } else {
          upcoming.push(msg);
        }
      }
    }

    return { due, upcoming, dispatched };
  }

  /**
   * Mark a message as dispatched or failed
   */
  public markMessageDispatched(
    message: ScheduledDripMessage,
    dispatchedAt: Date = new Date()
  ): ScheduledDripMessage {
    return {
      ...message,
      status: 'DISPATCHED',
      dispatchedAt,
    };
  }

  public markMessageFailed(
    message: ScheduledDripMessage,
    errorMessage: string
  ): ScheduledDripMessage {
    return {
      ...message,
      status: 'FAILED',
      errorMessage,
    };
  }
}
