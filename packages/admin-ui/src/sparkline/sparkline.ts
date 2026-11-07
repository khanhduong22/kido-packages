import type {
  Point,
  SparklineComputedData,
  SparklineOptions,
  SparklinePadding,
  Trend,
} from './types';

const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 36;
const DEFAULT_STROKE_WIDTH = 2;
const DEFAULT_COLOR_UP = '#16c784';
const DEFAULT_COLOR_DOWN = '#ea3943';
const DEFAULT_COLOR_NEUTRAL = '#8b949e';
const DEFAULT_FILL_OPACITY = 0.2;
const DEFAULT_PADDING = 4;
const DEFAULT_END_DOT_RADIUS = 3;

/**
 * Detect trend direction based on data points.
 */
export function detectTrend(data: number[]): Trend {
  if (data.length < 2) return 'NEUTRAL';
  const first = data[0];
  const last = data[data.length - 1];
  if (last > first) return 'UP';
  if (last < first) return 'DOWN';
  return 'NEUTRAL';
}

/**
 * Parse padding configuration into standard 4-side object.
 */
export function parsePadding(
  padding: number | Partial<SparklinePadding> | undefined
): SparklinePadding {
  if (typeof padding === 'number') {
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  return {
    top: padding?.top ?? DEFAULT_PADDING,
    right: padding?.right ?? DEFAULT_PADDING,
    bottom: padding?.bottom ?? DEFAULT_PADDING,
    left: padding?.left ?? DEFAULT_PADDING,
  };
}

/**
 * Format float to 2 decimal places, removing unnecessary trailing zeros.
 */
function round(val: number): string {
  return Number(val.toFixed(2)).toString();
}

/**
 * Convert Catmull-Rom spline control points to SVG Cubic Bezier segment.
 */
function catmullRomToBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): string {
  const bp1x = p1.x + (p2.x - p0.x) / 6;
  const bp1y = p1.y + (p2.y - p0.y) / 6;
  const bp2x = p2.x - (p3.x - p1.x) / 6;
  const bp2y = p2.y - (p3.y - p1.y) / 6;

  return `C ${round(bp1x)} ${round(bp1y)}, ${round(bp2x)} ${round(bp2y)}, ${round(p2.x)} ${round(p2.y)}`;
}

/**
 * Build SVG path string from points array using linear or Catmull-Rom smooth interpolation.
 */
export function buildPath(points: Point[], curve: 'smooth' | 'linear'): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M ${round(points[0].x)} ${round(points[0].y)}`;
  }

  if (curve === 'linear' || points.length === 2) {
    let d = `M ${round(points[0].x)} ${round(points[0].y)}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L ${round(points[i].x)} ${round(points[i].y)}`;
    }
    return d;
  }

  // Catmull-Rom to Cubic Bezier
  let d = `M ${round(points[0].x)} ${round(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = i === 0 ? points[0] : points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i + 2 < points.length ? points[i + 2] : p2;
    d += ` ${catmullRomToBezier(p0, p1, p2, p3)}`;
  }
  return d;
}

let counter = 0;

/**
 * Calculate all geometry, trends, colors, and SVG paths for a sparkline dataset.
 */
