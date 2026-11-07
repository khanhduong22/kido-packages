import { z } from 'zod';

// ============================================================================
// CHANNELS & TRIGGER TYPES
// ============================================================================

export const DeliveryChannelSchema = z.enum(['EMAIL', 'ZALO_ZNS', 'TELEGRAM']);
export type DeliveryChannel = z.infer<typeof DeliveryChannelSchema>;

export const DripTriggerTypeSchema = z.enum([
  'T_MINUS_24H',   // T-24h: Nhắc nhở danh sách nhân sự, call time, định vị sảnh tiệc
  'T_PLUS_24H',    // T+24h: B2B Báo cáo ROI Telemetry cho CMO / Brand Director
  'T_PLUS_3D',     // T+3d: B2C Tiệc cưới gửi bộ ảnh chất lượng cao
  'T_PLUS_365D',   // T+365d: B2C Tiệc cưới Zalo chúc mừng kỷ niệm 1 năm + ưu đãi
  'T_PLUS_2H',     // T+2h: Báo giá bỏ dở nhắc cọc kèm video hậu trường
  'CUSTOM',        // Mốc tuỳ chỉnh linh hoạt
]);
export type DripTriggerType = z.infer<typeof DripTriggerTypeSchema>;

export const EventCategorySchema = z.enum([
  'B2B_CORPORATE',
  'B2C_WEDDING',
  'LEAD_ABANDONED',
  'GENERAL',
]);
export type EventCategory = z.infer<typeof EventCategorySchema>;

export const TargetAudienceSchema = z.enum([
  'CREW',
  'ORGANIZER',
  'CLIENT',
  'GUEST',
  'LEAD',
]);
export type TargetAudience = z.infer<typeof TargetAudienceSchema>;

// ============================================================================
// DRIP SCHEDULE RULE & CAMPAIGN
// ============================================================================

export const DripScheduleRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  triggerType: DripTriggerTypeSchema,
  channel: DeliveryChannelSchema,
  offsetMinutes: z.number().int(), // Offset relative to eventDate or quoteCreatedAt
  targetAudience: TargetAudienceSchema,
  templateId: z.string().min(1),
  description: z.string(),
  conditions: z
    .object({
      categories: z.array(EventCategorySchema).optional(),
      requiresQuoteAbandoned: z.boolean().optional(),
      requiresCompletedEvent: z.boolean().optional(),
      minPhotosPrinted: z.number().optional(),
    })
    .optional(),
});
export type DripScheduleRule = z.infer<typeof DripScheduleRuleSchema>;

export const MarketingCampaignSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  category: EventCategorySchema,
  rules: z.array(DripScheduleRuleSchema),
  isActive: z.boolean().default(true),
});
export type MarketingCampaign = z.infer<typeof MarketingCampaignSchema>;

// ============================================================================
// EVENT DETAILS SCHEMA
// ============================================================================

export const CrewMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  phone: z.string().min(1),
});
export type CrewMember = z.infer<typeof CrewMemberSchema>;

export const QuoteDetailsSchema = z.object({
  id: z.string().min(1),
  createdAt: z.union([z.string(), z.date()]),
  totalAmountVnd: z.number().nonnegative(),
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'ABANDONED']),
  quoteLink: z.string().url().optional(),
  btsVideoUrl: z.string().url().optional(), // Clip hậu trường đính kèm
});
export type QuoteDetails = z.infer<typeof QuoteDetailsSchema>;

export const GalleryDetailsSchema = z.object({
  url: z.string().url(),
  pinCode: z.string().optional(),
  photoCount: z.number().int().nonnegative().optional(),
});
export type GalleryDetails = z.infer<typeof GalleryDetailsSchema>;

export const EventDetailsSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: EventCategorySchema,
  clientName: z.string().min(1),
  clientEmail: z.string().email().optional(),
  clientPhone: z.string().optional(),
  clientTitle: z.string().optional(),
  clientCompany: z.string().optional(),
  eventDate: z.union([z.string(), z.date()]),
  venue: z
    .object({
      name: z.string(),
      address: z.string().optional(),
      mapUrl: z.string().url().optional(),
    })
    .optional(),
  callTime: z.union([z.string(), z.date()]).optional(),
  assignedCrew: z.array(CrewMemberSchema).optional(),
  quoteDetails: QuoteDetailsSchema.optional(),
  galleryDetails: GalleryDetailsSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type EventDetails = z.infer<typeof EventDetailsSchema>;

