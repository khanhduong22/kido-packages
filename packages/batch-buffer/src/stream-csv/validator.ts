/**
 * @kido/stream-csv-batch - Row-level Schema Validator
 * Normalizes headers, parses column types, checks constraints,
 * and reports granular row/column error diagnostics.
 */

import type {
  ColumnRule,
  CsvSchema,
  RowValidationError,
  RowValidationWarning,
  ValidatedRow,
} from './types';

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Derives a normalized camelCase field key for a column rule if `key` is not explicitly set.
 * e.g. "Tag" -> "tag", "Destination URL (required)" -> "destinationUrl", "No" -> "no"
 */
export function resolveFieldKey(rule: ColumnRule): string {
  if (rule.key) return rule.key;
  const clean = rule.name.replace(/\s*\((?:required|optional)\)\s*/gi, '').trim();
  return clean
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

/**
 * Normalizes header string by stripping casing, whitespace, and (required)/(optional) tags.
 * e.g. "No (required)" -> "no", "Destination URL" -> "destinationurl"
 */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\s*\((?:required|optional)\)\s*/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Builds a column index mapping from the CSV header row.
 */
export function buildHeaderIndexMap(
  headerCells: string[],
  columns: ColumnRule[]
): {
  indexToColumn: Map<number, ColumnRule>;
  missingRequiredColumns: ColumnRule[];
} {
  const indexToColumn = new Map<number, ColumnRule>();
  const matchedColumns = new Set<ColumnRule>();

  // Normalized schema rules
  const normalizedRules = columns.map((col) => ({
    col,
    normalizedName: normalizeHeader(col.name),
    normalizedKey: normalizeHeader(resolveFieldKey(col)),
  }));

  for (let idx = 0; idx < headerCells.length; idx++) {
    const rawCell = headerCells[idx];
    const norm = normalizeHeader(rawCell);
    if (!norm) continue;

    const matched = normalizedRules.find(
      (r) => r.normalizedName === norm || r.normalizedKey === norm
    );

    if (matched && !matchedColumns.has(matched.col)) {
      indexToColumn.set(idx, matched.col);
      matchedColumns.add(matched.col);
    }
  }

  const missingRequiredColumns = columns.filter(
    (col) => col.required && !matchedColumns.has(col)
  );

  return { indexToColumn, missingRequiredColumns };
}

/**
 * Validates a single cell value against a column rule.
 */
export async function validateCell(
  value: string,
  rule: ColumnRule,
  rowNumber: number,
  rawRow: Record<string, string>,
  context?: Record<string, unknown>
): Promise<{
  valid: boolean;
  parsedValue: unknown;
  error?: RowValidationError;
  warning?: RowValidationWarning;
}> {
  const fieldKey = resolveFieldKey(rule);
  const isValueEmpty = value === undefined || value === null || value.trim() === '';

  // 1. Required check
  if (rule.required && isValueEmpty) {
    return {
      valid: false,
      parsedValue: rule.default,
      error: {
        rowNumber,
        columnName: rule.name,
        fieldKey,
        value,
        code: 'REQUIRED_FIELD',
        message: `Column "${rule.name}" is required and cannot be empty.`,
      },
    };
  }

  // If optional and empty, apply default if available
  if (isValueEmpty) {
    return {
      valid: true,
      parsedValue: rule.default !== undefined ? rule.default : null,
    };
  }

  const rawTrimmed = value.trim();
  let parsedValue: unknown = rawTrimmed;

  // 2. Type validation
  switch (rule.type) {
    case 'number': {
      const num = Number(rawTrimmed);
      if (Number.isNaN(num)) {
        return {
          valid: false,
          parsedValue: rawTrimmed,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: rawTrimmed,
            code: 'INVALID_TYPE',
            message: `Column "${rule.name}" expects a valid number, got "${rawTrimmed}".`,
          },
        };
      }
      if (rule.min !== undefined && num < rule.min) {
        return {
          valid: false,
          parsedValue: num,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: num,
            code: 'OUT_OF_RANGE',
            message: `Column "${rule.name}" value ${num} is less than minimum allowed ${rule.min}.`,
          },
        };
      }
      if (rule.max !== undefined && num > rule.max) {
        return {
          valid: false,
          parsedValue: num,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: num,
            code: 'OUT_OF_RANGE',
            message: `Column "${rule.name}" value ${num} is greater than maximum allowed ${rule.max}.`,
          },
        };
      }
      parsedValue = num;
      break;
    }

    case 'boolean': {
      const lower = rawTrimmed.toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(lower)) {
        parsedValue = true;
      } else if (['false', '0', 'no', 'n'].includes(lower)) {
        parsedValue = false;
      } else {
        return {
          valid: false,
          parsedValue: rawTrimmed,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: rawTrimmed,
            code: 'INVALID_TYPE',
            message: `Column "${rule.name}" expects a boolean (true/false, 1/0, yes/no), got "${rawTrimmed}".`,
          },
        };
      }
      break;
    }

    case 'email': {
      if (!EMAIL_REGEX.test(rawTrimmed)) {
        return {
          valid: false,
          parsedValue: rawTrimmed,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: rawTrimmed,
            code: 'INVALID_FORMAT',
            message: `Column "${rule.name}" contains an invalid email address: "${rawTrimmed}".`,
          },
        };
      }
      parsedValue = rawTrimmed.toLowerCase();
      break;
    }

    case 'url': {
      try {
        const parsedUrl = new URL(rawTrimmed);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error('Only HTTP/HTTPS protocols are allowed');
        }
        parsedValue = parsedUrl.toString();
      } catch {
        return {
          valid: false,
          parsedValue: rawTrimmed,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: rawTrimmed,
            code: 'INVALID_FORMAT',
            message: `Column "${rule.name}" contains an invalid URL: "${rawTrimmed}". Must start with http:// or https://.`,
          },
        };
      }
      break;
    }

    case 'date': {
      const timestamp = Date.parse(rawTrimmed);
      if (Number.isNaN(timestamp)) {
        return {
          valid: false,
          parsedValue: rawTrimmed,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: rawTrimmed,
            code: 'INVALID_FORMAT',
            message: `Column "${rule.name}" contains an invalid date format: "${rawTrimmed}".`,
          },
        };
      }
      parsedValue = new Date(timestamp);
      break;
    }

    case 'enum': {
      if (rule.enum && rule.enum.length > 0) {
        if (!rule.enum.includes(rawTrimmed)) {
          return {
            valid: false,
            parsedValue: rawTrimmed,
            error: {
              rowNumber,
              columnName: rule.name,
              fieldKey,
              value: rawTrimmed,
              code: 'INVALID_ENUM',
              message: `Column "${rule.name}" value "${rawTrimmed}" is not in allowed choices: [${rule.enum.join(', ')}].`,
            },
          };
        }
      }
      break;
    }

    case 'regex': {
      if (rule.regex) {
        const re = typeof rule.regex === 'string' ? new RegExp(rule.regex) : rule.regex;
        if (!re.test(rawTrimmed)) {
          return {
            valid: false,
            parsedValue: rawTrimmed,
            error: {
              rowNumber,
              columnName: rule.name,
              fieldKey,
              value: rawTrimmed,
              code: 'INVALID_FORMAT',
              message: `Column "${rule.name}" value "${rawTrimmed}" does not match required pattern ${re}.`,
            },
          };
        }
      }
      break;
    }

    case 'string':
    default: {
      if (rule.minLength !== undefined && rawTrimmed.length < rule.minLength) {
        return {
          valid: false,
          parsedValue: rawTrimmed,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: rawTrimmed,
            code: 'OUT_OF_RANGE',
            message: `Column "${rule.name}" length (${rawTrimmed.length}) is shorter than minimum allowed (${rule.minLength}).`,
          },
        };
      }
      if (rule.maxLength !== undefined && rawTrimmed.length > rule.maxLength) {
        return {
          valid: false,
          parsedValue: rawTrimmed,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: rawTrimmed,
            code: 'OUT_OF_RANGE',
            message: `Column "${rule.name}" length (${rawTrimmed.length}) exceeds maximum allowed (${rule.maxLength}).`,
          },
        };
      }
      if (rule.regex) {
        const re = typeof rule.regex === 'string' ? new RegExp(rule.regex) : rule.regex;
        if (!re.test(rawTrimmed)) {
          return {
            valid: false,
            parsedValue: rawTrimmed,
            error: {
              rowNumber,
              columnName: rule.name,
              fieldKey,
              value: rawTrimmed,
              code: 'INVALID_FORMAT',
              message: `Column "${rule.name}" value "${rawTrimmed}" does not match required pattern ${re}.`,
            },
          };
        }
      }
      break;
    }
  }

  // 3. Custom transform
  if (rule.transform) {
    try {
      parsedValue = rule.transform(rawTrimmed, rawRow);
    } catch (err: unknown) {
      return {
        valid: false,
        parsedValue: rawTrimmed,
        error: {
          rowNumber,
          columnName: rule.name,
          fieldKey,
          value: rawTrimmed,
          code: 'CUSTOM_VALIDATION_ERROR',
          message: `Transformation failed for "${rule.name}": ${(err as Error).message}`,
        },
      };
    }
  }

  // 4. Custom validate
  if (rule.validate) {
    try {
      const res = await rule.validate(parsedValue as any, rawRow, context);
      if (res !== true) {
        const errorMsg =
          typeof res === 'string'
            ? res
            : `Custom validation failed for column "${rule.name}".`;
        return {
          valid: false,
          parsedValue,
          error: {
            rowNumber,
            columnName: rule.name,
            fieldKey,
            value: rawTrimmed,
            code: 'CUSTOM_VALIDATION_ERROR',
            message: errorMsg,
          },
        };
      }
    } catch (err: unknown) {
      return {
        valid: false,
        parsedValue,
        error: {
          rowNumber,
          columnName: rule.name,
          fieldKey,
          value: rawTrimmed,
          code: 'CUSTOM_VALIDATION_ERROR',
          message: `Validation error for "${rule.name}": ${(err as Error).message}`,
        },
      };
    }
  }

  return { valid: true, parsedValue };
}

