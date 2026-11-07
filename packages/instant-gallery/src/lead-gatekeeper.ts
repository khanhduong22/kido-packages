import * as crypto from 'node:crypto';
import {
  AccessTier,
  CapturedLeadRecord,
  CapturedLeadRecordSchema,
  GuestAccessPass,
  GuestAccessPassSchema,
  LeadCaptureSubmission,
  LeadCaptureSubmissionSchema,
  LeadGateResult,
  VIETNAM_PHONE_REGEX,
} from './types';

/**
 * Normalizes and validates Vietnamese mobile phone numbers
 * Returns clean 10-digit phone starting with '0'
 */
export function validateVietnamPhone(rawPhone: string): {
  isValid: boolean;
  normalized?: string;
  error?: string;
} {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return { isValid: false, error: 'Số điện thoại không được để trống' };
  }

  // Remove common format chars: spaces, dashes, dots, brackets
  let cleaned = rawPhone.replace(/[\s\-\.\(\)]/g, '');

  // Convert international prefixes: +84... or 84... to 0...
  if (cleaned.startsWith('+84')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('84') && cleaned.length === 11) {
    cleaned = '0' + cleaned.slice(2);
  }

  if (!VIETNAM_PHONE_REGEX.test(cleaned)) {
    return {
      isValid: false,
      error: 'Số điện thoại không đúng chuẩn di động Việt Nam (10 số, đầu 03, 05, 07, 08, 09)',
    };
  }

  return {
    isValid: true,
    normalized: cleaned,
  };
}

/**
 * Options for lead capture processing
 */
export interface LeadCaptureOptions {
  clientIp?: string;
  userAgent?: string;
  unlockedMediaIds?: string[];
  onLeadCaptured?: (record: CapturedLeadRecord) => Promise<void> | void;
}

/**
 * Lead Gatekeeper Service: validates visitor leads and unlocks uncompressed 4K download access
 */
export class LeadGatekeeper {
  private capturedLeads = new Map<string, CapturedLeadRecord>();

  /**
   * Validates visitor submission and unlocks full 4K asset downloads
   */
  public async processLeadCapture(
    pass: GuestAccessPass,
    rawSubmission: unknown,
    options?: LeadCaptureOptions
  ): Promise<LeadGateResult> {
    // Check if pass is expired
    const now = Date.now();
    const expiryTime = new Date(pass.expiresAt).getTime();
    if (now > expiryTime) {
      return {
        success: false,
        accessTier: pass.accessTier,
        updatedPass: pass,
        error: 'Mã QR đã hết thời gian hiệu lực sự kiện',
      };
    }

    // Validate with Zod
    const parseResult = LeadCaptureSubmissionSchema.safeParse(rawSubmission);
    if (!parseResult.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parseResult.error.issues) {
        const fieldName = issue.path.join('.') || 'form';
        fieldErrors[fieldName] = issue.message;
      }

      return {
        success: false,
        accessTier: pass.accessTier,
        updatedPass: pass,
        error: 'Thông tin đăng ký chưa hợp lệ',
        fieldErrors,
      };
    }

    const validatedData = parseResult.data;

    // Strict phone normalization check
    const phoneCheck = validateVietnamPhone(validatedData.phoneNumber);
    if (!phoneCheck.isValid || !phoneCheck.normalized) {
      return {
        success: false,
        accessTier: pass.accessTier,
        updatedPass: pass,
        error: phoneCheck.error || 'Số điện thoại không hợp lệ',
        fieldErrors: { phoneNumber: phoneCheck.error || 'Số điện thoại không hợp lệ' },
      };
    }

    // Marketing consent check
    if (!validatedData.consentMarketing) {
      return {
        success: false,
        accessTier: pass.accessTier,
        updatedPass: pass,
        error: 'Quý khách vui lòng tích chọn đồng ý điều khoản nhận ảnh để mở khóa file 4K',
        fieldErrors: { consentMarketing: 'Bắt buộc đồng ý để tiếp tục' },
      };
    }

    const normalizedSubmission: LeadCaptureSubmission = {
      ...validatedData,
      phoneNumber: phoneCheck.normalized,
      submittedAt: new Date().toISOString(),
    };

    // Create CapturedLeadRecord
    const leadId = `lead_${crypto.randomUUID()}`;
    const leadRecord: CapturedLeadRecord = {
      id: leadId,
      eventId: pass.eventId,
      guestPassTokenId: pass.tokenId,
      leadData: normalizedSubmission,
      clientIp: options?.clientIp,
      userAgent: options?.userAgent,
      unlockedMediaIds: options?.unlockedMediaIds || [],
      createdAt: new Date().toISOString(),
    };

    const validatedRecord = CapturedLeadRecordSchema.parse(leadRecord);
    this.capturedLeads.set(validatedRecord.id, validatedRecord);
    this.capturedLeads.set(pass.tokenId, validatedRecord);

    // Upgrade Pass to UNLOCKED_4K
    const updatedPass: GuestAccessPass = {
      ...pass,
      accessTier: 'UNLOCKED_4K',
      leadCaptured: true,
      capturedLeadId: validatedRecord.id,
    };

    const validatedPass = GuestAccessPassSchema.parse(updatedPass);

    // Call optional webhook/event callback
    if (options?.onLeadCaptured) {
      try {
        await options.onLeadCaptured(validatedRecord);
      } catch (err) {
        // Log silently or handle non-blocking hook error
        console.error('onLeadCaptured callback failed:', err);
      }
    }

    return {
      success: true,
      accessTier: 'UNLOCKED_4K',
      updatedPass: validatedPass,
      leadRecord: validatedRecord,
    };
  }

  /**
   * Check if a pass has already captured a lead and has 4K access
   */
  public isUnlocked(pass: GuestAccessPass): boolean {
    return pass.accessTier === 'UNLOCKED_4K' && pass.leadCaptured === true;
  }

  /**
   * Get captured lead by ID or pass token ID
   */
  public getLead(idOrToken: string): CapturedLeadRecord | undefined {
    return this.capturedLeads.get(idOrToken);
  }

  /**
   * List all captured leads for an event
   */
  public getLeadsByEvent(eventId: string): CapturedLeadRecord[] {
    const list: CapturedLeadRecord[] = [];
    const seen = new Set<string>();

    for (const lead of this.capturedLeads.values()) {
      if (lead.eventId === eventId && !seen.has(lead.id)) {
        seen.add(lead.id);
        list.push(lead);
      }
    }
    return list;
  }
}

/**
 * Convenient standalone captureLead function matching PACKAGES_REGISTRY core export
 */
export async function captureLead(
  pass: GuestAccessPass,
  rawSubmission: unknown,
  options?: LeadCaptureOptions
): Promise<LeadGateResult> {
  const gatekeeper = new LeadGatekeeper();
  return gatekeeper.processLeadCapture(pass, rawSubmission, options);
}