export function computeSparkline(
  data: number[],
  options: SparklineOptions = {}
): SparklineComputedData {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const pad = parsePadding(options.padding);

  const cleanData = data.filter((v) => Number.isFinite(v));
  const trend = detectTrend(cleanData);

  const colorUp = options.colorUp ?? DEFAULT_COLOR_UP;
  const colorDown = options.colorDown ?? DEFAULT_COLOR_DOWN;
  const colorNeutral = options.colorNeutral ?? DEFAULT_COLOR_NEUTRAL;

  const effectiveStrokeColor =
    options.strokeColor ??
    (trend === 'UP' ? colorUp : trend === 'DOWN' ? colorDown : colorNeutral);

  const effectiveFillColor = options.fillColor ?? effectiveStrokeColor;

  counter++;
  const gradientId = options.id ?? `kt-sparkline-grad-${counter}`;

  if (cleanData.length === 0) {
    return {
      width,
      height,
      points: [],
      trend: 'NEUTRAL',
      min: 0,
      max: 0,
      firstValue: 0,
      lastValue: 0,
      pathD: '',
      areaD: '',
      effectiveStrokeColor,
      effectiveFillColor,
      gradientId,
      endPoint: null,
      minPoint: null,
      maxPoint: null,
    };
  }

  const min = Math.min(...cleanData);
  const max = Math.max(...cleanData);
  const firstValue = cleanData[0];
  const lastValue = cleanData[cleanData.length - 1];

  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const valRange = max - min;

  const points: Point[] = cleanData.map((val, idx) => {
    const x =
      cleanData.length === 1
        ? pad.left + plotW / 2
        : pad.left + (idx / (cleanData.length - 1)) * plotW;

    const y =
      valRange === 0
        ? pad.top + plotH / 2
        : pad.top + plotH - ((val - min) / valRange) * plotH;

    return {
      x,
      y,
      value: val,
      index: idx,
    };
  });

  const curveType = options.curve ?? 'smooth';
  const pathD = buildPath(points, curveType);

  let areaD = '';
  if (points.length > 1 && pathD) {
    const baselineY = height - pad.bottom;
    const lastPt = points[points.length - 1];
    const firstPt = points[0];
    areaD = `${pathD} L ${round(lastPt.x)} ${round(baselineY)} L ${round(firstPt.x)} ${round(baselineY)} Z`;
  }

  let minPoint: Point | null = null;
  let maxPoint: Point | null = null;
  if (points.length > 0) {
    for (const pt of points) {
      if (!minPoint || pt.value < minPoint.value) minPoint = pt;
      if (!maxPoint || pt.value > maxPoint.value) maxPoint = pt;
    }
  }

  const endPoint = points.length > 0 ? points[points.length - 1] : null;

  return {
    width,
    height,
    points,
    trend,
    min,
    max,
    firstValue,
    lastValue,
    pathD,
    areaD,
    effectiveStrokeColor,
    effectiveFillColor,
    gradientId,
    endPoint,
    minPoint,
    maxPoint,
  };
}

/**
 * Generate a standalone, pure mathematical SVG string (SSR, PDF, K80 thermal print, HTML email).
 * Zero DOM or Canvas dependencies.
 */
export function renderSparklineSvg(
  data: number[],
  options: SparklineOptions = {}
): string {
  const computed = computeSparkline(data, options);
  const {
    width,
    height,
    pathD,
    areaD,
    effectiveStrokeColor,
    effectiveFillColor,
    gradientId,
    endPoint,
    minPoint,
    maxPoint,
    trend,
  } = computed;

  const strokeWidth = options.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const showFill = (options.fill ?? true) && areaD.length > 0;
  const fillOpacity = options.fillOpacity ?? DEFAULT_FILL_OPACITY;
  const showEndDot = (options.showEndDot ?? true) && endPoint !== null;
  const endDotRadius = options.endDotRadius ?? DEFAULT_END_DOT_RADIUS;
  const endDotColor = options.endDotColor ?? effectiveStrokeColor;
  const showMinMax = options.showMinMaxDots ?? false;
  const minDotColor = options.minDotColor ?? DEFAULT_COLOR_DOWN;
  const maxDotColor = options.maxDotColor ?? DEFAULT_COLOR_UP;
  const ariaLabel =
    options.ariaLabel ?? `Sparkline trend: ${trend}, current: ${computed.lastValue}`;
  const className = options.className ? ` class="${options.className}"` : '';

  const defs = showFill
    ? `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${effectiveFillColor}" stop-opacity="${fillOpacity}"/><stop offset="100%" stop-color="${effectiveFillColor}" stop-opacity="0"/></linearGradient></defs>`
    : '';

  const areaElement = showFill
    ? `<path d="${areaD}" fill="url(#${gradientId})" stroke="none"/>`
    : '';

  const lineElement = pathD
    ? `<path d="${pathD}" fill="none" stroke="${effectiveStrokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';

  let dots = '';
  if (showMinMax && minPoint && maxPoint) {
    dots += `<circle cx="${round(minPoint.x)}" cy="${round(minPoint.y)}" r="${endDotRadius}" fill="${minDotColor}"/>`;
    dots += `<circle cx="${round(maxPoint.x)}" cy="${round(maxPoint.y)}" r="${endDotRadius}" fill="${maxDotColor}"/>`;
  }

  if (showEndDot && endPoint) {
    dots += `<circle cx="${round(endPoint.x)}" cy="${round(endPoint.y)}" r="${endDotRadius}" fill="${endDotColor}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${ariaLabel}"${className}>${defs}${areaElement}${lineElement}${dots}</svg>`;
}
