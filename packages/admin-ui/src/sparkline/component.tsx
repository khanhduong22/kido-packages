import React from 'react';
import { computeSparkline } from './sparkline';
import type { SparklineOptions } from './types';

export interface SparklineProps extends SparklineOptions {
  data: number[];
  style?: React.CSSProperties;
}

/**
 * React Component for Sparkline SVG.
 * Can be rendered client-side or SSR with full hydration parity.
 */
export const Sparkline: React.FC<SparklineProps> = ({
  data,
  style,
  ...options
}) => {
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

  const strokeWidth = options.strokeWidth ?? 2;
  const showFill = (options.fill ?? true) && areaD.length > 0;
  const fillOpacity = options.fillOpacity ?? 0.2;
  const showEndDot = (options.showEndDot ?? true) && endPoint !== null;
  const endDotRadius = options.endDotRadius ?? 3;
  const endDotColor = options.endDotColor ?? effectiveStrokeColor;
  const showMinMax = options.showMinMaxDots ?? false;
  const minDotColor = options.minDotColor ?? '#ea3943';
  const maxDotColor = options.maxDotColor ?? '#16c784';
  const ariaLabel =
    options.ariaLabel ??
    `Sparkline trend: ${trend}, current: ${computed.lastValue}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
      className={options.className}
      style={style}
    >
      {showFill && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={effectiveFillColor}
              stopOpacity={fillOpacity}
            />
            <stop
              offset="100%"
              stopColor={effectiveFillColor}
              stopOpacity={0}
            />
          </linearGradient>
        </defs>
      )}

      {showFill && (
        <path d={areaD} fill={`url(#${gradientId})`} stroke="none" />
      )}

      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke={effectiveStrokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {showMinMax && minPoint && (
        <circle
          cx={Number(minPoint.x.toFixed(2))}
          cy={Number(minPoint.y.toFixed(2))}
          r={endDotRadius}
          fill={minDotColor}
        />
      )}

      {showMinMax && maxPoint && (
        <circle
          cx={Number(maxPoint.x.toFixed(2))}
          cy={Number(maxPoint.y.toFixed(2))}
          r={endDotRadius}
          fill={maxDotColor}
        />
      )}

      {showEndDot && endPoint && (
        <circle
          cx={Number(endPoint.x.toFixed(2))}
          cy={Number(endPoint.y.toFixed(2))}
          r={endDotRadius}
          fill={endDotColor}
        />
      )}
    </svg>
  );
};
