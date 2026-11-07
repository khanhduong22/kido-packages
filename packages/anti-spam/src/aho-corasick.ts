import {
  BlacklistAction,
  BlacklistRule,
  MaskOptions,
  ScanResult,
  TrieMatchResult,
} from './types';

interface TrieNode {
  children: Map<string, TrieNode>;
  failure: TrieNode | null;
  outputs: BlacklistRule[];
}

function createTrieNode(): TrieNode {
  return {
    children: new Map(),
    failure: null,
    outputs: [],
  };
}

// Regex to check if a character is a word constituent (letters, numbers, underscores)
// Supports all Unicode letters (including Vietnamese diacritics) and digits
const WORD_CHAR_REGEX = /^[\p{L}\p{N}_]$/u;

export function isWordChar(char?: string): boolean {
  if (!char) return false;
  return WORD_CHAR_REGEX.test(char);
}

export class AhoCorasickAutomaton {
  private root: TrieNode = createTrieNode();
  private ruleCount: number = 0;

  /**
   * Build the Aho-Corasick automaton from a list of blacklist rules.
   * Compiles Trie and constructs failure links via BFS.
   */
  build(rules: BlacklistRule[]): void {
    const root = createTrieNode();

    for (const rule of rules) {
      this.insertPattern(root, rule);
    }

    this.buildFailureLinks(root);
    this.root = root;
    this.ruleCount = rules.length;
  }

  private insertPattern(root: TrieNode, rule: BlacklistRule): void {
    const cleanWord = rule.word.trim();
    if (!cleanWord) return;

    const searchKey = rule.isCaseSensitive ? cleanWord : cleanWord.toLowerCase();
    let current = root;

    for (const char of searchKey) {
      if (!current.children.has(char)) {
        current.children.set(char, createTrieNode());
      }
      current = current.children.get(char)!;
    }

    // Default isWholeWord to true for short words (<= 4 chars) to prevent Scunthorpe false positives
    const isWholeWord =
      rule.isWholeWord !== undefined ? rule.isWholeWord : cleanWord.length <= 4;

    current.outputs.push({
      ...rule,
      word: cleanWord,
      isWholeWord,
    });
  }

  private buildFailureLinks(root: TrieNode): void {
    const queue: TrieNode[] = [];

    // Level 1 children point failure back to root
    for (const child of root.children.values()) {
      child.failure = root;
      queue.push(child);
    }

    // BFS for subsequent levels
    while (queue.length > 0) {
      const current = queue.shift()!;

      for (const [char, childNode] of current.children.entries()) {
        let fallback = current.failure;

        while (fallback !== null && !fallback.children.has(char)) {
          fallback = fallback.failure;
        }

        childNode.failure = fallback ? fallback.children.get(char)! : root;

        // Propagate dictionary outputs from failure link
        if (childNode.failure.outputs.length > 0) {
          childNode.outputs = [
            ...childNode.outputs,
            ...childNode.failure.outputs,
          ];
        }

        queue.push(childNode);
      }
    }
  }

  /**
   * Single-pass linear scan O(M + Z) finding all matching blacklist rules.
   */
  search(text: string): ScanResult {
    if (!text || this.ruleCount === 0) {
      return {
        matchedRules: [],
        hasBlock: false,
        hasHide: false,
        hasFlag: false,
        hasMask: false,
        blockedWords: [],
        maskedWords: [],
        categories: [],
      };
    }

    const matches: TrieMatchResult[] = [];
    const textLower = text.toLowerCase();
    let current = this.root;

    for (let i = 0; i < text.length; i++) {
      current = this.stepTransition(current, text[i], textLower[i]);
      this.collectNodeOutputs(text, current, i, matches);
    }

    return this.summarizeMatches(matches);
  }

  private stepTransition(
    current: TrieNode,
    charOriginal: string,
    charLower: string,
  ): TrieNode {
    let node: TrieNode | undefined =
      current.children.get(charOriginal) || current.children.get(charLower);

    let active = current;
    while (!node && active !== this.root) {
      active = active.failure || this.root;
      node =
        active.children.get(charOriginal) || active.children.get(charLower);
    }

    return node || this.root;
  }

