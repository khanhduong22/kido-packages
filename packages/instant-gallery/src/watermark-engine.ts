import {
  AspectRatio,
  Resolution,
  WatermarkConfig,
  WatermarkConfigSchema,
  WatermarkPosition,
} from './types';

export interface OverlayFrameOptions {
  eventName?: string;
  coupleNames?: string; // e.g. "Trọng Trí & Mai Chi"
  eventDate?: string; // e.g. "10.10.2026"
  sponsorLogoUrl?: string;
  sponsorName?: string;
  brandText?: string;
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  previewMode?: boolean; // if true, adds prominent watermark text over center
  safeZonePadding?: number;
}

export interface SafeZoneSpec {
  topSafePx: number;
  bottomSafePx: number;
  leftSafePx: number;
  rightSafePx: number;
  usableWidth: number;
  usableHeight: number;
}

/**
 * Watermark & Overlay Frame Engine for Glambot 360 & Photobooth
 */
export class WatermarkEngine {
  /**
   * Calculates UI safe zones to avoid TikTok / Instagram Reels overlays:
   * Right side: 80px (like/comment buttons)
   * Bottom: 200px (caption, sound disc)
   * Top: 120px (status bar, search)
   */
  public static calculateSafeZones(
    aspectRatio: AspectRatio = '9:16',
    resolution: Resolution = { width: 1080, height: 1920 }
  ): SafeZoneSpec {
    const scale = resolution.width / 1080;

    if (aspectRatio === '9:16') {
      const topSafePx = Math.round(120 * scale);
      const bottomSafePx = Math.round(220 * scale);
      const rightSafePx = Math.round(88 * scale);
      const leftSafePx = Math.round(48 * scale);

      return {
        topSafePx,
        bottomSafePx,
        leftSafePx,
        rightSafePx,
        usableWidth: resolution.width - leftSafePx - rightSafePx,
        usableHeight: resolution.height - topSafePx - bottomSafePx,
      };
    }

    // Default safe zone for 1:1, 4:3, 16:9
    const margin = Math.round(48 * scale);
    return {
      topSafePx: margin,
      bottomSafePx: margin,
      leftSafePx: margin,
      rightSafePx: margin,
      usableWidth: resolution.width - 2 * margin,
      usableHeight: resolution.height - 2 * margin,
    };
  }

  /**
   * Builds a normalized WatermarkConfig object
   */
  public static buildWatermarkConfig(overrides?: Partial<WatermarkConfig>): WatermarkConfig {
    return WatermarkConfigSchema.parse({
      text: 'T-RED Media • fotobooth.vn',
      opacity: 0.4,
      position: 'CENTER',
      safeZoneMarginPx: 64,
      ...overrides,
    });
  }

  /**
   * Generates production-ready SVG template for rendering engines (FFmpeg, Sharp, Remotion)
   */
  public static generateOverlaySvg(options: OverlayFrameOptions): string {
    const width = options.resolution?.width ?? 1080;
    const height = options.resolution?.height ?? 1920;
    const safeZones = this.calculateSafeZones(options.aspectRatio ?? '9:16', { width, height });

    // Header branding
    const headerTitle = options.eventName || options.brandText || 'T-RED GLAMBOT 360';
    const subTitle = options.coupleNames ? `Happy Wedding: ${options.coupleNames}` : options.sponsorName || '';
    const dateText = options.eventDate || '';

    // Center preview watermark lines if previewMode
    const previewWatermarkSvg = options.previewMode
      ? `
      <!-- Preview Watermark Stamp -->
      <g opacity="0.38" transform="rotate(-30, ${width / 2}, ${height / 2})">
        <rect x="${width / 2 - 380}" y="${height / 2 - 60}" width="760" height="120" rx="16" fill="#000000" />
        <text x="${width / 2}" y="${height / 2 - 10}" 
              font-family="system-ui, -apple-system, sans-serif" 
              font-size="42" 
              font-weight="900" 
              fill="#FFFFFF" 
              text-anchor="middle" 
              letter-spacing="4">
          PREVIEW WATERMARK
        </text>
        <text x="${width / 2}" y="${height / 2 + 35}" 
              font-family="system-ui, -apple-system, sans-serif" 
              font-size="22" 
              font-weight="600" 
              fill="#FBBF24" 
              text-anchor="middle" 
              letter-spacing="2">
          SCAN QR ON K80 PRINT TO GET 4K
        </text>
      </g>
    `
      : '';

    // Wedding Monogram or Sponsor Footer
    const footerY = height - safeZones.bottomSafePx + 40;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.0"/>
    </linearGradient>
    <linearGradient id="footerGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
    </linearGradient>
  </defs>

  <!-- Top Dark Gradient Banner for Contrast -->
  <rect x="0" y="0" width="${width}" height="${safeZones.topSafePx + 80}" fill="url(#headerGrad)"/>

  <!-- Top Header Text -->
  <text x="${width / 2}" y="${safeZones.topSafePx}" 
        font-family="system-ui, -apple-system, sans-serif" 
        font-size="34" 
        font-weight="800" 
        fill="#FFFFFF" 
        text-anchor="middle" 
        letter-spacing="3">
    ${escapeXml(headerTitle.toUpperCase())}
  </text>

  ${
    dateText
      ? `<text x="${width / 2}" y="${safeZones.topSafePx + 36}" 
          font-family="system-ui, -apple-system, sans-serif" 
          font-size="20" 
          font-weight="500" 
          fill="#D1D5DB" 
          text-anchor="middle" 
          letter-spacing="2">
      ${escapeXml(dateText)}
    </text>`
      : ''
  }

  ${previewWatermarkSvg}

  <!-- Bottom Dark Gradient for Footer -->
  <rect x="0" y="${height - safeZones.bottomSafePx - 60}" width="${width}" height="${safeZones.bottomSafePx + 60}" fill="url(#footerGrad)"/>

  <!-- Footer Branding / Wedding Monogram -->
  <g transform="translate(${safeZones.leftSafePx}, ${footerY})">
    ${
      subTitle
        ? `<text x="0" y="0" 
            font-family="system-ui, -apple-system, sans-serif" 
            font-size="28" 
            font-weight="700" 
            fill="#FFFFFF">
        ${escapeXml(subTitle)}
      </text>`
        : ''
    }
    <text x="0" y="32" 
          font-family="system-ui, -apple-system, sans-serif" 
          font-size="18" 
          font-weight="600" 
          fill="#F59E0B" 
          letter-spacing="1.5">
      POWERED BY T-RED MEDIA • FOTOBOOTH.VN
    </text>
  </g>
</svg>`;
  }
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildWatermarkConfig(overrides?: Partial<WatermarkConfig>): WatermarkConfig {
  return WatermarkEngine.buildWatermarkConfig(overrides);
}

export function generateOverlaySvgTemplate(options: OverlayFrameOptions): string {
  return WatermarkEngine.generateOverlaySvg(options);
}
