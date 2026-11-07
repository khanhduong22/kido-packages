/**
 * @kido/stream-csv-batch - Chunked Streaming CSV Parser & Atomic Batch Processor
 * Memory-efficient streaming parser compliant with RFC 4180.
 * Capable of parsing 50,000+ line datasets with bounded constant RAM.
 */

import type {
  BatchResult,
  ColumnRule,
  CsvInputSource,
  RowValidationError,
  StreamParserOptions,
  StreamProcessingSummary,
  ValidatedRow,
} from './types';
import { buildHeaderIndexMap, validateRow } from './validator';

/**
 * Converts any CsvInputSource into an AsyncIterable<string> chunks stream.
 */
export async function* normalizeToTextStream(
  source: CsvInputSource
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');

  if (typeof source === 'string') {
    yield source;
    return;
  }

  if (source instanceof Uint8Array) {
    yield decoder.decode(source);
    return;
  }

  // Web Standard ReadableStream
  if (
    typeof source === 'object' &&
    source !== null &&
    'getReader' in source &&
    typeof (source as any).getReader === 'function'
  ) {
    const reader = (source as ReadableStream<Uint8Array | string>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (typeof value === 'string') {
          yield value;
        } else if (value instanceof Uint8Array) {
          yield decoder.decode(value, { stream: true });
        }
      }
      yield decoder.decode(); // flush remaining
    } finally {
      reader.releaseLock();
    }
    return;
  }

  // Node or AsyncIterable
  if (Symbol.asyncIterator in source) {
    for await (const chunk of source as AsyncIterable<string | Uint8Array>) {
      if (typeof chunk === 'string') {
        yield chunk;
      } else if (chunk instanceof Uint8Array) {
        yield decoder.decode(chunk, { stream: true });
      }
    }
    yield decoder.decode();
    return;
  }

  throw new Error('Unsupported CSV input source. Expected string, Uint8Array, ReadableStream, or AsyncIterable.');
}

/**
 * Low-level RFC 4180 streaming state machine.
 * Emits row arrays one-by-one as stream chunks arrive without loading entire document to memory.
 */
