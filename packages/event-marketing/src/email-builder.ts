import {
  EmailTemplateData,
  EmailTemplateDataSchema,
  EventRoiTelemetry,
} from './types';
import { formatVndCurrency } from './roi-calculator';

/**
 * Render a production-grade, Craft-Minimalism HTML Email
 * - Standard 600px table container
 * - 100% inline CSS for Gmail/Apple Mail/Outlook compatibility
 * - Responsive viewport & subtle Dark Mode support
 * - Zero heavy bloated images; pure crisp typography
 */
export function renderMinimalistEmail(data: EmailTemplateData): string {
  const validated = EmailTemplateDataSchema.parse(data);
  const {
    title,
    subtitle,
    clientName,
    eventName,
    bodyParagraphs,
    roiTelemetry,
    highlightBox,
    callToAction,
    brandInfo,
  } = validated;

  // Render ROI Grid if telemetry data is present
  let roiHtml = '';
  if (roiTelemetry) {
    roiHtml = `
      <!-- ROI Telemetry Grid -->
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 24px 0; border-collapse: separate; border-spacing: 12px 12px;">
        <tr>
          <td width="50%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: left; vertical-align: top;">
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 6px;">Tổng Điểm Chạm</div>
            <div style="font-size: 24px; font-weight: 700; color: #0f172a; line-height: 1.2;">${roiTelemetry.totalInteractions.toLocaleString('vi-VN')}</div>
            <div style="font-size: 12px; color: #64748b; margin-top: 4px;">${roiTelemetry.totalSessions} lượt quay • ${roiTelemetry.totalPhotosPrinted} ảnh in</div>
          </td>
          <td width="50%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: left; vertical-align: top;">
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 6px;">Data Lead Thu Thập</div>
            <div style="font-size: 24px; font-weight: 700; color: #0f172a; line-height: 1.2;">${roiTelemetry.leadsCaptured.toLocaleString('vi-VN')}</div>
            <div style="font-size: 12px; color: #059669; font-weight: 500; margin-top: 4px;">Tỷ lệ CVR: ${roiTelemetry.conversionRatePercent}%</div>
          </td>
        </tr>
        <tr>
          <td width="50%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: left; vertical-align: top;">
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 6px;">Ước Tính Lan Toả MXH</div>
            <div style="font-size: 24px; font-weight: 700; color: #0f172a; line-height: 1.2;">${roiTelemetry.estimatedSocialReach.toLocaleString('vi-VN')}</div>
            <div style="font-size: 12px; color: #64748b; margin-top: 4px;">Story / Reels / Feed reach</div>
          </td>
          <td width="50%" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: left; vertical-align: top;">
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 6px;">Chi Phí / Tiếp Cận (CPI)</div>
            <div style="font-size: 24px; font-weight: 700; color: #0f172a; line-height: 1.2;">${formatVndCurrency(roiTelemetry.costPerImpressionVnd)}</div>
            <div style="font-size: 12px; color: #2563eb; font-weight: 600; margin-top: 4px;">Đánh giá: ${roiTelemetry.cpiRating}</div>
          </td>
        </tr>
      </table>

      <!-- Executive Brief Callout -->
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
        <tr>
          <td style="background-color: #f1f5f9; border-left: 3px solid #0f172a; border-radius: 0 6px 6px 0; padding: 14px 16px;">
            <div style="font-size: 13px; line-height: 1.6; color: #334155; font-style: italic;">
              ${roiTelemetry.summaryText}
            </div>
          </td>
        </tr>
      </table>
    `;
  }

  // Render Highlight Box if present
  let highlightHtml = '';
  if (highlightBox) {
    const itemsList = highlightBox.items
      ? `<ul style="margin: 8px 0 0 16px; padding: 0; font-size: 14px; color: #334155; line-height: 1.6;">
          ${highlightBox.items.map((it) => `<li style="margin-bottom: 4px;">${it}</li>`).join('')}
         </ul>`
      : '';

    highlightHtml = `
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 20px 0;">
        <tr>
          <td style="background-color: #fafaf9; border: 1px dashed #d6d3d1; border-radius: 8px; padding: 16px;">
            <div style="font-size: 14px; font-weight: 600; color: #1c1917; margin-bottom: 6px;">${highlightBox.title}</div>
            <div style="font-size: 14px; color: #44403c; line-height: 1.5;">${highlightBox.content}</div>
            ${itemsList}
          </td>
        </tr>
      </table>
    `;
  }

  // Render Call to Action Button
  let ctaHtml = '';
  if (callToAction) {
    ctaHtml = `
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin: 28px 0;">
        <tr>
          <td align="center">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="border-radius: 6px; background-color: #0f172a;">
                  <a href="${callToAction.url}" target="_blank" style="font-size: 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600; color: #ffffff; text-decoration: none; display: inline-block; padding: 12px 28px; border-radius: 6px; border: 1px solid #0f172a; letter-spacing: 0.02em;">
                    ${callToAction.text} &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;
  }

  // Render Body Paragraphs
  const paragraphsHtml = bodyParagraphs
    .map(
      (p) =>
        `<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #334155;">${p}</p>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="vi" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${title}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    @media (prefers-color-scheme: dark) {
      body, .email-body { background-color: #09090b !important; color: #f4f4f5 !important; }
      .email-card { background-color: #18181b !important; border-color: #27272a !important; }
      .text-primary { color: #fafafa !important; }
      .text-secondary { color: #a1a1aa !important; }
      .metric-box { background-color: #27272a !important; border-color: #3f3f46 !important; }
      .metric-value { color: #ffffff !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; width: 100%; -webkit-text-size-adjust: 100%; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <center style="width: 100%; background-color: #f8fafc; padding: 32px 0;">
    <!-- Container -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto;">
      
      <!-- Brand Header -->
      <tr>
        <td style="padding: 0 20px 20px 20px; text-align: left;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td>
                <span style="font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #0f172a;">
                  ${brandInfo.name}
                </span>
              </td>
              <td style="text-align: right;">
                <span style="font-size: 12px; color: #94a3b8;">${eventName}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Card Main Body -->
      <tr>
        <td>
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" class="email-card" style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);">
            <tr>
              <td style="padding: 36px 32px;">
                
                <!-- Title & Subtitle -->
                ${
                  subtitle
                    ? `<div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-bottom: 8px;">${subtitle}</div>`
                    : ''
                }
                <h1 class="text-primary" style="margin: 0 0 20px 0; font-size: 22px; font-weight: 700; color: #0f172a; line-height: 1.3; letter-spacing: -0.01em;">
                  ${title}
                </h1>

                <!-- Client Salutation -->
                <p style="margin: 0 0 16px 0; font-size: 15px; font-weight: 600; color: #0f172a;">
                  Kính gửi ${clientName},
                </p>

                <!-- Paragraphs -->
                ${paragraphsHtml}

                <!-- Highlight Box -->
                ${highlightHtml}

                <!-- ROI Telemetry -->
                ${roiHtml}

                <!-- Call To Action -->
                ${ctaHtml}

                <!-- Sign off -->
                <p style="margin: 24px 0 0 0; font-size: 14px; line-height: 1.5; color: #64748b;">
                  Trân trọng,<br>
                  <strong style="color: #0f172a;">Đội ngũ ${brandInfo.name}</strong>
                </p>

              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding: 24px 20px; text-align: center;">
          <p style="margin: 0 0 8px 0; font-size: 12px; color: #94a3b8; line-height: 1.5;">
            ${brandInfo.name} • <a href="${brandInfo.website}" target="_blank" style="color: #64748b; text-decoration: none;">${brandInfo.website.replace(/^https?:\/\//, '')}</a>
            ${brandInfo.phone ? ` • Hotline: ${brandInfo.phone}` : ''}
          </p>
          ${
            brandInfo.address
              ? `<p style="margin: 0 0 8px 0; font-size: 11px; color: #cbd5e1;">${brandInfo.address}</p>`
              : ''
          }
          <p style="margin: 0; font-size: 11px; color: #cbd5e1;">
            Thông tin này được gửi tự động dựa trên hợp đồng tổ chức sự kiện giữa hai bên.
          </p>
        </td>
      </tr>

    </table>
  </center>
</body>
</html>`;
}

/**
 * Fluent builder class for constructing emails
 */
export class EmailTemplateBuilder {
  private data: Partial<EmailTemplateData> = {
    bodyParagraphs: [],
  };

  public setTitle(title: string): this {
    this.data.title = title;
    return this;
  }

  public setSubtitle(subtitle: string): this {
    this.data.subtitle = subtitle;
    return this;
  }

  public setClientName(clientName: string): this {
    this.data.clientName = clientName;
    return this;
  }

  public setEventName(eventName: string): this {
    this.data.eventName = eventName;
    return this;
  }

  public addParagraph(paragraph: string): this {
    if (!this.data.bodyParagraphs) {
      this.data.bodyParagraphs = [];
    }
    this.data.bodyParagraphs.push(paragraph);
    return this;
  }

  public setHighlightBox(title: string, content: string, items?: string[]): this {
    this.data.highlightBox = { title, content, items };
    return this;
  }

  public setRoiTelemetry(roi: EventRoiTelemetry): this {
    this.data.roiTelemetry = roi;
    return this;
  }

  public setCallToAction(text: string, url: string): this {
    this.data.callToAction = { text, url };
    return this;
  }

  public setBrandInfo(brand: EmailTemplateData['brandInfo']): this {
    this.data.brandInfo = brand;
    return this;
  }

  public build(): string {
    return renderMinimalistEmail(this.data as EmailTemplateData);
  }
}

/**
 * Pre-configured builder for T+24h B2B ROI Telemetry report
 */
export function renderB2bRoiEmail(params: {
  clientName: string;
  eventName: string;
  roi: EventRoiTelemetry;
  ctaUrl: string;
  brandName?: string;
  brandWebsite?: string;
}): string {
  const brandName = params.brandName ?? 'T-RED Media & Photobooth';
  const brandWebsite = params.brandWebsite ?? 'https://tred.vn';

  return new EmailTemplateBuilder()
    .setTitle(`Báo Cáo Hiệu Quả Truyền Thông & ROI Telemetry: ${params.eventName}`)
    .setSubtitle('Báo Cáo Vận Hành T+24h • T-RED Media')
    .setClientName(params.clientName)
    .setEventName(params.eventName)
    .addParagraph(
      `Cảm ơn Quý doanh nghiệp đã tin tưởng đồng hành cùng ${brandName} trong sự kiện vừa qua. ` +
        `Chúng tôi xin trân trọng gửi bảng số liệu phân tích hiệu quả điểm chạm tương tác và đo lường độ lan tỏa trực tiếp từ hệ thống.`
    )
    .setRoiTelemetry(params.roi)
    .addParagraph(
      `Toàn bộ dữ liệu khách hàng (lead capture) đã được mã hóa bảo mật và sẵn sàng kết nối trực tiếp vào hệ thống CRM của Quý công ty. ` +
        `Quý đối tác có thể truy cập dashboard trực tuyến dưới đây để trích xuất file Excel báo cáo chi tiết phục vụ cuộc họp tổng kết.`
    )
    .setCallToAction('Xem Dashboard Báo Cáo Chi Tiết', params.ctaUrl)
    .setBrandInfo({
      name: brandName,
      website: brandWebsite,
      phone: '0901.123.888',
      address: 'Đà Nẵng: 12 Võ Văn Tần | TP.HCM: 45 Lê Duẩn, Quận 1',
    })
    .build();
}

/**
 * Pre-configured builder for T+3d Wedding Gallery delivery
 */
export function renderWeddingGalleryEmail(params: {
  clientName: string;
  eventName: string;
  galleryUrl: string;
  pinCode?: string;
  photoCount?: number;
  brandName?: string;
  brandWebsite?: string;
}): string {
  const brandName = params.brandName ?? 'T-RED Photobooth';
  const brandWebsite = params.brandWebsite ?? 'https://fotobooth.vn';

  const builder = new EmailTemplateBuilder()
    .setTitle(`Bộ Ảnh Kỷ Niệm 4K Chất Lượng Cao: ${params.eventName}`)
    .setSubtitle('Cloud Gallery Tải Ảnh Gốc T+3d')
    .setClientName(params.clientName)
    .setEventName(params.eventName)
    .addParagraph(
      `Đội ngũ ${brandName} xin gửi lời chúc phúc ngọt ngào nhất tới hai bạn! ` +
        `Sau quá trình hậu kỳ và kiểm duyệt chất lượng từng khung hình, toàn bộ ${params.photoCount ? params.photoCount + ' ' : ''}khoảnh khắc rạng rỡ của bạn và khách mời đã sẵn sàng.`
    );

  if (params.pinCode) {
    builder.setHighlightBox(
      'Mã PIN Bảo Mật Gallery Riêng Tư',
      `Mã PIN truy cập: ${params.pinCode} (Dùng để mở quyền tải toàn bộ file gốc không nén 4K). Link gallery sẽ được lưu trữ đám mây trong vòng 180 ngày.`
    );
  }

  builder
    .setCallToAction('Truy Cập Cloud Gallery & Tải Ảnh', params.galleryUrl)
    .setBrandInfo({
      name: brandName,
      website: brandWebsite,
      phone: '0901.123.888',
      address: 'Đà Nẵng & TP. Hồ Chí Minh',
    });

  return builder.build();
}
