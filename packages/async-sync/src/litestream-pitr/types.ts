import { z } from 'zod';

export const WalFrameSchema = z.object({
  generationId: z.string(),
  index: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  sql: z.string(),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]),
  description: z.string().optional(),
  checksum: z.string(),
});

export type WalFrame = z.infer<typeof WalFrameSchema>;

export const SnapshotMetadataSchema = z.object({
  generationId: z.string(),
  snapshotPath: z.string(),
  timestamp: z.string().datetime(),
  tag: z.string().optional(),
  schemaVersion: z.number().int().positive().default(1),
  frameCountAtSnapshot: z.number().int().nonnegative().default(0),
});

export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;

export interface LitestreamEngineConfig {
  dbPath: string;
  replicaDir: string;
  generationId?: string;
  pollIntervalMs?: number;
}

export interface RestorationReport {
  success: boolean;
  targetTimestamp: string;
  baseSnapshotPath: string;
  baseSnapshotTimestamp: string;
  restoredDbPath: string;
  totalReplicatedFrames: number;
  replayedFramesCount: number;
  skippedFramesCount: number;
  skippedFramesDetails: Array<{ index: number; timestamp: string; description?: string }>;
  integrityCheck: string;
  recoveredAt: string;
}

export interface R2ConfigOptions {
  accountId: string;
  bucketName: string;
  accessKeyIdEnvVar?: string;
  secretAccessKeyEnvVar?: string;
  dbPath: string;
  replicaSubPath?: string;
  retentionHours?: number;
  syncInterval?: string;
}
