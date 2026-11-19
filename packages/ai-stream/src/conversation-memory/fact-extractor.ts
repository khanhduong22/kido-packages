/**
 * @kido/ai-stream/conversation-memory - Zero-Dependency Fact Extractor & Temporal Superseding
 *
 * Distilled from Mem0 (~69k★ fact extraction), Zep/Graphiti (~32k★ temporal superseding),
 * and Letta (~25.5k★ pinned core memory blocks).
 *
 * Invariant: 100% self-contained (zero external deps, zero sibling-slice imports).
 */

import {
  estimateMemoryTextTokens,
  truncateTextToTokenBudget,
  type ConversationTurn,
} from './token-budget.js';

export type MemoryFactCategory =
  | 'order_id'
  | 'ticket_id'
  | 'sku'
  | 'budget'
  | 'price'
  | 'color'
  | 'product'
  | 'preference'
  | 'quantity'
  | 'plan'
  | 'shipping';

export interface ConversationMemoryFact {
  /** Stable canonical key for temporal superseding (e.g. `order_id:ORD-4821` or `budget`). */
  key: string;
  category: MemoryFactCategory;
  /** Canonical extracted value (e.g. `ORD-4821`, `$150`, `cobalt blue`). */
  value: string;
  /** Bounded provenance snippet from the originating turn. */
  evidence: string;
  /** 1-based conversation turn where this fact took effect. */
  validTurn: number;
  /** 1-based turn when a newer value superseded this fact (bi-temporal invalidation). */
  supersededAtTurn?: number;
  /** Extraction confidence in [0, 1]. */
  confidence: number;
}

export interface MergeMemoryFactsOptions {
  retainSupersededHistory?: boolean;
  maxActiveFacts?: number;
}

export interface MergeMemoryFactsResult {
  activeFacts: ConversationMemoryFact[];
  supersededFacts: ConversationMemoryFact[];
  allFacts: ConversationMemoryFact[];
}

export interface BackReferenceMatch {
  detected: boolean;
  matchedPhrases: string[];
  referencedCategories: MemoryFactCategory[];
}

interface FactRule {
  regex: RegExp;
  category: MemoryFactCategory;
  confidence: number;
  build: (m: RegExpExecArray) => { key: string; value: string } | null;
}

const CATEGORY_PRIORITY: Readonly<Record<MemoryFactCategory, number>> = Object.freeze({
  order_id: 100, ticket_id: 95, sku: 90, budget: 85, plan: 80,
  product: 75, color: 70, shipping: 65, quantity: 60, price: 55, preference: 50,
});

const MONEY_EXPR =
  '(?:\\$\\s*\\d+(?:,\\d{3})*(?:\\.\\d{1,2})?|€\\s*\\d+(?:,\\d{3})*(?:\\.\\d{1,2})?|£\\s*\\d+(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?\\s*(?:usd|vnd|đ|d|k\\b|trieu|triệu))';

const slugify = (v: string): string =>
  v.trim().toLowerCase().replace(/[^a-z0-9\u00c0-\u1ef9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 32);

const normVal = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, ' ');

const compactEvidence = (t: string): string => {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length <= 90 ? s : `${s.slice(0, 87).trimEnd()}...`;
};

const upperId = (prefix: string) => (m: RegExpExecArray) => {
  const id = (m[1] ?? '').toUpperCase();
  return id.length >= 3 ? { key: `${prefix}:${id}`, value: id } : null;
};

const singletonLower = (key: string) => (m: RegExpExecArray) => {
  const val = (m[1] ?? '').trim().toLowerCase();
  return val.length > 0 ? { key, value: val } : null;
};

const singletonAmount = (key: string) => (m: RegExpExecArray) => {
  const amt = (m[1] ?? '').replace(/\s+/g, '').replace(/[.,]+$/, '');
  return amt.length > 0 ? { key, value: amt } : null;
};

const sluggedEntity = (prefix: string) => (m: RegExpExecArray) => {
  const val = (m[1] ?? '').trim().replace(/\s+/g, ' ');
  const slug = slugify(val);
  return slug.length >= 3 ? { key: `${prefix}:${slug}`, value: val } : null;
};

