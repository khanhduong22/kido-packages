/**
 * @kido/stream-csv-batch - CSV Template Generator
 * Automatically generates standard CSV/TSV template files with required/optional column tags
 * and realistic sample data rows from schema configurations.
 */

import type { ColumnRule, ColumnType, CsvSchema, TemplateOptions } from './types';

/**
 * Escapes a cell value conforming to RFC 4180.
 */
export function escapeCsvCell(value: unknown, delimiter = ',', quoteChar = '"'): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (
    str.includes(delimiter) ||
    str.includes(quoteChar) ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `${quoteChar}${str.replace(new RegExp(quoteChar, 'g'), `${quoteChar}${quoteChar}`)}${quoteChar}`;
  }
  return str;
}

/**
 * Produces a representative default sample string for a given column rule.
 */
export function generateSampleValue(rule: ColumnRule, index: number): string {
  if (rule.example !== undefined) {
    return rule.example;
  }
  if (rule.default !== undefined) {
    return String(rule.default);
  }

  switch (rule.type) {
    case 'number':
      return String(rule.min !== undefined ? rule.min : index + 1);
    case 'boolean':
      return 'true';
    case 'email':
      return `user${index + 1}@example.com`;
    case 'url':
      return `https://example.com/item-${index + 1}`;
    case 'date':
      return '2026-10-05';
    case 'enum':
      return rule.enum && rule.enum.length > 0 ? rule.enum[0] : 'choice';
    case 'regex':
      return 'SAMPLE-001';
    case 'string':
    default:
      return `${rule.name} Value ${index + 1}`;
  }
}

/**
 * Generates a clean CSV/TSV template string from a CsvSchema.
 */
export function generateCsvTemplate(
  schema: CsvSchema,
  options: TemplateOptions = {}
): string {
  const {
    delimiter = schema.delimiter || ',',
    includeExamples = true,
    includeMarkers = true,
    sampleRowsCount = 1,
  } = options;

  const quoteChar = schema.quoteChar || '"';

  // 1. Build Header Row
  const headerCells = schema.columns.map((col) => {
    let title = col.name;
    if (includeMarkers) {
      const marker = col.required ? '(required)' : '(optional)';
      title = `${col.name} ${marker}`;
    }
    return escapeCsvCell(title, delimiter, quoteChar);
  });

  const lines: string[] = [headerCells.join(delimiter)];

  // 2. Build Example Rows
  if (includeExamples && sampleRowsCount > 0) {
    for (let r = 0; r < sampleRowsCount; r++) {
      const rowCells = schema.columns.map((col) => {
        const sample = generateSampleValue(col, r);
        return escapeCsvCell(sample, delimiter, quoteChar);
      });
      lines.push(rowCells.join(delimiter));
    }
  }

  return lines.join('\n');
}
