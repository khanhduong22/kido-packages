export type Trend = 'UP' | 'DOWN' | 'NEUTRAL';

export type CurveType = 'smooth' | 'linear';

export interface Point {
  x: number;
  y: number;
  value: number;
  index: number;
}

export interface SparklinePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SparklineOptions {
  /** Width of the SVG in pixels or viewBox units. Default: 120 */
  width?: number;
  /** Height of the SVG in pixels or viewBox units. Default: 36 */
  height?: number;
  /** Thickness of the sparkline path. Default: 2 */
  strokeWidth?: number;
  /** Custom stroke color (overrides auto trend color) */
  strokeColor?: string;
  /** Color when trend is positive/increasing. Default: #16c784 */
  colorUp?: string;
  /** Color when trend is negative/decreasing. Default: #ea3943 */
  colorDown?: string;
  /** Color when trend is flat/neutral. Default: #8b949e */
  colorNeutral?: string;
  /** Whether to render translucent gradient fill area under the line. Default: true */
  fill?: boolean;
  /** Custom fill color / gradient base color */
  fillColor?: string;
  /** Top opacity for the gradient fill. Default: 0.2 */
  fillOpacity?: number;
  /** Interpolation curve type: 'smooth' (cubic Catmull-Rom) or 'linear'. Default: 'smooth' */
  curve?: CurveType;
  /** Render marker dot at the final (latest) data point. Default: true */
  showEndDot?: boolean;
  /** Radius of the end dot. Default: 3 */
  endDotRadius?: number;
  /** Color of the end dot (defaults to effective stroke color) */
  endDotColor?: string;
  /** Render marker dots at min and max data points. Default: false */
  showMinMaxDots?: boolean;
  /** Color of the min marker dot. Default: #ea3943 */
  minDotColor?: string;
  /** Color of the max marker dot. Default: #16c784 */
  maxDotColor?: string;
  /** Padding inside SVG canvas to prevent stroke clipping. Default: 4 */
  padding?: number | Partial<SparklinePadding>;
  /** Unique ID for linearGradient definitions (auto-generated if omitted) */
  id?: string;
  /** Additional CSS class name */
  className?: string;
  /** Accessibility label. Default: "Sparkline trend chart" */
  ariaLabel?: string;
}

export interface SparklineComputedData {
  width: number;
  height: number;
  points: Point[];
  trend: Trend;
  min: number;
  max: number;
  firstValue: number;
  lastValue: number;
  pathD: string;
  areaD: string;
  effectiveStrokeColor: string;
  effectiveFillColor: string;
  gradientId: string;
  endPoint: Point | null;
  minPoint: Point | null;
  maxPoint: Point | null;
}
