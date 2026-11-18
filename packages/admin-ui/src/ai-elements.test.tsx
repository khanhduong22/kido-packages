import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  // Chain of Thought & Trace
  ChainOfThought,
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
  formatTraceDuration,
  resolveStepIcon,
  type ChainOfThoughtStep,
  // Sources Citation
  SourcesCitation,
  SourceScoreBadge,
  SourceChip,
  SourceCard,
  normalizeScore,
  resolveSourceIcon,
  type CitationSource,
} from './index';

describe('@kido/admin-ui AI Elements Suite', () => {
  describe('1. Duration & Metric Formatting Helpers', () => {
    it('formats milliseconds under 1000ms correctly', () => {
      expect(formatTraceDuration(42)).toBe('42ms');
      expect(formatTraceDuration(850)).toBe('850ms');
    });

    it('formats seconds over 1000ms with 1 decimal place', () => {
      expect(formatTraceDuration(1200)).toBe('1.2s');
      expect(formatTraceDuration(3450)).toBe('3.5s');
    });

    it('formats when passed as seconds (isSeconds = true)', () => {
      expect(formatTraceDuration(1.4, true)).toBe('1.4s');
      expect(formatTraceDuration(0.35, true)).toBe('350ms');
    });

    it('gracefully handles undefined or null duration', () => {
      expect(formatTraceDuration(undefined)).toBe('');
      expect(formatTraceDuration(NaN)).toBe('');
    });
  });

  describe('2. Step Icon Resolution', () => {
    it('resolves running status to loader icon', () => {
      const icon = resolveStepIcon('search', 'running');
      const html = renderToString(<div>{icon}</div>);
      expect(html).toContain('animate-spin');
    });

    it('resolves error status to alert icon', () => {
      const icon = resolveStepIcon('search', 'error');
      const html = renderToString(<div>{icon}</div>);
      expect(html).toContain('circle-alert');
    });

    it('resolves specific step types correctly', () => {
      const searchHtml = renderToString(<div>{resolveStepIcon('search')}</div>);
      expect(searchHtml).toContain('lucide-search');

      const rerankHtml = renderToString(<div>{resolveStepIcon('rerank')}</div>);
      expect(rerankHtml).toContain('lucide-arrow-up-down');

      const pruneHtml = renderToString(<div>{resolveStepIcon('prune')}</div>);
      expect(pruneHtml).toContain('lucide-filter');

      const reasonHtml = renderToString(<div>{resolveStepIcon('reason')}</div>);
      expect(reasonHtml).toContain('lucide-brain');

      const toolHtml = renderToString(<div>{resolveStepIcon('tool')}</div>);
      expect(toolHtml).toContain('lucide-terminal');
    });
  });

  describe('3. Score Normalization & Score Badges', () => {
    it('normalizes decimal scores (<= 1.0) into percentages', () => {
      expect(normalizeScore(0.92)).toEqual({ percentage: 92, label: '92%' });
      expect(normalizeScore(0.678)).toEqual({ percentage: 68, label: '68%' });
    });

    it('normalizes integer scores (> 1.0) into percentages', () => {
      expect(normalizeScore(88)).toEqual({ percentage: 88, label: '88%' });
    });

    it('handles null and undefined scores', () => {
      expect(normalizeScore(undefined)).toBeNull();
    });

    it('renders SourceScoreBadge with correct color tier', () => {
      // Emerald tier (>= 80%)
      const highHtml = renderToString(<SourceScoreBadge score={0.94} />);
      expect(highHtml).toContain('text-emerald-700');
      expect(highHtml).toContain('94%');

      // Sky tier (65% - 79%)
      const midHtml = renderToString(<SourceScoreBadge score={0.72} />);
      expect(midHtml).toContain('text-sky-700');
      expect(midHtml).toContain('72%');

      // Amber tier (< 65%)
      const lowHtml = renderToString(<SourceScoreBadge score={0.55} />);
      expect(lowHtml).toContain('text-amber-700');
      expect(lowHtml).toContain('55%');
    });
  });

  describe('4. ChainOfThought Component', () => {
    it('renders thinking state with animated pulse and default title', () => {
      const html = renderToString(<ChainOfThought isThinking={true} />);
      expect(html).toContain('Thinking...');
      expect(html).toContain('animate-pulse');
      expect(html).toContain('animate-ping');
    });

    it('renders completed state with elapsed duration and step count', () => {
      const steps: ChainOfThoughtStep[] = [
        { title: 'Vector DB Recall', stepType: 'search', status: 'completed', durationMs: 120 },
        { title: 'Cross-Encoder Reranking', stepType: 'rerank', status: 'completed', durationMs: 450 },
        { title: 'Context Pruning', stepType: 'prune', status: 'completed', durationMs: 15 },
      ];

      const html = renderToString(
        <ChainOfThought
          durationSeconds={1.4}
          steps={steps}
          defaultOpen={true}
        />
      );

      expect(html).toContain('Thought for 1.4s');
      expect(html).toContain('3 steps');
      expect(html).toContain('Vector DB Recall');
      expect(html).toContain('Cross-Encoder Reranking');
      expect(html).toContain('Context Pruning');
    });

    it('renders custom title and handles error status', () => {
      const html = renderToString(
        <ChainOfThought
          status="error"
          title="Pipeline aborted"
        />
      );
      expect(html).toContain('Pipeline aborted');
      expect(html).toContain('bg-rose-100');
    });
  });

  describe('5. Trace and TraceLine Primitives', () => {
    it('renders TraceLine with icon, title, description, and duration', () => {
      const html = renderToString(
        <Trace>
          <TraceLine
            stepType="rerank"
            status="completed"
            title="Cohere Rerank"
            description="Score jump from 0.72 to 0.89"
            durationMs={230}
          />
        </Trace>
      );

      expect(html).toContain('Cohere Rerank');
      expect(html).toContain('Score jump from 0.72 to 0.89');
      expect(html).toContain('230ms');
      expect(html).toContain('lucide-arrow-up-down');
    });

    it('renders collapsible trace step when details or output is present', () => {
      const html = renderToString(
        <TraceLine
          stepType="tool"
          title="Execute SQL Query"
          details="SELECT * FROM products WHERE embedding <=> $1 LIMIT 5;"
          defaultOpen={true}
        />
      );

      expect(html).toContain('Execute SQL Query');
      expect(html).toContain('SELECT * FROM products');
    });
  });

  describe('6. SourcesCitation Component', () => {
    const mockSources: CitationSource[] = [
      {
        id: 'chunk-1',
        title: 'Quy định chấm công & ca trực',
        url: 'https://docs.example.com/docs/attendance',
        snippet: 'Nhân viên đi muộn quá 15 phút sẽ bị trừ 50.000đ vào quỹ chuyên cần.',
        score: 0.94,
        sourceType: 'document',
        metadata: { path: 'docs/attendance.md', chunkIndex: 2 },
      },
      {
        id: 'prod-101',
        title: 'Màu Nước Giorgione 36 Màu Kèm Cọ',
        url: 'https://store.example.com/products/giorgione-36',
        snippet: 'Bộ màu nước cao cấp hạt màu mịn màng, kèm cọ vẽ chi tiết.',
        score: 0.88,
        sourceType: 'product',
        metadata: { price: 185000, sku: 'GIOR-36' },
      },
    ];

    it('renders chips variant with badge pills, scores, and links', () => {
      const html = renderToString(
        <SourcesCitation sources={mockSources} variant="chips" />
      );

      expect(html).toContain('Used 2 sources:');
      expect(html).toContain('Quy định chấm công &amp; ca trực');
      expect(html).toContain('Màu Nước Giorgione 36 Màu Kèm Cọ');
      expect(html).toContain('94%');
      expect(html).toContain('88%');
      expect(html).toContain('href="https://docs.example.com/docs/attendance"');
    });

    it('renders collapsible variant with expanded cards, snippets, and metadata', () => {
      const html = renderToString(
        <SourcesCitation
          sources={mockSources}
          variant="collapsible"
          defaultOpen={true}
        />
      );

      expect(html).toContain('Used 2 sources');
      expect(html).toContain('Nhân viên đi muộn quá 15 phút');
      expect(html).toContain('Chunk #2');
      expect(html).toContain('185.000');
    });

    it('renders nothing when sources array is empty', () => {
      const html = renderToString(<SourcesCitation sources={[]} />);
      expect(html).toBe('');
    });
  });
});
