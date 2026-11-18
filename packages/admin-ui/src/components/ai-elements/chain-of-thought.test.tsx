import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
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
} from './chain-of-thought';
import {
  SourcesCitation,
  SourceScoreBadge,
  SourceChip,
  SourceCard,
  normalizeScore,
  resolveSourceIcon,
  type CitationSource,
} from './sources-citation';

describe('shadcn AI Elements - ChainOfThought, TraceLine, and SourcesCitation', () => {
  // ==========================================================================
  // 1. ChainOfThought Container Tests
  // ==========================================================================
  describe('ChainOfThought Component', () => {
    it('renders active thinking state with pulsing animation and default thinking title', () => {
      const html = renderToString(<ChainOfThought isThinking={true} />);
      expect(html).toContain('Thinking...');
      expect(html).toContain('animate-pulse');
      expect(html).toContain('animate-ping');
    });

    it('renders elapsed timer when durationSeconds or durationMs is provided', () => {
      const secHtml = renderToString(
        <ChainOfThought isThinking={false} durationSeconds={1.5} />
      );
      expect(secHtml).toContain('Thought for 1.5s');

      const msHtml = renderToString(
        <ChainOfThought isThinking={false} durationMs={450} />
      );
      expect(msHtml).toContain('Thought for 450ms');
    });

    it('honors custom title and step count badge', () => {
      const html = renderToString(
        <ChainOfThought
          title="Aria Multi-Agent Reasoning"
          stepsCount={4}
          isThinking={false}
        />
      );
      expect(html).toContain('Aria Multi-Agent Reasoning');
      expect(html).toContain('4 steps');
    });

    it('renders error status with alert styling', () => {
      const html = renderToString(
        <ChainOfThought status="error" title="Reasoning failed on timeout" />
      );
      expect(html).toContain('Reasoning failed on timeout');
      expect(html).toContain('text-rose-600');
    });

    it('renders data-driven reasoning steps inside container when defaultOpen is true', () => {
      const steps: ChainOfThoughtStep[] = [
        {
          id: 'step-1',
          title: 'Broad Recall',
          description: 'Retrieved 20 raw candidates from pgvector',
          stepType: 'search',
          status: 'completed',
          durationMs: 85,
        },
        {
          id: 'step-2',
          title: 'Cross-Encoder Reranking',
          description: 'Evaluating semantic similarity and beginner synergy',
          stepType: 'rerank',
          status: 'running',
          durationMs: 230,
        },
        {
          id: 'step-3',
          title: 'Pruning & Thresholding',
          description: 'Selected top 4 art supplies',
          stepType: 'prune',
          status: 'pending',
        },
      ];

      const html = renderToString(
        <ChainOfThought
          steps={steps}
          defaultOpen={true}
          summary="Hybrid RRF + Two-Stage Rerank Pipeline"
        />
      );

      // Title & badge
      expect(html).toContain('3 steps');
      expect(html).toContain('Hybrid RRF + Two-Stage Rerank Pipeline');

      // Step contents
      expect(html).toContain('Broad Recall');
      expect(html).toContain('Retrieved 20 raw candidates');
      expect(html).toContain('85ms');

      expect(html).toContain('Cross-Encoder Reranking');
      expect(html).toContain('animate-spin');

      expect(html).toContain('Pruning &amp; Thresholding');
    });

    it('renders compound children when steps prop is not provided', () => {
      const html = renderToString(
        <ChainOfThought defaultOpen={true}>
          <TraceLine
            title="Custom Manual Step"
            description="Child component reasoning trace"
            status="completed"
          />
        </ChainOfThought>
      );
      expect(html).toContain('Custom Manual Step');
      expect(html).toContain('Child component reasoning trace');
    });
  });

  // ==========================================================================
  // 2. TraceLine Primitive Tests
  // ==========================================================================
  describe('TraceLine Primitive', () => {
    it('renders proper icons and styles for each stepType', () => {
      const searchHtml = renderToString(<TraceLine stepType="search" title="Search Step" />);
      expect(searchHtml).toContain('lucide-search');

      const rerankHtml = renderToString(<TraceLine stepType="rerank" title="Rerank Step" />);
      expect(rerankHtml).toContain('lucide-arrow-up-down');

      const pruneHtml = renderToString(<TraceLine stepType="prune" title="Prune Step" />);
      expect(pruneHtml).toContain('lucide-filter');

      const toolHtml = renderToString(<TraceLine stepType="tool" title="Tool Execution" />);
      expect(toolHtml).toContain('lucide-terminal');

      const embedHtml = renderToString(<TraceLine stepType="embed" title="Embedding" />);
      expect(embedHtml).toContain('lucide-layers');
    });

    it('renders spinner when status is running', () => {
      const html = renderToString(
        <TraceLine stepType="rerank" status="running" title="Scoring items" />
      );
      expect(html).toContain('animate-spin');
      expect(html).toContain('Scoring items');
    });

    it('renders error icon and styling when status is error', () => {
      const html = renderToString(
        <TraceLine status="error" title="API Gateway 504 Gateway Timeout" />
      );
      expect(html).toContain('lucide-circle-alert');
      expect(html).toContain('text-rose-700');
    });

    it('renders formatted durationMs badge with clock icon', () => {
      const html = renderToString(
        <TraceLine title="Quick lookup" durationMs={35} />
      );
      expect(html).toContain('35ms');
      expect(html).toContain('lucide-clock');

      const secHtml = renderToString(
        <TraceLine title="Heavy inference" durationMs={2450} />
      );
      expect(secHtml).toContain('2.5s');
    });

    it('wraps details in TraceCollapsible when details string is provided', () => {
      const html = renderToString(
        <TraceLine
          title="Vector similarity query"
          defaultOpen={true}
          details="SELECT id, name, 1 - (embedding <=> $1) as score FROM products LIMIT 20;"
        />
      );
      expect(html).toContain('Vector similarity query');
      expect(html).toContain('SELECT id, name, 1 - (embedding &lt;=&gt; $1)');
    });

    it('supports custom icon override', () => {
      const html = renderToString(
        <TraceLine
          icon={<span data-testid="custom-gemini-icon">✨</span>}
          title="Gemini Custom Step"
        />
      );
      expect(html).toContain('data-testid="custom-gemini-icon"');
    });
  });

  // ==========================================================================
  // 3. SourcesCitation Component Tests
  // ==========================================================================
  describe('SourcesCitation Component', () => {
    const sampleSources: CitationSource[] = [
      {
        id: 'p-1',
        title: 'Màu Nước Holbein Artists Watercolors 15ml',
        url: 'https://store.example.com/products/holbein-15ml',
        score: 0.94,
        sourceType: 'product',
        snippet: 'Dòng màu nước hạng hoạ sĩ cao cấp Nhật Bản, độ tinh khiết hạt sắc tố cực cao.',
        metadata: {
          price: 185000,
          sku: 'HLB-W15',
        },
      },
      {
        id: 'p-2',
        title: 'Cọ Vẽ Màu Nước Raphael Kaërell 8344',
        url: 'https://store.example.com/products/raphael-8344',
        score: 0.78,
        sourceType: 'product',
        snippet: 'Cọ sợi tổng hợp cao cấp giữ nước tốt, tạo nét mềm mại.',
        metadata: {
          price: 120000,
        },
      },
      {
        id: 'doc-3',
        title: 'Hướng dẫn bảo quản cọ màu nước đúng cách',
        score: 0.55,
        sourceType: 'document',
        snippet: 'Tránh ngâm đầu cọ chúi xuống đáy lọ nước để không gãy đầu lông cọ.',
        metadata: {
          path: '/sop/knowledge/brush-care.md',
          chunkIndex: 2,
        },
      },
    ];

    it('returns null when sources array is empty or undefined', () => {
      expect(renderToString(<SourcesCitation sources={[]} />)).toBe('');
    });

    it('renders chips variant with index tags, titles, and score badges', () => {
      const html = renderToString(
        <SourcesCitation sources={sampleSources} variant="chips" title="Cited Art Supplies" />
      );

      expect(html).toContain('Cited Art Supplies:');
      expect(html).toContain('[1]');
      expect(html).toContain('Màu Nước Holbein Artists Watercolors 15ml');
      expect(html).toContain('[2]');
      expect(html).toContain('Cọ Vẽ Màu Nước Raphael Kaërell 8344');

      // Score badges
      expect(html).toContain('94%');
      expect(html).toContain('78%');
      expect(html).toContain('55%');

      // External links
      expect(html).toContain('href="https://store.example.com/products/holbein-15ml"');
      expect(html).toContain('target="_blank"');
    });

    it('respects maxVisible limit and shows remaining count in chips variant', () => {
      const html = renderToString(
        <SourcesCitation sources={sampleSources} variant="chips" maxVisible={1} />
      );
      expect(html).toContain('Màu Nước Holbein Artists Watercolors 15ml');
      expect(html).not.toContain('Cọ Vẽ Màu Nước Raphael Kaërell 8344');
      const cleanHtml = html.replace(/<!-- -->/g, '');
      expect(cleanHtml).toContain('+2 more');
    });

    it('renders collapsible variant with detailed source cards when open', () => {
      const html = renderToString(
        <SourcesCitation
          sources={sampleSources}
          variant="collapsible"
          title="Matched Knowledge Chunks"
          defaultOpen={true}
        />
      );

      expect(html).toContain('Matched Knowledge Chunks');
      expect(html).toContain('3'); // Total count badge

      // Snippet quotes
      expect(html).toContain('Dòng màu nước hạng hoạ sĩ cao cấp Nhật Bản');
      expect(html).toContain('Tránh ngâm đầu cọ chúi xuống đáy lọ nước');

      // Metadata rendering
      expect(html).toContain('/sop/knowledge/brush-care.md');
      expect(html).toContain('Chunk #2');
      expect(html).toContain('185.000'); // Formatted VND price
    });
  });

  // ==========================================================================
  // 4. SourceScoreBadge and Color Tier Tests
  // ==========================================================================
  describe('SourceScoreBadge Component', () => {
    it('applies emerald styling for high scores (>= 80%)', () => {
      const html = renderToString(<SourceScoreBadge score={0.88} />);
      expect(html).toContain('88%');
      expect(html).toContain('text-emerald-700');
    });

    it('applies sky styling for medium scores (65% - 79%)', () => {
      const html = renderToString(<SourceScoreBadge score={72} />);
      expect(html).toContain('72%');
      expect(html).toContain('text-sky-700');
    });

    it('applies amber styling for lower scores (< 65%)', () => {
      const html = renderToString(<SourceScoreBadge score={0.48} />);
      expect(html).toContain('48%');
      expect(html).toContain('text-amber-700');
    });

    it('returns null for undefined or NaN score', () => {
      expect(renderToString(<SourceScoreBadge score={undefined} />)).toBe('');
      expect(renderToString(<SourceScoreBadge score={NaN} />)).toBe('');
    });
  });

  // ==========================================================================
  // 5. Utility & Normalization Helper Tests
  // ==========================================================================
  describe('Helpers and Utilities', () => {
    it('normalizes decimal vs percentage scores correctly', () => {
      expect(normalizeScore(0.954)).toEqual({ percentage: 95, label: '95%' });
      expect(normalizeScore(0.641)).toEqual({ percentage: 64, label: '64%' });
      expect(normalizeScore(1.0)).toEqual({ percentage: 100, label: '100%' });
      expect(normalizeScore(82)).toEqual({ percentage: 82, label: '82%' });
      expect(normalizeScore(undefined)).toBeNull();
    });

    it('formats trace durations accurately', () => {
      expect(formatTraceDuration(50)).toBe('50ms');
      expect(formatTraceDuration(999)).toBe('999ms');
      expect(formatTraceDuration(1000)).toBe('1.0s');
      expect(formatTraceDuration(2750)).toBe('2.8s');
      expect(formatTraceDuration(1.25, true)).toBe('1.3s');
      expect(formatTraceDuration(0.04, true)).toBe('40ms');
      expect(formatTraceDuration(undefined)).toBe('');
    });

    it('resolves correct source type icons', () => {
      const productIcon = renderToString(<div>{resolveSourceIcon('product')}</div>);
      expect(productIcon).toContain('lucide-shopping-bag');

      const webIcon = renderToString(<div>{resolveSourceIcon('web')}</div>);
      expect(webIcon).toContain('lucide-globe');

      const faqIcon = renderToString(<div>{resolveSourceIcon('faq')}</div>);
      expect(faqIcon).toMatch(/lucide-(circle-help|help-circle)/);

      const codeIcon = renderToString(<div>{resolveSourceIcon('code')}</div>);
      expect(codeIcon).toMatch(/lucide-(code-xml|code-2|code)/);

      const vectorIcon = renderToString(<div>{resolveSourceIcon('vector_chunk')}</div>);
      expect(vectorIcon).toContain('lucide-layers');

      const docIcon = renderToString(<div>{resolveSourceIcon('document')}</div>);
      expect(docIcon).toContain('lucide-file-text');
    });
  });
});