/**
 * Validates a single row against the CSV schema using the precomputed header mapping.
 */
export async function validateRow<T = Record<string, unknown>>(
  rowNumber: number,
  cells: string[],
  headerMap: Map<number, ColumnRule>,
  schema: CsvSchema<T>,
  context?: Record<string, unknown>
): Promise<ValidatedRow<T>> {
  const errors: RowValidationError[] = [];
  const warnings: RowValidationWarning[] = [];
  const raw: Record<string, string> = {};
  const data: Record<string, unknown> = {};

  // Build raw map
  for (let i = 0; i < cells.length; i++) {
    const rule = headerMap.get(i);
    const key = rule ? resolveFieldKey(rule) : `col_${i}`;
    raw[key] = cells[i] ?? '';
  }

  // Validate columns present in header mapping
  const evaluatedRules = new Set<ColumnRule>();

  for (const [idx, rule] of headerMap.entries()) {
    evaluatedRules.add(rule);
    const rawVal = cells[idx] ?? '';
    const fieldKey = resolveFieldKey(rule);

    const cellResult = await validateCell(rawVal, rule, rowNumber, raw, context);

    if (!cellResult.valid && cellResult.error) {
      errors.push(cellResult.error);
    } else {
      data[fieldKey] = cellResult.parsedValue;
    }

    if (cellResult.warning) {
      warnings.push(cellResult.warning);
    }
  }

  // Check for schema columns not matched in header
  for (const rule of schema.columns) {
    if (!evaluatedRules.has(rule)) {
      const fieldKey = resolveFieldKey(rule);
      if (rule.required) {
        errors.push({
          rowNumber,
          columnName: rule.name,
          fieldKey,
          value: null,
          code: 'REQUIRED_FIELD',
          message: `Required column "${rule.name}" is missing from CSV data.`,
        });
      } else if (rule.default !== undefined) {
        data[fieldKey] = rule.default;
      }
    }
  }

  return {
    rowNumber,
    valid: errors.length === 0,
    data: errors.length === 0 ? (data as T) : undefined,
    raw,
    errors,
    warnings,
  };
}
