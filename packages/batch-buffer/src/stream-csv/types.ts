/**
 * @kido/stream-csv-batch - Type Definitions
 * Chunked streaming CSV/TSV parser, schema validation, batching, and template generation.
 */

export type ColumnType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'email'
  | 'url'
  | 'date'
  | 'enum'
  | 'regex';

export interface ColumnRule<T = unknown> {
  name: string;
  key?: string;
  type: ColumnType;
  required?: boolean;
  default?: T;
  enum?: string[];
  regex?: RegExp | string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  transform?: (raw: string, row: Record<string, string>) => T;
  validate?: (
    value: T,
    row: Record<string, string>,
    context?: Record<string, unknown>
  ) => boolean | string | Promise<boolean | string>;
  description?: string;
  example?: string;
}

export interface CsvSchema<T = Record<string, unknown>> {
  columns: ColumnRule[];
  delimiter?: string;
  quoteChar?: string;
  hasHeader?: boolean;
  trim?: boolean;
  skipEmptyLines?: boolean;
}

export type ValidationErrorCode =
  | 'REQUIRED_FIELD'
  | 'INVALID_TYPE'
  | 'INVALID_FORMAT'
  | 'OUT_OF_RANGE'
  | 'INVALID_ENUM'
  | 'CUSTOM_VALIDATION_ERROR'
  | 'MISSING_HEADER';

export interface RowValidationError {
  rowNumber: number;
  columnName: string;
  fieldKey: string;
  value: unknown;
  code: ValidationErrorCode;
  message: string;
}

export interface RowValidationWarning {
  rowNumber: number;
  columnName: string;
  message: string;
}

export interface ValidatedRow<T = Record<string, unknown>> {
  rowNumber: number;
  valid: boolean;
  data?: T;
  raw: Record<string, string>;
  errors: RowValidationError[];
  warnings: RowValidationWarning[];
}

export interface BatchResult<T = Record<string, unknown>> {
  batchIndex: number;
  rows: ValidatedRow<T>[];
  validItems: T[];
  errors: RowValidationError[];
  startIndex: number;
  endIndex: number;
}

export interface StreamProcessingSummary {
  totalRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  totalBatches: number;
  errors: RowValidationError[];
  durationMs: number;
}

export interface StreamParserOptions<T = Record<string, unknown>> {
  schema: CsvSchema<T>;
  batchSize?: number;
  onBatch?: (batch: BatchResult<T>) => Promise<void> | void;
  onProgress?: (progress: { processedRows: number; validRows: number; errorRows: number }) => void;
  validationContext?: Record<string, unknown>;
  stopOnError?: boolean;
}

export interface TemplateOptions {
  delimiter?: string;
  includeExamples?: boolean;
  includeMarkers?: boolean;
  sampleRowsCount?: number;
}

export type CsvInputSource =
  | string
  | Uint8Array
  | AsyncIterable<string | Uint8Array>
  | ReadableStream<Uint8Array | string>;
