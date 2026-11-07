import { AntiSpamEngine } from './engine';
import { ValidateOptions, ValidationOutcome } from './types';

export interface AntiSpamMiddlewareOptions {
  /**
   * Field names to inspect in the request body (default: ['content', 'text', 'comment', 'title', 'body', 'message', 'bio', 'description'])
   */
  fields?: string[];

  /**
   * Status code returned on BLOCK (default: 400)
   */
  rejectStatus?: number;

  /**
   * Custom error message prefix or template
   */
  errorMessage?: string;

  /**
   * Additional validate options (e.g. checkHeuristics, userId extractor)
   */
  validateOptions?: ValidateOptions;

  /**
   * Callback invoked when a request is blocked
   */
  onBlocked?: (outcome: ValidationOutcome, field: string) => any;

  /**
   * Whether to reject on BLOCK (default: true)
   */
  blockOnViolation?: boolean;
}

const DEFAULT_INSPECT_FIELDS = [
  'content',
  'text',
  'comment',
  'title',
  'body',
  'message',
  'bio',
  'description',
];

/**
 * Extract values of specified target fields from an arbitrary object.
 */
export function extractFieldsToValidate(
  payload: Record<string, any>,
  targetFields: string[] = DEFAULT_INSPECT_FIELDS,
): Array<{ field: string; value: string }> {
  const result: Array<{ field: string; value: string }> = [];
  if (!payload || typeof payload !== 'object') return result;

  for (const field of targetFields) {
    const val = payload[field];
    if (typeof val === 'string' && val.trim().length > 0) {
      result.push({ field, value: val });
    }
  }

  return result;
}

/**
 * Fast synchronous request body validation against Layer 1.
 */
export function validateRequestBodySync(
  engine: AntiSpamEngine,
  body: Record<string, any>,
  fields: string[] = DEFAULT_INSPECT_FIELDS,
  options?: ValidateOptions,
): { outcome: ValidationOutcome; violatedField?: string } {
  const targets = extractFieldsToValidate(body, fields);

  let worstOutcome: ValidationOutcome | null = null;
  let violatedField: string | undefined = undefined;

  for (const { field, value } of targets) {
    const outcome = engine.validateSync(value, options);

    if (outcome.shouldBlock) {
      return { outcome, violatedField: field };
    }

    if (!worstOutcome || (outcome.shouldHide && !worstOutcome.shouldHide)) {
      worstOutcome = outcome;
      violatedField = field;
    }
  }

  return {
    outcome:
      worstOutcome ??
      engine.validateSync('', { checkHeuristics: false }),
    violatedField,
  };
}

/**
 * Validate plain request body object against full AntiSpamEngine pipeline.
 * Returns the highest severity outcome or ALLOW if clean.
 */
export async function validateRequestBody(
  engine: AntiSpamEngine,
  body: Record<string, any>,
  fields: string[] = DEFAULT_INSPECT_FIELDS,
  options?: ValidateOptions,
): Promise<{ outcome: ValidationOutcome; violatedField?: string }> {
  const targets = extractFieldsToValidate(body, fields);

  let worstOutcome: ValidationOutcome | null = null;
  let violatedField: string | undefined = undefined;

  for (const { field, value } of targets) {
    const outcome = await engine.validate(value, options);

    if (outcome.shouldBlock) {
      return { outcome, violatedField: field };
    }

    if (!worstOutcome || (outcome.shouldHide && !worstOutcome.shouldHide)) {
      worstOutcome = outcome;
      violatedField = field;
    }
  }

  return {
    outcome:
      worstOutcome ??
      engine.validateSync('', { checkHeuristics: false }),
    violatedField,
  };
}

/**
 * Generic Hono v4 middleware for anti-spam detection.
 * Compatible with Hono's Context and Next function without hard external dependency.
 */
export function createHonoAntiSpamMiddleware(
  engine: AntiSpamEngine,
  options?: AntiSpamMiddlewareOptions,
) {
  const fields = options?.fields ?? DEFAULT_INSPECT_FIELDS;
  const rejectStatus = options?.rejectStatus ?? 400;
  const blockOnViolation = options?.blockOnViolation ?? true;

  return async (c: any, next: () => Promise<void>) => {
    let body: any = {};

    try {
      if (
        c.req.header('content-type')?.includes('application/json') ||
        c.req.header('Content-Type')?.includes('application/json')
      ) {
        body = await c.req.json();
      }
    } catch {
      // Body may be empty or not JSON, proceed
    }

    const { outcome, violatedField } = await validateRequestBody(
      engine,
      body,
      fields,
      options?.validateOptions,
    );

    // Attach outcome to context
    c.set('antiSpam', outcome);
    c.set('antiSpamViolatedField', violatedField);

    if (outcome.shouldBlock && blockOnViolation) {
      if (options?.onBlocked) {
        options.onBlocked(outcome, violatedField ?? 'Nội dung');
      }

      return c.json(
        {
          statusCode: rejectStatus,
          error: 'Bad Request',
          message:
            options?.errorMessage ??
            `${violatedField ?? 'Nội dung'} chứa từ ngữ vi phạm tiêu chuẩn cộng đồng`,
          blacklistedWords: outcome.matchedWords,
        },
        rejectStatus,
      );
    }

    await next();
  };
}

/**
 * Generic Express/Connect middleware for anti-spam detection.
 */
export function createExpressAntiSpamMiddleware(
  engine: AntiSpamEngine,
  options?: AntiSpamMiddlewareOptions,
) {
  const fields = options?.fields ?? DEFAULT_INSPECT_FIELDS;
  const rejectStatus = options?.rejectStatus ?? 400;
  const blockOnViolation = options?.blockOnViolation ?? true;

  return async (req: any, res: any, next: (err?: any) => void) => {
    try {
      const body = req.body || {};
      const { outcome, violatedField } = await validateRequestBody(
        engine,
        body,
        fields,
        options?.validateOptions,
      );

      req.antiSpam = outcome;
      req.antiSpamViolatedField = violatedField;

      if (outcome.shouldBlock && blockOnViolation) {
        if (options?.onBlocked) {
          options.onBlocked(outcome, violatedField ?? 'Nội dung');
        }

        return res.status(rejectStatus).json({
          statusCode: rejectStatus,
          error: 'Bad Request',
          message:
            options?.errorMessage ??
            `${violatedField ?? 'Nội dung'} chứa từ ngữ vi phạm tiêu chuẩn cộng đồng`,
          blacklistedWords: outcome.matchedWords,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
