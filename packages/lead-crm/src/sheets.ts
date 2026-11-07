import {
  GoogleSheetBatchPayload,
  GoogleSheetBatchPayloadSchema,
  GoogleSheetPayload,
  GoogleSheetPayloadSchema,
  LeadRecord,
} from './types';

export interface GoogleSheetFormatOptions {
  sheetName?: string;
  timeZone?: string;
  preservePhoneLeadingZero?: boolean;
  headers?: string[];
  extraColumns?: Record<string, string>;
}

export const DEFAULT_SHEET_HEADERS = [
  'Thời gian tạo',
  'Mã Lead',
  'Họ và tên',
  'Số điện thoại',
  'Nhà mạng',
  'Email',
  'Sản phẩm quan tâm',
  'Nguồn (Source)',
  'Kênh (Medium)',
  'Chiến dịch (Campaign)',
  'Sale phụ trách',
  'Trạng thái',
  'Ghi chú',
];

/**
 * Formats an ISO date string into Vietnamese local date format: DD/MM/YYYY HH:mm:ss.
 */
export function formatVietnamDateTime(
  isoDateString: string,
  timeZone = 'Asia/Ho_Chi_Minh'
): string {
  try {
    const date = new Date(isoDateString);
    if (isNaN(date.getTime())) {
      return isoDateString;
    }

    const formatter = new Intl.DateTimeFormat('vi-VN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    return formatter.format(date);
  } catch {
    return isoDateString;
  }
}

/**
 * Ensures phone number keeps leading zero when appended to Google Sheets
 * by prepending a single quote `'` (e.g. '0987654321).
 */
export function formatPhoneForGoogleSheets(
  phone: string,
  preserveZero = true
): string {
  if (!phone) return '';
  if (preserveZero && phone.startsWith('0')) {
    return `'${phone}`;
  }
  return phone;
}

/**
 * Converts a LeadRecord into an array of cell values matching standard Google Sheet headers.
 */
export function mapLeadToSheetRow(
  lead: LeadRecord,
  options: GoogleSheetFormatOptions = {}
): (string | number | boolean | null)[] {
  const preserveZero = options.preservePhoneLeadingZero !== false;
  const timeZone = options.timeZone || 'Asia/Ho_Chi_Minh';

  const formattedDate = formatVietnamDateTime(lead.createdAt, timeZone);
  const formattedPhone = formatPhoneForGoogleSheets(lead.phone, preserveZero);

  return [
    formattedDate,
    lead.id,
    lead.fullName,
    formattedPhone,
    lead.carrier || 'Chưa rõ',
    lead.email || '',
    lead.productInterest || '',
    lead.source || lead.utm?.utm_source || 'direct',
    lead.utm?.utm_medium || '',
    lead.utm?.utm_campaign || '',
    lead.assignedAgentName || lead.assignedTo || 'Chưa phân bổ',
    lead.status,
    lead.note || '',
  ];
}

/**
 * Formats a LeadRecord into a structured Google Apps Script Webhook payload
 * to automatically append a new row in Google Sheets.
 */
export function formatGoogleSheetPayload(
  lead: LeadRecord,
  options: GoogleSheetFormatOptions = {}
): GoogleSheetPayload {
  const sheetName = options.sheetName || 'Leads';
  const headers = options.headers || DEFAULT_SHEET_HEADERS;
  const row = mapLeadToSheetRow(lead, options);

  const rowData: Record<string, unknown> = {
    createdAtFormatted: formatVietnamDateTime(lead.createdAt, options.timeZone),
    id: lead.id,
    fullName: lead.fullName,
    phone: formatPhoneForGoogleSheets(
      lead.phone,
      options.preservePhoneLeadingZero !== false
    ),
    carrier: lead.carrier,
    email: lead.email,
    productInterest: lead.productInterest,
    source: lead.source,
    utm_source: lead.utm?.utm_source,
    utm_medium: lead.utm?.utm_medium,
    utm_campaign: lead.utm?.utm_campaign,
    assignedTo: lead.assignedTo,
    assignedAgentName: lead.assignedAgentName,
    status: lead.status,
    note: lead.note,
  };

  const payload: GoogleSheetPayload = {
    action: 'APPEND_ROW',
    sheetName,
    headers,
    row,
    rowData,
    timestamp: new Date().toISOString(),
    metadata: {
      leadId: lead.id,
      phoneE164: lead.phoneE164,
      ...lead.metadata,
    },
  };

  return GoogleSheetPayloadSchema.parse(payload);
}

/**
 * Formats multiple LeadRecords into a batch payload for Google Sheets.
 */
export function formatGoogleSheetBatchPayload(
  leads: LeadRecord[],
  options: GoogleSheetFormatOptions = {}
): GoogleSheetBatchPayload {
  const sheetName = options.sheetName || 'Leads';
  const headers = options.headers || DEFAULT_SHEET_HEADERS;
  const rows = leads.map((lead) => mapLeadToSheetRow(lead, options));

  const payload: GoogleSheetBatchPayload = {
    action: 'APPEND_ROWS',
    sheetName,
    headers,
    rows,
    count: rows.length,
    timestamp: new Date().toISOString(),
  };

  return GoogleSheetBatchPayloadSchema.parse(payload);
}

/**
 * Prepares HTTP POST request configuration for sending payload to Google Apps Script Webhook.
 */
export function createGoogleSheetsWebhookRequest(options: {
  webhookUrl: string;
  payload: GoogleSheetPayload | GoogleSheetBatchPayload;
  secretToken?: string;
}): {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
} {
  const { webhookUrl, payload, secretToken } = options;

  let url = webhookUrl;
  if (secretToken) {
    const separator = webhookUrl.includes('?') ? '&' : '?';
    url = `${webhookUrl}${separator}token=${encodeURIComponent(secretToken)}`;
  }

  return {
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  };
}
