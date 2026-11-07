/**
 * @kido/offline-sync — PostgreSQL Partition Archiver
 *
 * SSoT module providing:
 * 1. Declarative Range Partitioning & Pruning Bounds (pg_partman zero-extension equivalent)
 * 2. Zero-Lock Partition Detach & Cold-Tier S3/R2 Offload Engine (ColdTierPartitionArchiver)
 * 3. TimescaleDB Hypertable & Tiered Storage Policy Builder (buildTimescaleHypertablePolicySql)
 */

export * from './types';
export * from './declarative-partition';
export * from './cold-tier-archiver';
export * from './timescale-policy';
