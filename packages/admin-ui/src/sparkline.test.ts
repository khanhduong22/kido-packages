import { describe, expect, it } from 'bun:test';
import React from 'react';
import {
  Sparkline,
  buildPath,
  computeSparkline,
  detectTrend,
  parsePadding,
  renderSparklineSvg,
} from './index';

describe('@kido/sparkline-svg', () => {
  describe('detectTrend', () => {
    it('detects UP trend when values increase', () => {
      expect(detectTrend([10, 15, 20, 30])).toBe('UP');
      expect(detectTrend([10, 5, 20])).toBe('UP');
    });

    it('detects DOWN trend when values decrease', () => {
      expect(detectTrend([30, 20, 10])).toBe('DOWN');
      expect(detectTrend([10, 50, 5])).toBe('DOWN');
    });

    it('detects NEUTRAL when flat or insufficient data', () => {
      expect(detectTrend([10, 10, 10])).toBe('NEUTRAL');
      expect(detectTrend([10])).toBe('NEUTRAL');
      expect(detectTrend([])).toBe('NEUTRAL');
    });
  });

  describe('parsePadding', () => {
    it('handles numeric padding', () => {
      expect(parsePadding(8)).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
    });

    it('handles partial padding with defaults', () => {
      expect(parsePadding({ top: 10, bottom: 5 })).toEqual({
        top: 10,
        right: 4,
        bottom: 5,
        left: 4,
      });
    });
  });

  describe('buildPath', () => {
    const points = [
      { x: 0, y: 10, value: 10, index: 0 },
      { x: 50, y: 30, value: 30, index: 1 },
      { x: 100, y: 20, value: 20, index: 2 },
    ];

    it('builds linear SVG path', () => {
      const path = buildPath(points, 'linear');
      expect(path).toBe('M 0 10 L 50 30 L 100 20');
    });

    it('builds smooth Catmull-Rom cubic Bezier SVG path', () => {
      const path = buildPath(points, 'smooth');
      expect(path).toContain('M 0 10');
      expect(path).toContain('C ');
    });

    it('handles empty and single point gracefully', () => {
      expect(buildPath([], 'smooth')).toBe('');
      expect(buildPath([points[0]], 'smooth')).toBe('M 0 10');
    });
  });

  describe('computeSparkline', () => {
    it('computes correct min, max and trend coordinates', () => {
      const data = [100, 200, 150, 300];
      const res = computeSparkline(data, { width: 200, height: 50 });

      expect(res.width).toBe(200);
      expect(res.height).toBe(50);
      expect(res.min).toBe(100);
      expect(res.max).toBe(300);
      expect(res.trend).toBe('UP');
      expect(res.points.length).toBe(4);
      expect(res.effectiveStrokeColor).toBe('#16c784');
      expect(res.areaD).toContain('Z');
    });

    it('computes DOWN trend with red color', () => {
      const data = [500, 400, 300, 100];
      const res = computeSparkline(data);
      expect(res.trend).toBe('DOWN');
      expect(res.effectiveStrokeColor).toBe('#ea3943');
    });

    it('handles flatline / identical values without division by zero', () => {
      const data = [50, 50, 50];
      const res = computeSparkline(data, { height: 40 });
      expect(res.trend).toBe('NEUTRAL');
      expect(res.effectiveStrokeColor).toBe('#8b949e');
      for (const pt of res.points) {
        expect(Number.isFinite(pt.y)).toBe(true);
      }
    });

    it('handles empty data gracefully', () => {
      const res = computeSparkline([]);
      expect(res.points.length).toBe(0);
      expect(res.pathD).toBe('');
      expect(res.areaD).toBe('');
    });
  });

  describe('renderSparklineSvg', () => {
    it('renders pure SVG string with trend gradient and end dot', () => {
      const svg = renderSparklineSvg([10, 25, 18, 40, 55], {
        width: 140,
        height: 40,
        className: 'chart-sparkline',
      });

      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).toContain('viewBox="0 0 140 40"');
      expect(svg).toContain('class="chart-sparkline"');
      expect(svg).toContain('<defs><linearGradient');
      expect(svg).toContain('#16c784'); // UP color
      expect(svg).toContain('<circle'); // End dot
    });

    it('renders red sparkline when trend decreases', () => {
      const svg = renderSparklineSvg([100, 90, 70, 20]);
      expect(svg).toContain('#ea3943'); // DOWN color
    });

    it('supports custom stroke and fill colors', () => {
      const svg = renderSparklineSvg([10, 20, 30], {
        strokeColor: '#3b82f6',
        fillColor: '#60a5fa',
        fill: true,
      });
      expect(svg).toContain('#3b82f6');
      expect(svg).toContain('#60a5fa');
    });

    it('disables fill when fill is false', () => {
      const svg = renderSparklineSvg([10, 20, 30], { fill: false });
      expect(svg).not.toContain('<linearGradient');
    });

    it('renders min and max dots when configured', () => {
      const svg = renderSparklineSvg([10, 50, 5, 40], {
        showMinMaxDots: true,
        showEndDot: true,
      });
      // 2 circles for min/max + 1 for end = 3 circles
      const matches = svg.match(/<circle/g);
      expect(matches?.length).toBe(3);
    });
  });

  describe('React Component Sparkline', () => {
    it('instantiates React element without errors', () => {
      const element = React.createElement(Sparkline, {
        data: [1, 5, 2, 8, 4],
        width: 100,
        height: 30,
      });
      expect(element).toBeDefined();
      expect(element.props.data).toEqual([1, 5, 2, 8, 4]);
    });
  });
});
