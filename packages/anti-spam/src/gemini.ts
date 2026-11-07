import {
  GeminiSpamAnalysisResult,
  GeminiSpamAnalyzerOptions,
  IGeminiSpamAnalyzer,
} from './types';

/**
 * Keywords and regex patterns indicating potential financial scams, off-platform group invites,
 * gambling, or phishing to trigger deep semantic AI analysis.
 */
export const SUSPICIOUS_AI_PATTERNS =
  /(\b(?:lãi|lãi suất|lãi ngày|cam kết|nhóm kín|kéo tài khoản|vip room|phím hàng|hoa hồng|tiền nóng|bóng đá|lô đề|tài xỉu|casino|đầu tư|sinh lời|nhận quà|airdrop|inbox|telegram|zalo|hotline|z\.a\.l\.o|t\.e\.l\.e)\b|https?:\/\/|www\.)/i;

/**
 * Heuristic trigger to determine if content should be sent to Gemini AI analysis.
 * Triggers when text contains suspicious keywords or exceeds 120 characters (grey-zone threshold).
 */
export function shouldTriggerAiAnalysis(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return SUSPICIOUS_AI_PATTERNS.test(text) || text.trim().length > 120;
}

/**
 * Standardized Vietnamese prompt builder for financial, stock, and SME community moderation.
 */
export function buildGeminiSpamPrompt(content: string, title?: string): string {
  const fullContent = title
    ? `Tiêu đề: ${title}\nNội dung: ${content}`
    : content;

  return `Bạn là chuyên gia kiểm duyệt nội dung cộng đồng tài chính, chứng khoán Index và SME.
Hãy phân tích nội dung sau đây và xác định xem có phải spam, lừa đảo, lôi kéo hoặc vi phạm tiêu chuẩn hay không:
NỘI DUNG:
"""
${fullContent.slice(0, 2000)}
"""

TIÊU CHÍ VI PHẠM:
1. FINANCIAL_SCAM: Dụ dỗ đầu tư cam kết lãi khủng, đa cấp tài chính, kéo tài khoản, ủy thác đầu tư lừa đảo.
2. GROUP_INVITE: Mời gọi, dụ dỗ vào nhóm kín Zalo/Telegram/VIP room thu phí, phím hàng mờ ám.
3. GAMBLING_LOAN: Đánh bạc, lô đề, cá độ bóng đá, vay tiền nóng.
4. ABUSIVE: Thô tục nặng nề, xúc phạm danh dự cá nhân, phân biệt vùng miền.

Hãy trả về DUY NHẤT một JSON object theo cấu trúc:
{
  "isSpam": true hoặc false,
  "score": số thực từ 0.0 đến 1.0 (mức độ chắc chắn là spam/vi phạm),
  "categories": danh sách các nhãn vi phạm (chọn từ: FINANCIAL_SCAM, GROUP_INVITE, GAMBLING_LOAN, ABUSIVE),
  "reason": "Giải thích ngắn gọn lý do bằng tiếng Việt"
}`;
}

/**
 * Strips markdown code blocks (e.g. ```json ... ```) from model raw response.
 */
export function cleanJsonOutput(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

/**
 * Zero-dependency Gemini AI Spam Analyzer with AbortController timeout & fail-open resilience.
 */
export class GeminiSpamAnalyzer implements IGeminiSpamAnalyzer {
  public readonly apiKey?: string;
  public readonly modelName: string;
  public readonly timeoutMs: number;
  public readonly thresholdScore: number;
  private readonly customPrompt?: (content: string, title?: string) => string;

  constructor(options?: GeminiSpamAnalyzerOptions) {
    this.apiKey =
      options?.apiKey ||
      (typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : undefined);
    this.modelName =
      options?.modelName ||
      (typeof process !== 'undefined'
        ? process.env?.GEMINI_MODEL
        : undefined) ||
      'gemini-2.0-flash-lite';
    this.timeoutMs = options?.timeoutMs ?? 2500;
    this.thresholdScore = options?.thresholdScore ?? 0.8;
    this.customPrompt = options?.customPrompt;
  }

  /**
   * Evaluates if text should trigger AI semantic analysis.
   */
  shouldTriggerAiAnalysis(text: string): boolean {
    return shouldTriggerAiAnalysis(text);
  }

  /**
   * Evaluates text using Gemini with structured JSON output.
   * Fail-open: returns non-spam on error, timeout, or missing API key.
   */
  async analyzeContent(
    text: string,
    title?: string,
  ): Promise<GeminiSpamAnalysisResult> {
    if (!this.apiKey) {
      return {
        isSpam: false,
        score: 0,
        categories: [],
        reason: 'AI check skipped: No API key',
      };
    }

    if (!text || text.trim().length === 0) {
      return {
        isSpam: false,
        score: 0,
        categories: [],
        reason: 'Empty text',
      };
    }

    const prompt = this.customPrompt
      ? this.customPrompt(text, title)
      : buildGeminiSpamPrompt(text, title);

    try {
      const rawText = await this.callGeminiApi(prompt);
      return this.parseGeminiResponse(rawText);
    } catch {
      // Fail-open to avoid blocking legitimate user submissions on AI latency or outage
      return {
        isSpam: false,
        score: 0,
        categories: [],
        reason: 'AI analysis failed: Fail-open',
      };
    }
  }

  private async callGeminiApi(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Gemini API returned status ${response.status}: ${response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };

      const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!candidateText) {
        throw new Error('Gemini API returned empty candidate response');
      }

      return candidateText;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseGeminiResponse(rawJson: string): GeminiSpamAnalysisResult {
    try {
      const cleaned = cleanJsonOutput(rawJson);
      const parsed = JSON.parse(cleaned) as {
        isSpam?: boolean;
        score?: number;
        categories?: string[];
        reason?: string;
      };

      return {
        isSpam: Boolean(parsed.isSpam),
        score:
          typeof parsed.score === 'number'
            ? parsed.score
            : parsed.isSpam
              ? 1.0
              : 0,
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      };
    } catch {
      return {
        isSpam: false,
        score: 0,
        categories: [],
        reason: 'JSON parse error',
      };
    }
  }
}
