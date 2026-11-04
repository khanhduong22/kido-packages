import {
  FontMetricOverrideConfig,
  FontMetricPreset,
  FontSubsetDefinition,
} from './types';

export const VIETNAMESE_UNICODE_RANGE =
  'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB';

export const LATIN_UNICODE_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

/**
 * Calibrated system-font metric presets to eliminate layout shift (CLS = 0.000)
 * when pairing `font-display: optional` web fonts with local system fonts.
 */
export const FONT_METRIC_PRESETS: Record<
  'INTER_ARIAL_FALLBACK' | 'ROBOTO_ARIAL_FALLBACK' | 'PLUS_JAKARTA_SANS_ARIAL_FALLBACK',
  FontMetricPreset & { fontFamily: string }
> = {
  INTER_ARIAL_FALLBACK: {
    fontFamily: 'Inter',
    fallbackFamilyName: 'Inter Fallback',
    localFontSource: 'Arial',
    ascentOverride: '90.44%',
    descentOverride: '22.52%',
    lineGapOverride: '0.00%',
    sizeAdjust: '107.12%',
  },
  ROBOTO_ARIAL_FALLBACK: {
    fontFamily: 'Roboto',
    fallbackFamilyName: 'Roboto Fallback',
    localFontSource: 'Arial',
    ascentOverride: '92.77%',
    descentOverride: '24.41%',
    lineGapOverride: '0.00%',
    sizeAdjust: '100.00%',
  },
  PLUS_JAKARTA_SANS_ARIAL_FALLBACK: {
    fontFamily: 'Plus Jakarta Sans',
    fallbackFamilyName: 'Plus Jakarta Sans Fallback',
    localFontSource: 'Arial',
    ascentOverride: '98.14%',
    descentOverride: '26.82%',
    lineGapOverride: '0.00%',
    sizeAdjust: '104.88%',
  },
};

function renderSubsetFontFace(
  fontFamily: string,
  fontDisplay: string,
  subset: FontSubsetDefinition
): string {
  const fontStyle = subset.fontStyle ?? 'normal';
  const fontWeight = subset.fontWeight ?? '100 900';
  const format = subset.format ?? 'woff2';
  const lines = [
    '@font-face {',
    `  font-family: '${fontFamily}';`,
    `  font-style: ${fontStyle};`,
    `  font-weight: ${fontWeight};`,
    `  font-display: ${fontDisplay};`,
    `  src: url('${subset.srcUrl}') format('${format}');`,
  ];
  if (subset.unicodeRange) {
    lines.push(`  unicode-range: ${subset.unicodeRange};`);
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Generates Zero-CLS `@font-face` CSS rules with `font-display: optional` and
 * calibrated metric overrides (`ascent-override`, `descent-override`,
 * `line-gap-override`, `size-adjust`) to guarantee `CLS = 0.000`.
 */
export function generateFontFallbackCss(
  config: FontMetricOverrideConfig
): string {
  const fontFamily = config.fontFamily;
  const fallbackFamilyName =
    config.fallbackFamilyName ?? `${fontFamily} Fallback`;
  const localFontSource = config.localFontSource ?? 'Arial';
  const fontDisplay = config.fontDisplay ?? 'optional';

  const blocks: string[] = [];

  if (config.subsets && config.subsets.length > 0) {
    for (const subset of config.subsets) {
      blocks.push(renderSubsetFontFace(fontFamily, fontDisplay, subset));
    }
  }

  blocks.push(
    [
      '@font-face {',
      `  font-family: '${fallbackFamilyName}';`,
      `  src: local('${localFontSource}');`,
      `  ascent-override: ${config.ascentOverride};`,
      `  descent-override: ${config.descentOverride};`,
      `  line-gap-override: ${config.lineGapOverride};`,
      `  size-adjust: ${config.sizeAdjust};`,
      '}',
    ].join('\n')
  );

  if (config.cssVariableName) {
    blocks.push(
      `html { ${config.cssVariableName}: '${fontFamily}', '${fallbackFamilyName}', sans-serif; font-family: var(${config.cssVariableName}); }`
    );
  }

  return blocks.join('\n');
}