const FACT_RULES: readonly FactRule[] = [
  { regex: /#?\b(ORD[-_]?[A-Z0-9]{2,14})\b/gi, category: 'order_id', confidence: 0.96, build: upperId('order_id') },
  { regex: /\b(?:order|đơn(?:\s+hàng)?)\s*(?:id|number|no\.?|mã)?\s*#?([A-Z]{2,5}[-_]\d{2,10}|\d{4,10})\b/gi, category: 'order_id', confidence: 0.95, build: upperId('order_id') },
  { regex: /#?\b((?:TKT|INC|CASE|SR)[-_]?[A-Z0-9]{2,12})\b/gi, category: 'ticket_id', confidence: 0.94, build: upperId('ticket_id') },
  { regex: /\b(?:ticket|case|incident)\s*(?:id|number|no\.?)?\s*#?(\d{4,10})\b/gi, category: 'ticket_id', confidence: 0.92, build: upperId('ticket_id') },
  { regex: /\b(SKU[-_][A-Z0-9][A-Z0-9_-]{1,18})\b/gi, category: 'sku', confidence: 0.93, build: upperId('sku') },
  {
    regex: /\bSKU\s*:\s*([A-Z0-9][A-Z0-9_-]{2,18})\b/gi,
    category: 'sku',
    confidence: 0.92,
    build: (m) => {
      const raw = (m[1] ?? '').toUpperCase();
      if (raw.length < 3) return null;
      const val = raw.startsWith('SKU') ? raw : `SKU-${raw}`;
      return { key: `sku:${val}`, value: val };
    },
  },
  { regex: new RegExp(`(?:budget(?:\\s+(?:is|of|to|at|around|now|updated\\s+to))?|under|max(?:imum)?|up\\s+to|within|cap(?:ped)?\\s+at|ngân\\s+sách(?:\\s+là|\\s+khoảng|\\s+tối\\s+đa)?|dưới|tối\\s+đa)\\s*:?\\s*(${MONEY_EXPR})`, 'gi'), category: 'budget', confidence: 0.91, build: singletonAmount('budget') },
  { regex: new RegExp(`(?:price(?:d)?\\s*(?:at|is)?|costs?|total(?:ing)?|giá(?:\\s+là)?)\\s*:?\\s*(${MONEY_EXPR})`, 'gi'), category: 'price', confidence: 0.85, build: singletonAmount('price') },
  { regex: /\b(cobalt blue|navy blue|sky blue|emerald green|forest green|olive green|matte black|midnight black|crimson red|ruby red|pearl white|ivory white|charcoal gray|slate grey|space gray|rose gold|silver|gold|black|white|red|blue|green|yellow|orange|purple|pink|beige|brown|xanh dương|xanh lá|đen nhám|đỏ đô|trắng sữa|vàng đồng|tím pastel)\b/gi, category: 'color', confidence: 0.86, build: singletonLower('color') },
  {
    regex: /\b(\d{1,4})\s+(units?|items?|pieces?|packs?|sets?|boxes?|seats?|licenses?|users?|bộ|hộp|chiếc|cái|suất)\b/gi,
    category: 'quantity',
    confidence: 0.84,
    build: (m) => {
      const val = `${m[1] ?? ''} ${(m[2] ?? '').toLowerCase()}`.trim();
      return val.length > 0 ? { key: 'quantity', value: val } : null;
    },
  },
  { regex: /\b((?:free|starter|basic|growth|pro|business|team|enterprise)\s+plan|gói\s+(?:cơ bản|starter|pro|doanh nghiệp|team|enterprise))\b/gi, category: 'plan', confidence: 0.9, build: singletonLower('plan') },
  { regex: /\b((?:standard|economy|express|priority|overnight|next-day|same-day|two-day)\s+(?:shipping|delivery)|giao(?:\s+hàng)?\s+(?:nhanh|hỏa tốc|tiêu chuẩn|trong ngày))\b/gi, category: 'shipping', confidence: 0.88, build: singletonLower('shipping') },
  { regex: /\b(?:ordered|buying|buy|purchased|for\s+my|looking\s+for|interested\s+in|need|want|selected|chose|mua|đặt|cần|tìm)\s+(?:a|an|the|my|chiếc|bộ|cái)?\s*([A-Za-z0-9À-ỹ][A-Za-z0-9À-ỹ\s-]{2,34}?\b(?:mug|bottle|headphones|earbuds|keyboard|mouse|laptop|monitor|backpack|jacket|hoodie|chair|desk|notebook|kit|bundle|adapter|router|camera|lens|lamp|stand|watch|shoes|sneakers|printer|scanner|màu nước|giấy vẽ|bút vẽ|bàn phím|tai nghe|ba lô))\b/gi, category: 'product', confidence: 0.82, build: sluggedEntity('product') },
  { regex: /\b(?:prefer|prefers|would\s+rather|must\s+be|only\s+want|avoid|no\s+plastic|eco-friendly|ưu\s+tiên|thích|không\s+dùng)\s+([^.!?\n;,]{3,42})/gi, category: 'preference', confidence: 0.78, build: sluggedEntity('preference') },
];

const BACK_REFERENCE_RULES: readonly { regex: RegExp; categories: readonly MemoryFactCategory[] }[] = [
  { regex: /\bthat\s+order\b/i, categories: ['order_id', 'product', 'shipping'] },
  { regex: /\b(?:same|earlier|previous)\s+order\b/i, categories: ['order_id', 'product'] },
  { regex: /\bthat\s+(?:ticket|case|incident)\b/i, categories: ['ticket_id'] },
  { regex: /\bthat\s+(?:item|product|one|bundle|kit|set|model)\b/i, categories: ['product', 'sku', 'color'] },
  { regex: /\bthat\s+(?:color|colour|shade)\b/i, categories: ['color'] },
  { regex: /\b(?:my|that|the)\s+(?:updated\s+)?budget\b/i, categories: ['budget'] },
  { regex: /\bthat\s+(?:plan|tier|subscription)\b/i, categories: ['plan'] },
  { regex: /\b(?:from\s+earlier|mentioned\s+earlier|earlier\s+in\s+the\s+chat|earlier)\b/i, categories: ['order_id', 'product', 'budget'] },
  { regex: /\b(?:as\s+we\s+discussed|what\s+we\s+talked\s+about|the\s+same\s+one|previously|before)\b/i, categories: ['order_id', 'product', 'preference'] },
  { regex: /(?:lúc\s+nãy|vừa\s+rồi|ở\s+trước|như\s+trên|ở\s+trên|trước\s+đó)/i, categories: ['order_id', 'product', 'budget'] },
  { regex: /(?:đơn\s+đó|đơn\s+hàng\s+đó|mã\s+đơn\s+đó)/i, categories: ['order_id'] },
  { regex: /(?:cái\s+đó|bộ\s+đó|mẫu\s+đó|loại\s+đó|sản\s+phẩm\s+đó)/i, categories: ['product', 'sku'] },
  { regex: /(?:màu\s+đó|ngân\s+sách\s+(?:đó|cũ|mới))/i, categories: ['color', 'budget'] },
];

function extractFactsFromTurn(turn: ConversationTurn, turnNumber: number): ConversationMemoryFact[] {
  const content = turn.content.trim();
  if (content.length === 0) return [];
  const byKey = new Map<string, ConversationMemoryFact>();
  const evidence = compactEvidence(content);

  for (const rule of FACT_RULES) {
    rule.regex.lastIndex = 0;
    let match = rule.regex.exec(content);
    while (match !== null) {
      const built = rule.build(match);
      if (built && normVal(built.value).length > 0) {
        byKey.set(built.key, {
          key: built.key,
          category: rule.category,
          value: built.value,
          evidence,
          validTurn: turnNumber,
          confidence: rule.confidence,
        });
      }
      match = rule.regex.exec(content);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Deterministically extracts structured facts (order IDs, tickets, SKUs, budgets,
 * prices, colors, products, shipping, plans, preferences) from conversation turns.
 */
export function extractConversationFacts(
  turns: readonly ConversationTurn[],
  startTurnIndex = 1
): ConversationMemoryFact[] {
  const extracted: ConversationMemoryFact[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.role === 'system') continue;
    extracted.push(...extractFactsFromTurn(turn, turn.turnIndex ?? startTurnIndex + i));
  }
  return extracted;
}

/**
 * Merges incoming facts into existing facts with latest-wins temporal superseding
 * (`supersededAtTurn`) when a mutable entity key changes value on a newer turn.
 */
export function mergeMemoryFacts(
  existingFacts: readonly ConversationMemoryFact[],
  incomingFacts: readonly ConversationMemoryFact[],
  options: MergeMemoryFactsOptions = {}
): MergeMemoryFactsResult {
  const retainSuperseded = options.retainSupersededHistory ?? true;
  const maxActiveFacts = Math.max(1, options.maxActiveFacts ?? 24);
  const activeByKey = new Map<string, ConversationMemoryFact>();
  const supersededFacts: ConversationMemoryFact[] = [];

  for (const fact of existingFacts) {
    if (fact.supersededAtTurn !== undefined) {
      if (retainSuperseded) supersededFacts.push({ ...fact });
    } else {
      activeByKey.set(fact.key, { ...fact });
    }
  }

  for (const incoming of incomingFacts) {
    if (incoming.supersededAtTurn !== undefined) {
      if (retainSuperseded) supersededFacts.push({ ...incoming });
      continue;
    }
    const current = activeByKey.get(incoming.key);
    if (!current) {
      activeByKey.set(incoming.key, { ...incoming });
      continue;
    }
    if (normVal(current.value) === normVal(incoming.value)) {
      activeByKey.set(incoming.key, {
        ...current,
        validTurn: Math.max(current.validTurn, incoming.validTurn),
        confidence: Math.max(current.confidence, incoming.confidence),
      });
    } else if (incoming.validTurn >= current.validTurn) {
      if (retainSuperseded) supersededFacts.push({ ...current, supersededAtTurn: incoming.validTurn });
      activeByKey.set(incoming.key, { ...incoming });
    }
  }

  const activeFacts = Array.from(activeByKey.values())
    .sort((a, b) => CATEGORY_PRIORITY[b.category] - CATEGORY_PRIORITY[a.category] || b.validTurn - a.validTurn)
    .slice(0, maxActiveFacts);

  return { activeFacts, supersededFacts, allFacts: [...activeFacts, ...supersededFacts] };
}

/**
 * Formats active (non-superseded) memory facts into a compact Letta-style core block.
 */
export function formatPinnedFactsBlock(facts: readonly ConversationMemoryFact[], maxTokens?: number): string {
  const active = facts.filter((fact) => fact.supersededAtTurn === undefined);
  if (active.length === 0) return '';

  const header = '[PINNED_FACTS] ';
  const parts = active.map((fact) => `${fact.category}=${fact.value}`);
  const full = `${header}${parts.join(' | ')}`;

  if (maxTokens === undefined) return full;
  if (maxTokens <= 0) return '';
  if (estimateMemoryTextTokens(full) <= maxTokens) return full;

  const kept: string[] = [];
  for (const part of parts) {
    if (estimateMemoryTextTokens(`${header}${[...kept, part].join(' | ')}`) > maxTokens) break;
    kept.push(part);
  }
  return kept.length > 0 ? `${header}${kept.join(' | ')}` : truncateTextToTokenBudget(full, maxTokens);
}

/**
 * Detects English and Vietnamese anaphoric back-references ("that order from earlier",
 * "lúc nãy", "cái đó", "my updated budget") that fail under last-turn-only trimming.
 */
export function hasBackReference(text: string): BackReferenceMatch {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { detected: false, matchedPhrases: [], referencedCategories: [] };

  const matchedPhrases: string[] = [];
  const categorySet = new Set<MemoryFactCategory>();
  for (const rule of BACK_REFERENCE_RULES) {
    const match = rule.regex.exec(trimmed);
    if (match !== null) {
      matchedPhrases.push(match[0]);
      for (const cat of rule.categories) categorySet.add(cat);
    }
  }
  return {
    detected: matchedPhrases.length > 0,
    matchedPhrases,
    referencedCategories: Array.from(categorySet),
  };
}