// ============================================================================
// SCHEDULED DRIP MESSAGE
// ============================================================================

export const ScheduledDripMessageSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  ruleId: z.string().min(1),
  triggerType: DripTriggerTypeSchema,
  channel: DeliveryChannelSchema,
  scheduledAt: z.date(),
  recipient: z.object({
    name: z.string(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    telegramChatId: z.union([z.string(), z.number()]).optional(),
    role: z.string().optional(),
  }),
  status: z.enum(['PENDING', 'DISPATCHED', 'SKIPPED', 'FAILED']),
  payload: z.record(z.unknown()),
  dispatchedAt: z.date().optional(),
  errorMessage: z.string().optional(),
});
export type ScheduledDripMessage = z.infer<typeof ScheduledDripMessageSchema>;

// ============================================================================
// ROI TELEMETRY SCHEMA
// ============================================================================

export const EventRoiInputSchema = z.object({
  eventCost: z.number().nonnegative(), // Chi phí hợp đồng / sự kiện đầu tư (VND)
  totalSessions: z.number().int().nonnegative(), // Tổng lượt quay/chụp
  totalPhotosPrinted: z.number().int().nonnegative(), // Số lượng ảnh in lấy liền
  qrScans: z.number().int().nonnegative(), // Lượt quét QR tải ảnh
  leadsCaptured: z.number().int().nonnegative(), // Số data lead (SĐT/Email) thu thập
  estimatedAttendance: z.number().int().positive().optional(), // Số khách ước tính tham dự
  avgSocialSharesPerGuest: z.number().positive().optional().default(2.5), // Trung bình số lượt đăng Story/Post
  avgFollowersPerGuest: z.number().positive().optional().default(350), // Lượng người xem trung bình mỗi tài khoản
});
export type EventRoiInput = z.input<typeof EventRoiInputSchema>;
export type EventRoiValidatedInput = z.output<typeof EventRoiInputSchema>;

export const CpiRatingSchema = z.enum([
  'EXCELLENT', // CPI < 100 VND
  'GOOD',      // 100 - 300 VND
  'AVERAGE',   // 300 - 800 VND
  'SUB_OPTIMAL', // > 800 VND
]);
export type CpiRating = z.infer<typeof CpiRatingSchema>;

export const EventRoiTelemetrySchema = z.object({
  totalInteractions: z.number().int().nonnegative(),
  totalSessions: z.number().int().nonnegative(),
  totalPhotosPrinted: z.number().int().nonnegative(),
  qrScans: z.number().int().nonnegative(),
  leadsCaptured: z.number().int().nonnegative(),
  conversionRatePercent: z.number().nonnegative(),
  interactionPerGuestRatio: z.number().nonnegative().optional(),
  estimatedSocialReach: z.number().int().nonnegative(),
  costPerImpressionVnd: z.number().nonnegative(),
  costPerLeadVnd: z.number().nonnegative(),
  cpiRating: CpiRatingSchema,
  summaryText: z.string(),
  generatedAt: z.date(),
});
export type EventRoiTelemetry = z.infer<typeof EventRoiTelemetrySchema>;

// ============================================================================
// EMAIL TEMPLATE DATA
// ============================================================================

export const EmailTemplateDataSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  clientName: z.string().min(1),
  eventName: z.string().min(1),
  bodyParagraphs: z.array(z.string()),
  roiTelemetry: EventRoiTelemetrySchema.optional(),
  highlightBox: z
    .object({
      title: z.string(),
      content: z.string(),
      items: z.array(z.string()).optional(),
    })
    .optional(),
  callToAction: z
    .object({
      text: z.string().min(1),
      url: z.string().url(),
    })
    .optional(),
  brandInfo: z.object({
    name: z.string().min(1),
    website: z.string().url(),
    phone: z.string().optional(),
    logoUrl: z.string().url().optional(),
    address: z.string().optional(),
  }),
});
export type EmailTemplateData = z.infer<typeof EmailTemplateDataSchema>;
