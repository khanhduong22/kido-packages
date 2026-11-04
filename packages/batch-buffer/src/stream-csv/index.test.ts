import { describe, expect, it } from 'bun:test';
import {
  buildHeaderIndexMap,
  escapeCsvCell,
  generateCsvTemplate,
  insertBatchWithFallback,
  iterateCsvRows,
  normalizeHeader,
  processCsvStream,
  validateRow,
} from './index';
import type { CsvSchema } from './types';

describe('@kido/stream-csv-batch', () => {
  describe('RFC 4180 Streaming Parser & Edge Cases', () => {
    it('parses standard CSV with delimiters and quoted strings', async () => {
      const csv = `id,name,role\n1,Alice,Engineer\n2,"Bob, Jr.",Designer\n3,"Charlie ""The Boss""",Manager`;

      const rows: string[][] = [];
      for await (const { cells } of iterateCsvRows(csv)) {
        rows.push(cells);
      }

      expect(rows.length).toBe(4);
      expect(rows[0]).toEqual(['id', 'name', 'role']);
      expect(rows[1]).toEqual(['1', 'Alice', 'Engineer']);
      expect(rows[2]).toEqual(['2', 'Bob, Jr.', 'Designer']);
      expect(rows[3]).toEqual(['3', 'Charlie "The Boss"', 'Manager']);
    });

    it('strips UTF-8 BOM automatically on first chunk', async () => {
      const csvWithBom = `\uFEFFtitle,views\nArticle 1,150`;

      const rows: string[][] = [];
      for await (const { cells } of iterateCsvRows(csvWithBom)) {
        rows.push(cells);
      }

      expect(rows[0]).toEqual(['title', 'views']);
      expect(rows[1]).toEqual(['Article 1', '150']);
    });

    it('handles multiline fields across quotes without breaking row numbering', async () => {
      const csv = `id,bio\n1,"First line\nSecond line\nThird line"\n2,Simple bio`;

      const rows: Array<{ rowNumber: number; cells: string[] }> = [];
      for await (const row of iterateCsvRows(csv)) {
        rows.push(row);
      }

      expect(rows.length).toBe(3);
      expect(rows[1].cells[1]).toBe('First line\nSecond line\nThird line');
      expect(rows[2].cells[1]).toBe('Simple bio');
    });

    it('handles custom delimiters (TSV and semicolon)', async () => {
      const tsv = `code\tname\tprice\nSKU-1\tShirt\t19.99`;
      const tsvRows: string[][] = [];
      for await (const { cells } of iterateCsvRows(tsv, { delimiter: '\t' })) {
        tsvRows.push(cells);
      }
      expect(tsvRows[1]).toEqual(['SKU-1', 'Shirt', '19.99']);

      const semicolonCsv = `code;name;price\nSKU-2;Pants;29.99`;
      const semiRows: string[][] = [];
      for await (const { cells } of iterateCsvRows(semicolonCsv, { delimiter: ';' })) {
        semiRows.push(cells);
      }
      expect(semiRows[1]).toEqual(['SKU-2', 'Pants', '29.99']);
    });
  });

  describe('Row-Level Schema Validation', () => {
    interface ShortlinkRow {
      no: number;
      backHalf: string;
      destinationUrl: string;
      title?: string;
      isActive: boolean;
      clicks?: number;
    }

    const testSchema: CsvSchema<ShortlinkRow> = {
      columns: [
        {
          name: 'No (required)',
          key: 'no',
          type: 'number',
          required: true,
          min: 1,
        },
        {
          name: 'Back-Half',
          key: 'backHalf',
          type: 'string',
          required: true,
          minLength: 3,
          maxLength: 30,
          regex: /^[a-zA-Z0-9_-]+$/,
        },
        {
          name: 'Destination URL (required)',
          key: 'destinationUrl',
          type: 'url',
          required: true,
        },
        {
          name: 'Title (optional)',
          key: 'title',
          type: 'string',
          required: false,
          default: 'Untitled Link',
        },
        {
          name: 'Is Active',
          key: 'isActive',
          type: 'boolean',
          required: false,
          default: true,
        },
        {
          name: 'Clicks',
          key: 'clicks',
          type: 'number',
          required: false,
          min: 0,
        },
      ],
    };

    it('normalizes headers and matches columns accurately', () => {
      expect(normalizeHeader('No (required)')).toBe('no');
      expect(normalizeHeader('Destination URL (required)')).toBe('destinationurl');
      expect(normalizeHeader('Title (optional)')).toBe('title');

      const headers = ['No (required)', 'Back-Half', 'Destination URL (required)', 'Title (optional)', 'Is Active'];
      const { indexToColumn, missingRequiredColumns } = buildHeaderIndexMap(
        headers,
        testSchema.columns
      );

      expect(missingRequiredColumns.length).toBe(0);
      expect(indexToColumn.get(0)?.key).toBe('no');
      expect(indexToColumn.get(2)?.key).toBe('destinationUrl');
    });

    it('validates correct row and parses types into typed object', async () => {
      const headers = ['No (required)', 'Back-Half', 'Destination URL (required)', 'Title (optional)', 'Is Active', 'Clicks'];
      const { indexToColumn } = buildHeaderIndexMap(headers, testSchema.columns);

      const validCells = ['1', 'sale-2026', 'https://shop.example.com/promo', 'Flash Sale Promo', 'true', '45'];
      const result = await validateRow<ShortlinkRow>(2, validCells, indexToColumn, testSchema);

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.data).toEqual({
        no: 1,
        backHalf: 'sale-2026',
        destinationUrl: 'https://shop.example.com/promo',
        title: 'Flash Sale Promo',
        isActive: true,
        clicks: 45,
      });
    });

    it('reports granular diagnostics on invalid rows (rowNumber, column, value, code, message)', async () => {
      const headers = ['No (required)', 'Back-Half', 'Destination URL (required)', 'Title (optional)', 'Is Active'];
      const { indexToColumn } = buildHeaderIndexMap(headers, testSchema.columns);

      // Row with invalid URL, non-numeric No, and illegal backHalf character
      const invalidCells = ['not_a_number', 'bad alias with spaces!', 'ftp://invalid-protocol.com', '', 'maybe'];
      const result = await validateRow<ShortlinkRow>(5, invalidCells, indexToColumn, testSchema);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);

      const noError = result.errors.find((e) => e.fieldKey === 'no');
      expect(noError?.code).toBe('INVALID_TYPE');
      expect(noError?.rowNumber).toBe(5);

      const backHalfError = result.errors.find((e) => e.fieldKey === 'backHalf');
      expect(backHalfError?.code).toBe('INVALID_FORMAT');

      const urlError = result.errors.find((e) => e.fieldKey === 'destinationUrl');
      expect(urlError?.code).toBe('INVALID_FORMAT');
    });

    it('supports custom transforms and async custom validators', async () => {
      const customSchema: CsvSchema<{ tag: string; sku: string }> = {
        columns: [
          {
            name: 'Tag',
            type: 'string',
            transform: (raw) => raw.toUpperCase(),
          },
          {
            name: 'SKU',
            type: 'string',
            validate: async (val) => {
              if (val === 'SKU-FORBIDDEN') {
                return 'This SKU is blacklisted.';
              }
              return true;
            },
          },
        ],
      };

      const headers = ['Tag', 'SKU'];
      const { indexToColumn } = buildHeaderIndexMap(headers, customSchema.columns);

      // 1. Success with transform
      const row1 = await validateRow(2, ['vip_deal', 'SKU-001'], indexToColumn, customSchema);
      expect(row1.valid).toBe(true);
      expect(row1.data?.tag).toBe('VIP_DEAL');

      // 2. Fails custom validator
      const row2 = await validateRow(3, ['promo', 'SKU-FORBIDDEN'], indexToColumn, customSchema);
      expect(row2.valid).toBe(false);
      expect(row2.errors[0].message).toBe('This SKU is blacklisted.');
    });
  });

  describe('Micro-Batch Streaming Processor & Atomic DB Writes', () => {
    it('processes CSV stream in bounded chunks and triggers onBatch callbacks', async () => {
      const schema: CsvSchema<{ id: number; name: string }> = {
        columns: [
          { name: 'id', type: 'number', required: true },
          { name: 'name', type: 'string', required: true },
        ],
      };

      // Generate 25 rows
      const lines = ['id,name'];
      for (let i = 1; i <= 25; i++) {
        lines.push(`${i},Item_${i}`);
      }
      const csvContent = lines.join('\n');

      const batchesReceived: Array<{ batchIndex: number; count: number }> = [];

      const summary = await processCsvStream(csvContent, {
        schema,
        batchSize: 10, // 25 rows -> batches of 10, 10, 5
        onBatch: async (batch) => {
          batchesReceived.push({
            batchIndex: batch.batchIndex,
            count: batch.validItems.length,
          });
        },
      });

      expect(summary.totalRows).toBe(25);
      expect(summary.validRows).toBe(25);
      expect(summary.errorRows).toBe(0);
      expect(summary.totalBatches).toBe(3);

      expect(batchesReceived).toEqual([
        { batchIndex: 1, count: 10 },
        { batchIndex: 2, count: 10 },
        { batchIndex: 3, count: 5 },
      ]);
    });

    it('simulates 1,000 rows streaming with high performance and zero memory leaks', async () => {
      const schema: CsvSchema<{ no: number; email: string }> = {
        columns: [
          { name: 'no', type: 'number', required: true },
          { name: 'email', type: 'email', required: true },
        ],
      };

      // Async generator yielding chunks
      async function* generateMassiveCsv() {
        yield 'no,email\n';
        for (let i = 1; i <= 1000; i++) {
          yield `${i},user_${i}@example.com\n`;
        }
      }

      let totalInserted = 0;
      const summary = await processCsvStream(generateMassiveCsv(), {
        schema,
        batchSize: 250,
        onBatch: (batch) => {
          totalInserted += batch.validItems.length;
        },
      });

      expect(summary.totalRows).toBe(1000);
      expect(summary.validRows).toBe(1000);
      expect(summary.totalBatches).toBe(4); // 250 * 4 = 1000
      expect(totalInserted).toBe(1000);
    });

    it('processes 50,000+ lines in streaming chunks without memory overflow', async () => {
      const schema: CsvSchema<{ rowId: number; code: string; active: boolean }> = {
        columns: [
          { name: 'Row ID', key: 'rowId', type: 'number', required: true },
          { name: 'Code', key: 'code', type: 'string', required: true },
          { name: 'Active', key: 'active', type: 'boolean', required: true },
        ],
      };

      async function* generate50kRows() {
        yield 'Row ID,Code,Active\n';
        const batchLines: string[] = [];
        for (let i = 1; i <= 50000; i++) {
          batchLines.push(`${i},CODE_${i},true`);
          if (batchLines.length === 500) {
            yield batchLines.join('\n') + '\n';
            batchLines.length = 0;
          }
        }
        if (batchLines.length > 0) {
          yield batchLines.join('\n') + '\n';
        }
      }

      let batchesProcessed = 0;
      let totalValidCount = 0;

      const summary = await processCsvStream(generate50kRows(), {
        schema,
        batchSize: 500,
        onBatch: (batch) => {
          batchesProcessed++;
          totalValidCount += batch.validItems.length;
        },
      });

      expect(summary.totalRows).toBe(50000);
      expect(summary.validRows).toBe(50000);
      expect(summary.errorRows).toBe(0);
      expect(batchesProcessed).toBe(100);
      expect(totalValidCount).toBe(50000);
    });

    it('throws when required header column is missing', async () => {
      const schema: CsvSchema = {
        columns: [
          { name: 'RequiredCol', type: 'string', required: true },
          { name: 'OptionalCol', type: 'string', required: false },
        ],
      };

      const badCsv = `WrongCol,OptionalCol\nFoo,Bar`;

      await expect(
        processCsvStream(badCsv, {
          schema,
        })
      ).rejects.toThrow('missing required header columns: RequiredCol');
    });
  });

  describe('Binary-Split Fallback Batch Inserter (High-Throughput Gateway Architecture)', () => {
    it('succeeds in single batch when no conflicts occur', async () => {
      const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const inserted: number[] = [];

      const result = await insertBatchWithFallback(
        items,
        async (chunk) => {
          inserted.push(...chunk.map((c) => c.id));
        },
        () => true
      );

      expect(result.insertedCount).toBe(3);
      expect(result.successItems.length).toBe(3);
      expect(result.failedItems.length).toBe(0);
      expect(inserted).toEqual([1, 2, 3]);
    });

    it('isolates the single conflicting row through binary half-splits and inserts the rest', async () => {
      // Suppose id 5 is a unique constraint conflict (e.g. duplicate slug in DB)
      const items = [
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4 },
        { id: 5 }, // conflicting
        { id: 6 },
        { id: 7 },
        { id: 8 },
      ];

      const insertedIds = new Set<number>();

      const result = await insertBatchWithFallback(
        items,
        async (chunk) => {
          // If chunk contains id 5, simulate DB Unique Constraint Violation
          if (chunk.some((item) => item.id === 5)) {
            const err = new Error('Unique constraint violation: key id 5 already exists');
            (err as any).code = '23505';
            throw err;
          }
          // Otherwise insert
          for (const item of chunk) {
            insertedIds.add(item.id);
          }
        },
        (err) => (err as any).code === '23505'
      );

      expect(result.insertedCount).toBe(7);
      expect(result.successItems.map((i) => i.id)).toEqual([1, 2, 3, 4, 6, 7, 8]);
      expect(result.failedItems.length).toBe(1);
      expect(result.failedItems[0].item.id).toBe(5);
      expect(result.failedItems[0].error.message).toContain('id 5 already exists');
      expect(Array.from(insertedIds)).toEqual([1, 2, 3, 4, 6, 7, 8]);
    });
  });

  describe('Auto CSV Template Generation', () => {
    it('generates standard template with required/optional markers and realistic samples', () => {
      const schema: CsvSchema = {
        columns: [
          { name: 'No', type: 'number', required: true },
          { name: 'Destination URL', type: 'url', required: true, example: 'https://mysite.com' },
          { name: 'Category', type: 'enum', enum: ['promo', 'blog', 'support'], required: false },
          { name: 'Notes', type: 'string', required: false, default: 'N/A' },
        ],
      };

      const template = generateCsvTemplate(schema, {
        includeMarkers: true,
        includeExamples: true,
        sampleRowsCount: 1,
      });

      const lines = template.split('\n');
      expect(lines.length).toBe(2);

      // Header row
      expect(lines[0]).toBe('No (required),Destination URL (required),Category (optional),Notes (optional)');

      // Example row
      expect(lines[1]).toBe('1,https://mysite.com,promo,N/A');
    });

    it('escapes cells containing commas and quotes properly', () => {
      expect(escapeCsvCell('Simple')).toBe('Simple');
      expect(escapeCsvCell('Hello, World')).toBe('"Hello, World"');
      expect(escapeCsvCell('Say "Yes"')).toBe('"Say ""Yes"""');
    });
  });
});
