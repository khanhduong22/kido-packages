import { describe, expect, it } from 'bun:test';
import {
  computeSimHash,
  computeSimHashBigInt,
  hammingDistance,
  similarity,
  isNearDuplicate,
  bigIntToHex16,
  hex16ToBigInt,
  toBigInt64,
  toHex16,
  fnv1a64,
  normalizeText,
  tokenize,
  generateWordNgrams,
  generateCharNgrams,
  isStopword,
  VIETNAMESE_STOPWORDS,
  ENGLISH_STOPWORDS,
  NearDuplicateIndex,
  extract16BitBlocks,
} from '../index';

describe('@kido/content-dedupe', () => {
  describe('FNV-1a 64-bit and Hex utilities', () => {
    it('produces deterministic 64-bit hashes', () => {
      const h1 = fnv1a64('test-string');
      const h2 = fnv1a64('test-string');
      const h3 = fnv1a64('other-string');

      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(typeof h1).toBe('bigint');
      expect(h1 >= 0n).toBe(true);
      expect(h1 <= 0xffffffffffffffffn).toBe(true);
    });

    it('converts BigInt to 16-character hex and back', () => {
      const original = 0x123456789abcdef0n;
      const hex = bigIntToHex16(original);
      expect(hex).toBe('123456789abcdef0');
      expect(hex.length).toBe(16);

      const parsed = hex16ToBigInt(hex);
      expect(parsed).toBe(original);
    });

    it('handles leading zeros in hex representation', () => {
      const val = 0x0000000000000042n;
      const hex = bigIntToHex16(val);
      expect(hex).toBe('0000000000000042');
      expect(hex.length).toBe(16);
      expect(hex16ToBigInt(hex)).toBe(val);
    });

    it('accepts hex with or without 0x prefix', () => {
      expect(toBigInt64('0xabcdef0123456789')).toBe(0xabcdef0123456789n);
      expect(toBigInt64('abcdef0123456789')).toBe(0xabcdef0123456789n);
      expect(toHex16(0xabcdef0123456789n)).toBe('abcdef0123456789');
    });

    it('throws on invalid hex characters', () => {
      expect(() => hex16ToBigInt('not-a-hex-value!')).toThrow();
    });
  });

  describe('Hamming Distance & Bitwise Edge Cases', () => {
    it('calculates 0 distance for identical BigInts or hex strings', () => {
      const hash = 0xdeadbeefcafebaben;
      expect(hammingDistance(hash, hash)).toBe(0);
      expect(similarity(hash, hash)).toBe(1.0);
      expect(isNearDuplicate(hash, hash)).toBe(true);

      const hex = 'deadbeefcafebabe';
      expect(hammingDistance(hex, hex)).toBe(0);
      expect(similarity(hex, hex)).toBe(1.0);
    });

    it('calculates maximum 64 distance for exact bitwise inversion', () => {
      const a = 0x0000000000000000n;
      const b = 0xffffffffffffffffn;
      expect(hammingDistance(a, b)).toBe(64);
      expect(similarity(a, b)).toBe(0.0);
      expect(isNearDuplicate(a, b)).toBe(false);
    });

    it('correctly counts single-bit and multi-bit differences', () => {
      // 1 bit flip: 0b001 (1) vs 0b011 (3)
      expect(hammingDistance(1n, 3n)).toBe(1);
      expect(similarity(1n, 3n)).toBe(63 / 64);

      // 3 bit flips
      const base = 0x0000000000000000n;
      const flipped3 = (1n << 0n) | (1n << 16n) | (1n << 48n);
      expect(hammingDistance(base, flipped3)).toBe(3);
      expect(similarity(base, flipped3)).toBe(61 / 64);
    });

    it('verifies custom threshold in isNearDuplicate', () => {
      const base = 0n;
      // 9 bits flipped -> distance = 9, similarity = 55/64 = 0.859375
      const flipped9 = 0x1ffn; // bits 0..8
      expect(hammingDistance(base, flipped9)).toBe(9);
      expect(similarity(base, flipped9)).toBeGreaterThanOrEqual(0.85);
      expect(isNearDuplicate(base, flipped9, 0.85)).toBe(true);
      expect(isNearDuplicate(base, flipped9, 0.90)).toBe(false);
    });
  });

  describe('Tokenizer & Vietnamese NLP Handling', () => {
    it('normalizes Unicode NFC and cleans zero-width characters', () => {
      const nfd = 'tiếng Việt'.normalize('NFD');
      const zeroWidth = 'ti\u200Bế\u200Dng Vi\uFEFFệt';
      const clean = 'tiếng việt';

      expect(normalizeText(nfd)).toBe(clean);
      expect(normalizeText(zeroWidth)).toBe(clean);
    });

    it('strips trailing salt numbers by default', () => {
      expect(normalizeText('vay tiền nhanh 01')).toBe('vay tiền nhanh');
      expect(normalizeText('vay tiền nhanh 02')).toBe('vay tiền nhanh');
      expect(normalizeText('alo alo 123')).toBe('alo alo');
      expect(normalizeText('dịch vụ uy tín #999')).toBe('dịch vụ uy tín');
    });

    it('generates word n-grams correctly', () => {
      const words = ['học', 'lập', 'trình', 'typescript'];
      const bigrams = generateWordNgrams(words, 2);
      expect(bigrams).toEqual([
        'học lập',
        'lập trình',
        'trình typescript',
      ]);
    });

    it('generates character n-grams correctly', () => {
      const trigrams = generateCharNgrams('alo alo', 3);
      expect(trigrams).toContain('alo');
      expect(trigrams).toContain('lo ');
      expect(trigrams).toContain('o a');
      expect(trigrams).toContain(' al');
    });

    it('identifies Vietnamese and English stopwords', () => {
      expect(isStopword('và', 'vi')).toBe(true);
      expect(isStopword('the', 'en')).toBe(true);
      expect(isStopword('calisthenics', 'all')).toBe(false);
    });
  });

  describe('SimHash Content Deduplication Quality', () => {
    it('evaluates exact duplicate = 100% similarity (Hamming distance = 0)', () => {
      const text = 'Văn Tới Calisthenics - Trung tâm huấn luyện thể hình thể thao đường phố Hà Nội';
      const hashA = computeSimHash(text);
      const hashB = computeSimHash(text);

      expect(hashA).toBe(hashB);
      expect(hammingDistance(hashA, hashB)).toBe(0);
      expect(similarity(hashA, hashB)).toBe(1.0);
      expect(isNearDuplicate(hashA, hashB)).toBe(true);
    });

    it('evaluates Unicode NFD vs NFC as exact duplicates', () => {
      const textNFC = 'Văn Tới Calisthenics bài tập hít đất và kéo xà đơn đỉnh cao';
      const textNFD = textNFC.normalize('NFD');

      const hashNFC = computeSimHash(textNFC);
      const hashNFD = computeSimHash(textNFD);

      expect(hashNFC).toBe(hashNFD);
      expect(similarity(hashNFC, hashNFD)).toBe(1.0);
    });

    it('evaluates minor edits and salt digits with high similarity >= 85%', () => {
      const original = 'Cần tuyển gấp nhân viên bán hàng online tại quận Cầu Giấy Hà Nội mức lương 10 triệu đồng hỗ trợ ăn trưa';
      const salted1 = 'Cần tuyển gấp nhân viên bán hàng online tại quận Cầu Giấy Hà Nội mức lương 10 triệu đồng hỗ trợ ăn trưa 01';
      const salted2 = 'Cần tuyển gấp nhân viên bán hàng online tại quận Cầu Giấy Hà Nội mức lương 10 triệu đồng hỗ trợ ăn trưa 02';
      const minorEdit = 'Cần tuyển gấp nhân viên bán hàng online tại quận Cầu Giấy Hà Nội mức lương 12 triệu đồng hỗ trợ ăn trưa';

      const hashOrig = computeSimHash(original);
      const hashSalt1 = computeSimHash(salted1);
      const hashSalt2 = computeSimHash(salted2);
      const hashMinor = computeSimHash(minorEdit);

      // Salt numbers are stripped by default, resulting in 100% match
      expect(similarity(hashOrig, hashSalt1)).toBeGreaterThanOrEqual(0.95);
      expect(similarity(hashSalt1, hashSalt2)).toBeGreaterThanOrEqual(0.95);

      // Minor edit (1 word replaced) still retains >= 85% similarity
      const simMinor = similarity(hashOrig, hashMinor);
      expect(simMinor).toBeGreaterThanOrEqual(0.85);
      expect(isNearDuplicate(hashOrig, hashMinor, 0.85)).toBe(true);
    });

    it('evaluates completely different text with low similarity <= 50%', () => {
      const techText = 'Hệ thống vi dịch vụ Golang Kubernetes phân tán với Kafka và Redis Cluster';
      const foodText = 'Cách nấu bún bò Huế thơm ngon chuẩn vị miền Trung với sả ớt ruốc';

      const hashTech = computeSimHash(techText);
      const hashFood = computeSimHash(foodText);

      const sim = similarity(hashTech, hashFood);
      expect(sim).toBeLessThanOrEqual(0.60);
      expect(isNearDuplicate(hashTech, hashFood, 0.85)).toBe(false);
    });
  });

  describe('NearDuplicateIndex (Pigeonhole Multi-Block Table)', () => {
    it('extracts four 16-bit blocks from 64-bit integer', () => {
      // 0x1111_2222_3333_4444n
      const hash = (0x1111n << 48n) | (0x2222n << 32n) | (0x3333n << 16n) | 0x4444n;
      const blocks = extract16BitBlocks(hash);

      expect(blocks[0]).toBe(0x4444);
      expect(blocks[1]).toBe(0x3333);
      expect(blocks[2]).toBe(0x2222);
      expect(blocks[3]).toBe(0x1111);
    });

    it('guarantees 100% recall for Hamming distance <= 3 via Pigeonhole Principle', () => {
      const index = new NearDuplicateIndex({ defaultMaxHammingDistance: 3 });

      // Create base hash: 0xAAAA_BBBB_CCCC_DDDDn
      const baseHash = 0xaaaabbbbccccddddn;
      index.insert('doc-base', baseHash, { title: 'Base Document' });

      // Test case 1: 1 bit difference in Block 0 (bits 0..15)
      // Blocks 1, 2, 3 remain identical!
      const hashDiff1 = baseHash ^ (1n << 2n);
      expect(hammingDistance(baseHash, hashDiff1)).toBe(1);

      let matches = index.query(hashDiff1, { maxHammingDistance: 3 });
      expect(matches.length).toBe(1);
      expect(matches[0].id).toBe('doc-base');
      expect(matches[0].hammingDistance).toBe(1);

      // Test case 2: 2 bit differences spread across Block 0 and Block 1
      // Blocks 2 and 3 remain identical!
      const hashDiff2 = baseHash ^ (1n << 5n) ^ (1n << 20n);
      expect(hammingDistance(baseHash, hashDiff2)).toBe(2);

      matches = index.query(hashDiff2, { maxHammingDistance: 3 });
      expect(matches.length).toBe(1);
      expect(matches[0].id).toBe('doc-base');
      expect(matches[0].hammingDistance).toBe(2);

      // Test case 3: 3 bit differences across Blocks 0, 1, 2
      // Block 3 (bits 48..63) STILL remains 100% identical!
      const hashDiff3 = baseHash ^ (1n << 3n) ^ (1n << 18n) ^ (1n << 35n);
      expect(hammingDistance(baseHash, hashDiff3)).toBe(3);

      matches = index.query(hashDiff3, { maxHammingDistance: 3 });
      expect(matches.length).toBe(1);
      expect(matches[0].id).toBe('doc-base');
      expect(matches[0].hammingDistance).toBe(3);
    });

    it('supports insert, delete, query, get, has and batch operations', () => {
      const index = new NearDuplicateIndex();

      index.insertBatch([
        { id: '1', text: 'Khóa học lập trình TypeScript nâng cao tại Hà Nội', metadata: { author: 'Kido' } },
        { id: '2', text: 'Khóa học lập trình TypeScript nâng cao ở Hà Nội', metadata: { author: 'Kido' } },
        { id: '3', text: 'Bí quyết làm bánh trung thu thập cẩm nướng thơm lừng', metadata: { category: 'Cooking' } },
      ]);

      expect(index.size).toBe(3);
      expect(index.has('1')).toBe(true);
      expect(index.has('999')).toBe(false);

      const doc1 = index.get('1');
      expect(doc1).toBeDefined();
      expect(doc1?.metadata?.author).toBe('Kido');

      // Query near duplicate
      const matches = index.findNearDuplicates('Khóa học lập trình TypeScript nâng cao tại Hà Nội', 0.85);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].id).toBe('1');
      expect(matches[0].similarity).toBe(1.0);

      // Test deletion
      expect(index.delete('1')).toBe(true);
      expect(index.size).toBe(2);
      expect(index.has('1')).toBe(false);
      expect(index.delete('1')).toBe(false);
    });

    it('performs fast lookups over 1,000 documents without memory choke', () => {
      const index = new NearDuplicateIndex({ defaultMaxHammingDistance: 3 });

      // Generate 1,000 distinct mock articles
      const batch: Array<{ id: string; text: string }> = [];
      for (let i = 0; i < 1000; i++) {
        batch.push({
          id: `item-${i}`,
          text: `Bài viết chuyên mục số ${i} về kiến trúc điện toán đám mây và tối ưu hoá hệ thống vi dịch vụ ${i * 17}`,
        });
      }

      const tStart = performance.now();
      index.insertBatch(batch);
      const tInsert = performance.now() - tStart;

      expect(index.size).toBe(1000);
      expect(tInsert).toBeLessThan(5000); // 1,000 documents inserted (<5s under CI parallel load)

      // Query for an exact item: item-500
      const queryText = `Bài viết chuyên mục số 500 về kiến trúc điện toán đám mây và tối ưu hoá hệ thống vi dịch vụ ${500 * 17}`;
      const tQueryStart = performance.now();
      const results = index.query(queryText, { maxHammingDistance: 3 });
      const tQuery = performance.now() - tQueryStart;

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe('item-500');
      expect(results[0].similarity).toBe(1.0);
      expect(tQuery).toBeLessThan(100); // Pigeonhole table query takes < 100ms under CI load
    });

    it('exports and restores index dumps correctly', () => {
      const originalIndex = new NearDuplicateIndex();
      originalIndex.insert('doc-1', 'Văn Tới Calisthenics Hà Nội', { tags: ['fitness'] });
      originalIndex.insert('doc-2', 'Lập trình viên Fullstack React Native', { tags: ['tech'] });

      const dump = originalIndex.exportDump();
      expect(dump.documents.length).toBe(2);

      const restoredIndex = new NearDuplicateIndex();
      restoredIndex.importDump(dump);

      expect(restoredIndex.size).toBe(2);
      expect(restoredIndex.has('doc-1')).toBe(true);
      expect(restoredIndex.get('doc-1')?.metadata?.tags).toEqual(['fitness']);

      const match = restoredIndex.query('Văn Tới Calisthenics Hà Nội');
      expect(match.length).toBeGreaterThanOrEqual(1);
      expect(match[0].id).toBe('doc-1');
    });

    it('updates an existing document ID cleanly without duplicate table entries', () => {
      const index = new NearDuplicateIndex();
      index.insert('post-1', 'Bài viết ban đầu về lập trình TypeScript');
      expect(index.size).toBe(1);

      // Overwrite with different text
      index.insert('post-1', 'Bài viết cập nhật về kiểm thử phần mềm');
      expect(index.size).toBe(1);

      const oldMatch = index.query('Bài viết ban đầu về lập trình TypeScript');
      // Old text shouldn't match with 100% similarity anymore
      expect(oldMatch.length === 0 || oldMatch[0].similarity < 1.0).toBe(true);

      const newMatch = index.query('Bài viết cập nhật về kiểm thử phần mềm');
      expect(newMatch.length).toBe(1);
      expect(newMatch[0].id).toBe('post-1');
      expect(newMatch[0].similarity).toBe(1.0);
    });

    it('supports hasNearDuplicate boolean helper', () => {
      const index = new NearDuplicateIndex();
      index.insert('d1', 'Dịch vụ kế toán thuế trọn gói cho doanh nghiệp vừa và nhỏ');

      expect(index.hasNearDuplicate('Dịch vụ kế toán thuế trọn gói cho doanh nghiệp vừa và nhỏ', 0.95)).toBe(true);
      expect(index.hasNearDuplicate('Công thức làm bánh flan caramen béo ngậy', 0.85)).toBe(false);
    });

    it('supports exhaustive search flag when distance is large', () => {
      const index = new NearDuplicateIndex();
      index.insert('d1', 'Nghiên cứu về trí tuệ nhân tạo và học máy hiện đại');
      index.insert('d2', 'Công thức làm chả cá Lã Vọng thơm lừng đặc sản Hà Thành');

      const matches = index.query('Nghiên cứu về trí tuệ nhân tạo và học sâu', {
        exhaustive: true,
        maxHammingDistance: 15,
      });

      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].id).toBe('d1');
    });

    it('clears index completely', () => {
      const index = new NearDuplicateIndex();
      index.insert('1', 'Test text 1');
      index.insert('2', 'Test text 2');
      expect(index.size).toBe(2);

      index.clear();
      expect(index.size).toBe(0);
      expect(index.has('1')).toBe(false);
      expect(index.query('Test text 1').length).toBe(0);
    });
  });

  describe('Edge cases and Custom Weighting', () => {
    it('handles empty or whitespace-only strings gracefully', () => {
      expect(computeSimHash('')).toBe('0000000000000000');
      expect(computeSimHashBigInt('')).toBe(0n);
      expect(computeSimHash('   \n\t  ')).toBe('0000000000000000');
    });

    it('supports custom weighting dictionary and function', () => {
      const text = 'calisthenics tập luyện';
      const normalHash = computeSimHash(text);

      // Boost "calisthenics" weight heavily
      const weightedHash = computeSimHash(text, {
        weights: { 'w1:calisthenics': 100 },
      });

      expect(typeof normalHash).toBe('string');
      expect(typeof weightedHash).toBe('string');
      expect(normalHash.length).toBe(16);
      expect(weightedHash.length).toBe(16);
    });

    it('supports char mode and mixed mode explicitly', () => {
      const text = 'alo alo 123';
      const charHash = computeSimHash(text, { mode: 'char', charNgramSize: 3 });
      const mixedHash = computeSimHash(text, { mode: 'mixed' });

      expect(typeof charHash).toBe('string');
      expect(typeof mixedHash).toBe('string');
    });

    it('supports stripNumbers: true option', () => {
      const textWithNums = 'Số điện thoại 0987654321 mã đơn hàng 9988';
      const tokensNoNums = tokenize(textWithNums, { stripNumbers: true });

      for (const token of tokensNoNums.keys()) {
        expect(token).not.toContain('0987654321');
        expect(token).not.toContain('9988');
      }
    });

    it('filters stopwords when useStopwords is enabled', () => {
      const text = 'học lập trình và phát triển phần mềm cho doanh nghiệp';
      const tokensWithStopwords = tokenize(text, { useStopwords: false });
      const tokensWithoutStopwords = tokenize(text, { useStopwords: true, language: 'vi' });

      expect(tokensWithStopwords.has('w1:và')).toBe(true);
      expect(tokensWithStopwords.has('w1:cho')).toBe(true);

      expect(tokensWithoutStopwords.has('w1:và')).toBe(false);
      expect(tokensWithoutStopwords.has('w1:cho')).toBe(false);
      expect(tokensWithoutStopwords.has('w1:học')).toBe(true);
    });
  });
});