  private collectNodeOutputs(
    text: string,
    node: TrieNode,
    index: number,
    matches: TrieMatchResult[],
  ): void {
    if (node.outputs.length === 0) return;

    for (const pattern of node.outputs) {
      const startIndex = index - pattern.word.length + 1;
      const endIndex = index + 1;

      if (!this.isPatternMatchValid(text, pattern, startIndex, endIndex)) {
        continue;
      }

      matches.push({
        ruleId: pattern.id,
        word: pattern.word,
        action: pattern.action,
        startIndex,
        endIndex,
        category: pattern.category,
      });
    }
  }

  private isPatternMatchValid(
    text: string,
    pattern: BlacklistRule,
    startIndex: number,
    endIndex: number,
  ): boolean {
    if (pattern.isCaseSensitive) {
      const actualSubstring = text.slice(startIndex, endIndex);
      if (actualSubstring !== pattern.word) {
        return false;
      }
    }

    // Scunthorpe problem prevention via boundary check
    if (pattern.isWholeWord) {
      const prevChar = startIndex > 0 ? text[startIndex - 1] : undefined;
      const nextChar = endIndex < text.length ? text[endIndex] : undefined;

      if (isWordChar(prevChar) || isWordChar(nextChar)) {
        return false;
      }
    }

    return true;
  }

  private summarizeMatches(matches: TrieMatchResult[]): ScanResult {
    let hasBlock = false;
    let hasHide = false;
    let hasFlag = false;
    let hasMask = false;
    const blockedWordsSet = new Set<string>();
    const maskedWordsSet = new Set<string>();
    const categoriesSet = new Set<string>();

    for (const match of matches) {
      if (match.category) {
        categoriesSet.add(match.category);
      }

      switch (match.action) {
        case 'BLOCK':
          hasBlock = true;
          blockedWordsSet.add(match.word);
          break;
        case 'HIDE':
          hasHide = true;
          break;
        case 'FLAG':
          hasFlag = true;
          break;
        case 'MASK':
          hasMask = true;
          maskedWordsSet.add(match.word);
          break;
        case 'ALLOW':
          break;
      }
    }

    return {
      matchedRules: matches,
      hasBlock,
      hasHide,
      hasFlag,
      hasMask,
      blockedWords: Array.from(blockedWordsSet),
      maskedWords: Array.from(maskedWordsSet),
      categories: Array.from(categoriesSet),
    };
  }

  getRuleCount(): number {
    return this.ruleCount;
  }
}

/**
 * Mask matched forbidden words in the text with mask characters (e.g. '***').
 * Automatically merges overlapping intervals to prevent double replacement artifacts.
 */
export function maskMatchedText(
  text: string,
  matches: TrieMatchResult[],
  options?: MaskOptions,
): string {
  if (!text || matches.length === 0) return text;

  const maskChar = options?.maskChar ?? '*';
  const mode = options?.mode ?? 'repeat';
  const fixedLength = options?.fixedLength ?? 3;

  // Extract intervals [startIndex, endIndex]
  const intervals = matches
    .map((m) => ({ start: m.startIndex, end: m.endIndex }))
    .sort((a, b) => a.start - b.start);

  // Merge overlapping or contiguous intervals
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    if (merged.length === 0) {
      merged.push({ ...interval });
      continue;
    }

    const last = merged[merged.length - 1];
    if (interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  // Build replaced string
  let result = '';
  let cursor = 0;

  for (const interval of merged) {
    result += text.slice(cursor, interval.start);
    const replacement =
      mode === 'fixed'
        ? maskChar.repeat(fixedLength)
        : maskChar.repeat(interval.end - interval.start);
    result += replacement;
    cursor = interval.end;
  }

  result += text.slice(cursor);
  return result;
}