export async function* iterateCsvRows(
  source: CsvInputSource,
  options: {
    delimiter?: string;
    quoteChar?: string;
    skipEmptyLines?: boolean;
    trim?: boolean;
  } = {}
): AsyncGenerator<{ rowNumber: number; cells: string[] }> {
  const delimiter = options.delimiter || ',';
  const quoteChar = options.quoteChar || '"';
  const skipEmptyLines = options.skipEmptyLines ?? true;
  const shouldTrim = options.trim ?? true;

  let isFirstChunk = true;
  let inQuotes = false;
  let currentField = '';
  let currentRow: string[] = [];
  let fileLineNumber = 1;

  for await (let chunk of normalizeToTextStream(source)) {
    if (isFirstChunk) {
      // Strip UTF-8 BOM if present
      if (chunk.charCodeAt(0) === 0xfeff) {
        chunk = chunk.slice(1);
      }
      isFirstChunk = false;
    }

    const len = chunk.length;
    for (let i = 0; i < len; i++) {
      const char = chunk[i];
      const nextChar = i + 1 < len ? chunk[i + 1] : '';

      if (char === quoteChar) {
        if (inQuotes && nextChar === quoteChar) {
          // Escaped quote: "" -> "
          currentField += quoteChar;
          i++; // skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes && char === delimiter) {
        currentRow.push(shouldTrim ? currentField.trim() : currentField);
        currentField = '';
      } else if (!inQuotes && (char === '\n' || char === '\r')) {
        // Handle \r\n
        if (char === '\r' && nextChar === '\n') {
          i++;
        }

        currentRow.push(shouldTrim ? currentField.trim() : currentField);
        currentField = '';

        // Check if row is completely empty
        const isRowEmpty = currentRow.length === 1 && currentRow[0] === '';
        if (!skipEmptyLines || !isRowEmpty) {
          yield { rowNumber: fileLineNumber, cells: currentRow };
        }

        fileLineNumber++;
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }

  // Flush remaining field/row at stream end
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(shouldTrim ? currentField.trim() : currentField);
    const isRowEmpty = currentRow.length === 1 && currentRow[0] === '';
    if (!skipEmptyLines || !isRowEmpty) {
      yield { rowNumber: fileLineNumber, cells: currentRow };
    }
  }
}

/**
 * End-to-end streaming CSV processor:
 * - Reads stream in chunks
 * - Validates header against schema
 * - Validates each row with typed schema rules
 * - Micro-batches valid rows up to batchSize (default 250)
 * - Invokes onBatch(chunk) for atomic DB writes
 * - Returns execution telemetry summary
 */
export async function processCsvStream<T = Record<string, unknown>>(
  source: CsvInputSource,
  options: StreamParserOptions<T>
): Promise<StreamProcessingSummary> {
  const startTime = Date.now();
  const {
    schema,
    batchSize = 250,
    onBatch,
    onProgress,
    validationContext,
    stopOnError = false,
  } = options;

  const hasHeader = schema.hasHeader ?? true;
  let headerMap: Map<number, ColumnRule> | null = null;

  let totalRows = 0;
  let validRows = 0;
  let errorRows = 0;
  let warningRows = 0;
  let totalBatches = 0;

  const allErrors: RowValidationError[] = [];
  let currentBatchRows: ValidatedRow<T>[] = [];
  let batchStartIndex = 1;

  async function flushCurrentBatch(): Promise<void> {
    if (currentBatchRows.length === 0) return;

    totalBatches++;
    const batchIndex = totalBatches;
    const validItems: T[] = [];
    const batchErrors: RowValidationError[] = [];

    for (const r of currentBatchRows) {
      if (r.valid && r.data !== undefined) {
        validItems.push(r.data);
      }
      if (r.errors.length > 0) {
        batchErrors.push(...r.errors);
      }
    }

    const batchResult: BatchResult<T> = {
      batchIndex,
      rows: currentBatchRows,
      validItems,
      errors: batchErrors,
      startIndex: batchStartIndex,
      endIndex: batchStartIndex + currentBatchRows.length - 1,
    };

    if (onBatch) {
      await onBatch(batchResult);
    }

    batchStartIndex += currentBatchRows.length;
    currentBatchRows = [];
  }

  for await (const { rowNumber, cells } of iterateCsvRows(source, {
    delimiter: schema.delimiter,
    quoteChar: schema.quoteChar,
    skipEmptyLines: schema.skipEmptyLines,
    trim: schema.trim,
  })) {
    // Process Header Row
    if (hasHeader && headerMap === null) {
      const { indexToColumn, missingRequiredColumns } = buildHeaderIndexMap(
        cells,
        schema.columns
      );

      if (missingRequiredColumns.length > 0) {
        const missingNames = missingRequiredColumns.map((c) => c.name).join(', ');
        throw new Error(`CSV is missing required header columns: ${missingNames}`);
      }

      headerMap = indexToColumn;
      continue;
    }

    // Default header mapping if no header row present
    if (headerMap === null) {
      headerMap = new Map();
      for (let i = 0; i < schema.columns.length; i++) {
        headerMap.set(i, schema.columns[i]);
      }
    }

    totalRows++;

    const validatedRow = await validateRow<T>(
      rowNumber,
      cells,
      headerMap,
      schema,
      validationContext
    );

    if (validatedRow.valid) {
      validRows++;
    } else {
      errorRows++;
      allErrors.push(...validatedRow.errors);
    }

    if (validatedRow.warnings.length > 0) {
      warningRows += validatedRow.warnings.length;
    }

    currentBatchRows.push(validatedRow);

    if (onProgress && totalRows % 100 === 0) {
      onProgress({ processedRows: totalRows, validRows, errorRows });
    }

    if (currentBatchRows.length >= batchSize) {
      await flushCurrentBatch();
    }

    if (stopOnError && errorRows > 0) {
      break;
    }
  }

  // Flush any lingering tail batch
  await flushCurrentBatch();

  if (onProgress) {
    onProgress({ processedRows: totalRows, validRows, errorRows });
  }

  const durationMs = Date.now() - startTime;

  return {
    totalRows,
    validRows,
    errorRows,
    warningRows,
    totalBatches,
    errors: allErrors,
    durationMs,
  };
}

/**
 * Binary-Split / Half-Split Fallback Batch Inserter.
 * Resilient bulk insert pattern for high-concurrency database ingestion.
 * When a batch insert throws a unique constraint or concurrency error,
 * it recursively splits the batch in half until single offending rows are isolated.
 */
export async function insertBatchWithFallback<T>(
  items: T[],
  inserter: (batch: T[]) => Promise<void> | void,
  isUniqueOrRowError: (error: unknown) => boolean
): Promise<{
  insertedCount: number;
  successItems: T[];
  failedItems: Array<{ item: T; error: Error }>;
}> {
  if (items.length === 0) {
    return { insertedCount: 0, successItems: [], failedItems: [] };
  }

  try {
    await inserter(items);
    return {
      insertedCount: items.length,
      successItems: [...items],
      failedItems: [],
    };
  } catch (error: unknown) {
    if (!isUniqueOrRowError(error)) {
      throw error;
    }

    // Base case: single item failed
    if (items.length === 1) {
      return {
        insertedCount: 0,
        successItems: [],
        failedItems: [{ item: items[0], error: error as Error }],
      };
    }

    // Split into 2 halves
    const midpoint = Math.ceil(items.length / 2);
    const half1 = items.slice(0, midpoint);
    const half2 = items.slice(midpoint);

    const res1 = await insertBatchWithFallback(half1, inserter, isUniqueOrRowError);
    const res2 = await insertBatchWithFallback(half2, inserter, isUniqueOrRowError);

    return {
      insertedCount: res1.insertedCount + res2.insertedCount,
      successItems: [...res1.successItems, ...res2.successItems],
      failedItems: [...res1.failedItems, ...res2.failedItems],
    };
  }
}
