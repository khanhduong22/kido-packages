import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AuditEntry,
  CreateAuditEntryInput,
  AnomalyFlag,
  AnomalyConfig,
  IntegrityVerificationResult,
  ShiftSnapshot,
} from './types';
import {
  GENESIS_HASH,
  createAuditEntry,
  verifyChainIntegrity,
} from './hash-chain';
import { AnomalyDetector } from './anomaly-detector';
import { MerkleTree } from './merkle-tree';

/**
 * Storage adapter interface for immutable append-only persistence
 */
export interface AuditStorageAdapter {
  append(entry: AuditEntry): Promise<void> | void;
  getAll(): Promise<AuditEntry[]> | AuditEntry[];
  getById(id: string): Promise<AuditEntry | null> | AuditEntry | null;
  clear?(): Promise<void> | void;
}

/**
 * High-performance in-memory append-only storage adapter
 */
export class MemoryStorageAdapter implements AuditStorageAdapter {
  private readonly records: AuditEntry[] = [];
  private readonly indexMap: Map<string, AuditEntry> = new Map();

  public append(entry: AuditEntry): void {
    // Clone and freeze to guarantee immutability in memory
    const immutableEntry = Object.freeze({ ...entry });
    this.records.push(immutableEntry);
    this.indexMap.set(entry.id, immutableEntry);
  }

  public getAll(): AuditEntry[] {
    return [...this.records];
  }

  public getById(id: string): AuditEntry | null {
    return this.indexMap.get(id) ?? null;
  }

  public clear(): void {
    this.records.length = 0;
    this.indexMap.clear();
  }

  /**
   * Internal test helper for tampering simulation
   */
  public _tamperRecordForTesting(index: number, patch: Partial<AuditEntry>): void {
    if (this.records[index]) {
      this.records[index] = {
        ...this.records[index],
        ...patch,
      };
      this.indexMap.set(this.records[index].id, this.records[index]);
    }
  }
}

/**
 * Persistent append-only file streaming storage adapter (JSON Lines)
 */
export class FileStreamingStorageAdapter implements AuditStorageAdapter {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  public append(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.filePath, line, { encoding: 'utf-8' });
  }

  public getAll(): AuditEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as AuditEntry);
  }

  public getById(id: string): AuditEntry | null {
    const entries = this.getAll();
    return entries.find((e) => e.id === id) ?? null;
  }

  public clear(): void {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }
}

/**
 * Configuration options for the AuditLogger instance
 */
export interface AuditLoggerOptions {
  storage?: AuditStorageAdapter;
  genesisHash?: string;
  anomalyConfig?: Partial<AnomalyConfig>;
  anomalyDetector?: AnomalyDetector;
  onAnomalyDetected?: (
    entry: AuditEntry,
    anomalies: AnomalyFlag[]
  ) => void | Promise<void>;
}

/**
 * Result returned from a log operation including entry and detected anomalies
 */
export interface LogResult {
  entry: AuditEntry;
  anomalies: AnomalyFlag[];
}

/**
 * Production-grade Append-Only Immutable Audit Logger
 * Features:
 * - SHA-256 Hash Chaining
 * - Real-time Anomaly & Fraud Detection with immediate callback alerts
 * - Instant Tamper Detection
 * - Merkle Tree Financial Shift Anchoring
 */
export class AuditLogger {
  private readonly storage: AuditStorageAdapter;
  private readonly genesisHash: string;
  private readonly anomalyDetector: AnomalyDetector;
  private readonly onAnomalyDetected?: (
    entry: AuditEntry,
    anomalies: AnomalyFlag[]
  ) => void | Promise<void>;

  private lastHash: string;
  private initialized: boolean = false;

  constructor(options: AuditLoggerOptions = {}) {
    this.storage = options.storage ?? new MemoryStorageAdapter();
    this.genesisHash = options.genesisHash ?? GENESIS_HASH;
    this.lastHash = this.genesisHash;
    this.anomalyDetector =
      options.anomalyDetector ?? new AnomalyDetector(options.anomalyConfig);
    this.onAnomalyDetected = options.onAnomalyDetected;
  }

  /**
   * Initialize and restore the state of the hash chain from storage
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return;

    const allEntries = await this.storage.getAll();
    if (allEntries.length > 0) {
      this.lastHash = allEntries[allEntries.length - 1].currentHash;
    } else {
      this.lastHash = this.genesisHash;
    }

    this.initialized = true;
  }

  /**
   * Log an audit event, append to the cryptographic hash chain, and inspect for anomalies
   */
  public async log(input: CreateAuditEntryInput): Promise<LogResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // 1. Create chained audit entry
    const entry = createAuditEntry(input, this.lastHash);

    // 2. Persist append-only
    await this.storage.append(entry);

    // 3. Advance hash pointer
    this.lastHash = entry.currentHash;

    // 4. Real-time anomaly detection
    const anomalies = this.anomalyDetector.detect(entry);

    // 5. Fire alert callback if anomalies detected
    if (anomalies.length > 0 && this.onAnomalyDetected) {
      try {
        await this.onAnomalyDetected(entry, anomalies);
      } catch (err) {
        console.error('[AuditLogger] Error in onAnomalyDetected callback:', err);
      }
    }

    return { entry, anomalies };
  }

  /**
   * Synchronous log helper for MemoryStorageAdapter scenarios
   */
  public logSync(input: CreateAuditEntryInput): LogResult {
    const entry = createAuditEntry(input, this.lastHash);
    this.storage.append(entry);
    this.lastHash = entry.currentHash;

    const anomalies = this.anomalyDetector.detect(entry);
    if (anomalies.length > 0 && this.onAnomalyDetected) {
      try {
        this.onAnomalyDetected(entry, anomalies);
      } catch (err) {
        console.error('[AuditLogger] Error in onAnomalyDetected callback:', err);
      }
    }

    return { entry, anomalies };
  }

  /**
   * Verify the cryptographic integrity of the entire audit chain
   */
  public async verifyIntegrity(): Promise<IntegrityVerificationResult> {
    const records = await this.storage.getAll();
    return verifyChainIntegrity(records, this.genesisHash);
  }

  /**
   * Anchor a shift of transactions into a Merkle Tree snapshot
   */
  public async createShiftSnapshot(
    shiftId: string,
    options?: {
      branchId?: string;
      filter?: (entry: AuditEntry) => boolean;
      metadata?: Record<string, unknown>;
    }
  ): Promise<ShiftSnapshot> {
    let entries = await this.storage.getAll();
    if (options?.filter) {
      entries = entries.filter(options.filter);
    }

    return MerkleTree.anchorShift(shiftId, entries, {
      branchId: options?.branchId,
      metadata: options?.metadata,
    });
  }

  /**
   * Retrieve all logged entries
   */
  public async getEntries(): Promise<AuditEntry[]> {
    return await this.storage.getAll();
  }

  /**
   * Retrieve an audit entry by its unique ID
   */
  public async getEntryById(id: string): Promise<AuditEntry | null> {
    return await this.storage.getById(id);
  }

  /**
   * Retrieve current head hash of the chain
   */
  public getLastHash(): string {
    return this.lastHash;
  }

  /**
   * Access underlying AnomalyDetector instance
   */
  public getAnomalyDetector(): AnomalyDetector {
    return this.anomalyDetector;
  }

  /**
   * Access underlying storage adapter
   */
  public getStorage(): AuditStorageAdapter {
    return this.storage;
  }
}
