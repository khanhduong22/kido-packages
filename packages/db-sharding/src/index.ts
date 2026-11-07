/**
 * @kido/db-sharding
 *
 * Tier-1 Distributed Database Sharding Engine (DDIA Chapter 6)
 *
 * 1. Modulo Hash Sharding (Shopee / GitHub / Vitess / Citus Pattern):
 *    - murmurhash3_32, murmurhash3_64, getShardId, toHexHash
 *    - HashShardRouter (Single-shard routing vs scatter-gather routing)
 *
 * 2. Consistent Hash Ring with Virtual Nodes (Discord / ScyllaDB / Cassandra / Instagram Pattern):
 *    - ConsistentHashRing, VirtualNodeEntry, RingDistributionReport
 *    - buildDiscordBucketKey (Hot-spot write spikes protection)
 *    - getReplicaNodes (Cassandra RF=3 distinct physical replica walk)
 *
 * 3. Compound Key (user_hash, created_at) Sub-Partitioning (Uber / Grab / Binance Pattern):
 *    - CompoundPartitionManager
 *    - PostgreSQL 18 Native 2-Level Declarative Sub-Partitioning DDL Generator
 *    - withCompoundShardPruning (Query pruning enforcer)
 *    - buildCompoundDetachSQL (Zero-lock concurrent historical partition detaching)
 */

export * from "./murmurhash";
export * from "./hash-router";
export * from "./consistent-hash-ring";
export * from "./compound-partition";
export * from "./tier0-sme-read-router";
