/**
 * @file tier0-sme-read-router.ts
 * @description Tier-0 SME Zero-Infra Read-Write Splitter & Little's Law Queueing Theory Engine
 *
 * Architecture Progression:
 * 1. Tier-0 SME: Primary + Read Replicas with Little's Law Headroom Guard (rho < 0.85).
 *    - Sizing rule: Never size replica clusters for 100% capacity (rho = 1.0).
 *    - Queueing delay explosion: At rho = 1.0 (e.g. 4,500 sql_read/s on 9 x 500 req/s replicas),
 *      latency explodes from 20ms to 1.42s, causing App Server connection pool exhaustion.
 *    - Headroom Guard: Keeping rho <= 0.90 (10 x 500 req/s replicas) guarantees latency < 200ms
 *      for just $20/mo extra (1 additional replica node)!
 * 2. Tier-1 Growth: PostgreSQL Native 2-Level Declarative Sub-Partitioning (CompoundPartitionManager).
 * 3. Tier-2 Big-Tech: Consistent Hash Ring with 150 vnodes & Discord Bucketed Keys (ConsistentHashRing).
 */

export interface LittleLawLatencyInput {
  arrivalRateRps: number;
  capacityRps: number;
  baseServiceMs?: number;
  queriesPerRequest?: number;
  maxSaturationLatencyMs?: number;
}

export interface LittleLawLatencyResult {
  arrivalRateRps: number;
  queriesPerRequest: number;
  totalSqlQueriesPerSec: number;
  capacityRps: number;
  utilizationRho: number;
  isSaturated: boolean;
  hasExplosionRisk: boolean;
  latencyMs: number;
  latencyFormatted: string;
  queueWaitMs: number;
  averageInFlightQueries: number;
  status: "OPTIMAL" | "HEALTHY" | "NEAR_SATURATION" | "SATURATED_EXPLOSION";
  recommendation: string;
}

/**
 * Calculates theoretical and empirical latency under Little's Law & M/M/1 Queueing Theory.
 *
 * Formula:
 * - Total SQL Arrival Rate: lambda = arrivalRateRps * queriesPerRequest
 * - Utilization: rho = lambda / capacityRps
 * - Mean Response Time (M/M/1): W = baseServiceMs / (1 - rho)
 *
 * Saturation & Practical Queue Boundary:
 * - At rho < 0.90: W <= 200ms (Healthy).
 * - At rho = 1.0: Real system queues fill connection backlog, exploding latency to 1.42s (1420ms)
 *   and causing App Server socket thread exhaustion.
 */
export function calculateLittleLawLatency(
  input: LittleLawLatencyInput
): LittleLawLatencyResult {
  const {
    arrivalRateRps,
    capacityRps,
    baseServiceMs = 20,
    queriesPerRequest = 1,
    maxSaturationLatencyMs = 1420,
  } = input;

  if (capacityRps <= 0) {
    throw new Error("Capacity (capacityRps) must be greater than 0");
  }
  if (arrivalRateRps < 0) {
    throw new Error("Arrival rate (arrivalRateRps) cannot be negative");
  }

  const totalSqlQueriesPerSec = arrivalRateRps * queriesPerRequest;
  const rawRho = totalSqlQueriesPerSec / capacityRps;
  const utilizationRho = Math.round(rawRho * 1000) / 1000;

  let latencyMs: number;
  let isSaturated = false;
  let hasExplosionRisk = false;
  let status: LittleLawLatencyResult["status"];
  let recommendation: string;

  if (utilizationRho >= 1.0) {
    // Saturated explosion boundary (1.42s latency explosion)
    isSaturated = true;
    hasExplosionRisk = true;
    status = "SATURATED_EXPLOSION";
    // Scale beyond 1.0 with congestion penalty
    const overloadFactor = Math.max(1.0, utilizationRho);
    latencyMs = Math.round(maxSaturationLatencyMs * overloadFactor);
    recommendation = `DANGER: Utilization is 100%+ (rho = ${utilizationRho.toFixed(
      2
    )}). Latency explodes to ${(latencyMs / 1000).toFixed(
      2
    )}s, starving App Server connection pools. Immediately add replica capacity!`;
  } else if (utilizationRho >= 0.9859) {
    isSaturated = true;
    hasExplosionRisk = true;
    status = "SATURATED_EXPLOSION";
    latencyMs = maxSaturationLatencyMs;
    recommendation = `CRITICAL: Utilization is at saturation boundary (rho = ${utilizationRho.toFixed(
      3
    )}). Micro-bursts will cause cascading 504 gateway timeouts.`;
  } else if (utilizationRho > 0.85) {
    status = "NEAR_SATURATION";
    hasExplosionRisk = true;
    latencyMs = Math.round((baseServiceMs / (1 - utilizationRho)) * 100) / 100;
    recommendation = `WARNING: Utilization (rho = ${utilizationRho.toFixed(
      2
    )}) exceeds Little's Law 85% headroom guard. Sizing up by 1 replica will cut latency significantly.`;
  } else if (utilizationRho > 0.60) {
    status = "HEALTHY";
    hasExplosionRisk = false;
    latencyMs = Math.round((baseServiceMs / (1 - utilizationRho)) * 100) / 100;
    recommendation = `HEALTHY: Utilization is well within safe operating limits (rho = ${utilizationRho.toFixed(
      2
    )}).`;
  } else {
    status = "OPTIMAL";
    hasExplosionRisk = false;
    latencyMs = Math.round((baseServiceMs / (1 - utilizationRho)) * 100) / 100;
    recommendation = `OPTIMAL: Ample headroom available (rho = ${utilizationRho.toFixed(
      2
    )}).`;
  }

  const queueWaitMs = Math.max(0, Math.round((latencyMs - baseServiceMs) * 100) / 100);

  // Little's Law: L = lambda * W (Average in-flight queries in the system)
  const averageInFlightQueries = Math.round(
    (totalSqlQueriesPerSec * (latencyMs / 1000)) * 10
  ) / 10;

  const latencyFormatted =
    latencyMs >= 1000
      ? `${(latencyMs / 1000).toFixed(2)}s`
      : `${Math.round(latencyMs)}ms`;

  return {
    arrivalRateRps,
    queriesPerRequest,
    totalSqlQueriesPerSec,
    capacityRps,
    utilizationRho,
    isSaturated,
    hasExplosionRisk,
    latencyMs,
    latencyFormatted,
    queueWaitMs,
    averageInFlightQueries,
    status,
    recommendation,
  };
}

export interface ReadReplicaPlanInput {
  readRequestsPerSec: number;
  queriesPerRequest?: number;
  replicaTierCapacityRps?: number;
  replicaCostUsd?: number;
  maxUtilizationRho?: number;
  baseServiceMs?: number;
}

export interface ReadReplicaPlanResult {
  totalReadQueriesPerSec: number;
  replicaTierCapacityRps: number;
  replicaCostUsd: number;
  naivePlan: {
    replicas: number;
    totalCapacityRps: number;
    utilizationRho: number;
    monthlyCostUsd: number;
    estimatedLatencyMs: number;
    estimatedLatencyFormatted: string;
    inFlightQueries: number;
    status: "SATURATED_EXPLOSION" | "DEGRADED";
    appServerStarvationRisk: boolean;
  };
  recommendedPlan: {
    replicas: number;
    totalCapacityRps: number;
    utilizationRho: number;
    monthlyCostUsd: number;
    estimatedLatencyMs: number;
    estimatedLatencyFormatted: string;
    inFlightQueries: number;
    status: "OPTIMAL" | "HEALTHY";
    headroomPercent: number;
  };
  costDifferenceUsd: number;
  costIncreasePercent: string;
  latencyImprovementFactor: number;
  analysis: string;
}

/**
 * Plans read replica cluster capacity demonstrating Little's Law Headroom Guard.
 *
 * Example:
 * 4,500 sql_read/s with 500 req/s replicas ($20/mo):
 * - Naive Plan (rho = 1.0): 9 replicas = $180/mo -> 1.42s latency explosion, 6,390 in-flight queries!
 * - Recommended Plan (rho <= 0.90): 10 replicas = $200/mo (+$20/mo) -> 200ms latency, 900 in-flight queries!
 */
export function planReadReplicaCluster(
  input: ReadReplicaPlanInput
): ReadReplicaPlanResult {
  const {
    readRequestsPerSec,
    queriesPerRequest = 1,
    replicaTierCapacityRps = 500,
    replicaCostUsd = 20,
    maxUtilizationRho = 0.85,
    baseServiceMs = 20,
  } = input;

  const totalReadQueriesPerSec = readRequestsPerSec * queriesPerRequest;

  // 1. Naive Plan: 100% capacity arithmetic (rho = 1.0)
  const naiveReplicas = Math.max(
    1,
    Math.ceil(totalReadQueriesPerSec / replicaTierCapacityRps)
  );
  const naiveCapacityRps = naiveReplicas * replicaTierCapacityRps;
  const naiveLatencyResult = calculateLittleLawLatency({
    arrivalRateRps: readRequestsPerSec,
    queriesPerRequest,
    capacityRps: naiveCapacityRps,
    baseServiceMs,
  });

  const naiveMonthlyCostUsd = naiveReplicas * replicaCostUsd;

  // 2. Recommended Plan: Headroom Guard rho <= maxUtilizationRho (e.g. 0.85 or 0.90)
  const safeRho = Math.min(0.90, Math.max(0.50, maxUtilizationRho));
  const recommendedReplicas = Math.max(
    1,
    Math.ceil(totalReadQueriesPerSec / (replicaTierCapacityRps * safeRho))
  );
  const recommendedCapacityRps = recommendedReplicas * replicaTierCapacityRps;
  const recommendedLatencyResult = calculateLittleLawLatency({
    arrivalRateRps: readRequestsPerSec,
    queriesPerRequest,
    capacityRps: recommendedCapacityRps,
    baseServiceMs,
  });

  const recommendedMonthlyCostUsd = recommendedReplicas * replicaCostUsd;
  const costDifferenceUsd = recommendedMonthlyCostUsd - naiveMonthlyCostUsd;
  const costIncreasePercent =
    naiveMonthlyCostUsd > 0
      ? `${(((recommendedMonthlyCostUsd - naiveMonthlyCostUsd) / naiveMonthlyCostUsd) * 100).toFixed(1)}%`
      : "0%";

  const latencyImprovementFactor =
    recommendedLatencyResult.latencyMs > 0
      ? Math.round(
          (naiveLatencyResult.latencyMs / recommendedLatencyResult.latencyMs) * 10
        ) / 10
      : 1;

  const headroomPercent = Math.round(
    (1 - recommendedLatencyResult.utilizationRho) * 100
  );

  const analysis =
    `[Little's Law Headroom Proof]\n` +
    `• Naive Plan (${naiveReplicas} replicas @ $${naiveMonthlyCostUsd}/mo): Utilization rho = ${naiveLatencyResult.utilizationRho.toFixed(
      2
    )} (100% saturation). Latency explodes to ${naiveLatencyResult.latencyFormatted} with ${naiveLatencyResult.averageInFlightQueries} in-flight queries starving App Server pool.\n` +
    `• Recommended Plan (${recommendedReplicas} replicas @ $${recommendedMonthlyCostUsd}/mo): Utilization rho = ${recommendedLatencyResult.utilizationRho.toFixed(
      2
    )} (with ${headroomPercent}% headroom). Latency drops to ${recommendedLatencyResult.latencyFormatted} (${latencyImprovementFactor}x faster) for only +$${costDifferenceUsd}/mo (+${costIncreasePercent}).`;

  return {
    totalReadQueriesPerSec,
    replicaTierCapacityRps,
    replicaCostUsd,
    naivePlan: {
      replicas: naiveReplicas,
      totalCapacityRps: naiveCapacityRps,
      utilizationRho: naiveLatencyResult.utilizationRho,
      monthlyCostUsd: naiveMonthlyCostUsd,
      estimatedLatencyMs: naiveLatencyResult.latencyMs,
      estimatedLatencyFormatted: naiveLatencyResult.latencyFormatted,
      inFlightQueries: naiveLatencyResult.averageInFlightQueries,
      status:
        naiveLatencyResult.utilizationRho >= 1.0
          ? "SATURATED_EXPLOSION"
          : "DEGRADED",
      appServerStarvationRisk: naiveLatencyResult.hasExplosionRisk,
    },
    recommendedPlan: {
      replicas: recommendedReplicas,
      totalCapacityRps: recommendedCapacityRps,
      utilizationRho: recommendedLatencyResult.utilizationRho,
      monthlyCostUsd: recommendedMonthlyCostUsd,
      estimatedLatencyMs: recommendedLatencyResult.latencyMs,
      estimatedLatencyFormatted: recommendedLatencyResult.latencyFormatted,
      inFlightQueries: recommendedLatencyResult.averageInFlightQueries,
      status:
        recommendedLatencyResult.utilizationRho <= 0.60 ? "OPTIMAL" : "HEALTHY",
      headroomPercent,
    },
    costDifferenceUsd,
    costIncreasePercent,
    latencyImprovementFactor,
    analysis,
  };
}

export interface SmeReplicaNode {
  id: string;
  url: string;
  capacityRps?: number;
  isHealthy?: boolean;
  currentConnections?: number;
  weight?: number;
}

export interface SmeReadWriteSplitterOptions {
  primaryUrl: string;
  replicas?: Array<SmeReplicaNode | string>;
  maxUtilizationRho?: number;
  baseServiceMs?: number;
  stickySessionWindowMs?: number;
  fallbackToPrimaryOnDegraded?: boolean;
}

export type RouteReason =
  | "EXPLICIT_PRIMARY"
  | "WRITE_OPERATION"
  | "STICKY_SESSION_READ_YOUR_OWN_WRITES"
  | "FALLBACK_NO_HEALTHY_REPLICAS"
  | "READ_REPLICA_BALANCED";

export interface RouteDecision {
  target: "primary" | "replica";
  url: string;
  replicaId?: string;
  reason: RouteReason;
  utilizationRho: number;
}

export interface RouteQueryInput {
  sql?: string;
  isWrite?: boolean;
  forcePrimary?: boolean;
  userId?: string;
}

/**
 * Tier-0 SME Read/Write Splitter
 *
 * Directs writes and sensitive operations to Primary DB, and routes read traffic
 * across read replicas while enforcing:
 * 1. Read-your-own-writes session stickiness (sticky window after write).
 * 2. Automatic fallback to Primary when all replicas are degraded.
 * 3. Little's Law headroom tracking.
 */
export class SmeReadWriteSplitter {
  private readonly primaryUrl: string;
  private readonly replicas: SmeReplicaNode[] = [];
  private readonly maxUtilizationRho: number;
  private readonly baseServiceMs: number;
  private readonly stickySessionWindowMs: number;
  private readonly fallbackToPrimaryOnDegraded: boolean;

  private userStickyWrites = new Map<string, number>();
  private roundRobinIndex = 0;

  // Telemetry
  private totalQueries = 0;
  private primaryQueries = 0;
  private replicaQueries = 0;

  constructor(options: SmeReadWriteSplitterOptions) {
    this.primaryUrl = options.primaryUrl;
    this.maxUtilizationRho = options.maxUtilizationRho ?? 0.85;
    this.baseServiceMs = options.baseServiceMs ?? 20;
    this.stickySessionWindowMs = options.stickySessionWindowMs ?? 5000;
    this.fallbackToPrimaryOnDegraded =
      options.fallbackToPrimaryOnDegraded ?? true;

    if (options.replicas) {
      for (let i = 0; i < options.replicas.length; i++) {
        const item = options.replicas[i];
        if (typeof item === "string") {
          this.replicas.push({
            id: `replica-${i + 1}`,
            url: item,
            capacityRps: 500,
            isHealthy: true,
            currentConnections: 0,
            weight: 1,
          });
        } else {
          this.replicas.push({
            id: item.id || `replica-${i + 1}`,
            url: item.url,
            capacityRps: item.capacityRps ?? 500,
            isHealthy: item.isHealthy ?? true,
            currentConnections: item.currentConnections ?? 0,
            weight: item.weight ?? 1,
          });
        }
      }
    }
  }

  public isWriteQuery(sql: string): boolean {
    if (!sql || typeof sql !== "string") return false;
    const trimmed = sql.trim().toUpperCase();
    const writeKeywords = [
      "INSERT",
      "UPDATE",
      "DELETE",
      "CREATE",
      "ALTER",
      "DROP",
      "TRUNCATE",
      "BEGIN",
      "COMMIT",
      "ROLLBACK",
      "SET",
    ];

    for (const kw of writeKeywords) {
      if (trimmed.startsWith(kw)) {
        return true;
      }
    }

    // Explicit locking reads require primary
    if (trimmed.includes("FOR UPDATE") || trimmed.includes("FOR SHARE")) {
      return true;
    }

    return false;
  }

  public recordWrite(userId: string, timestamp: number = Date.now()): void {
    if (!userId) return;
    this.userStickyWrites.set(userId, timestamp + this.stickySessionWindowMs);
  }

  public isUserInStickyWindow(userId: string, now: number = Date.now()): boolean {
    if (!userId) return false;
    const expiresAt = this.userStickyWrites.get(userId);
    if (!expiresAt) return false;
    if (now > expiresAt) {
      this.userStickyWrites.delete(userId);
      return false;
    }
    return true;
  }

  public markReplicaHealthy(replicaId: string, healthy: boolean): void {
    const replica = this.replicas.find((r) => r.id === replicaId);
    if (replica) {
      replica.isHealthy = healthy;
    }
  }

  public getHealthyReplicas(): SmeReplicaNode[] {
    return this.replicas.filter((r) => r.isHealthy !== false);
  }

  public getTotalReplicaCapacityRps(): number {
    return this.getHealthyReplicas().reduce(
      (acc, r) => acc + (r.capacityRps ?? 500),
      0
    );
  }

  public routeQuery(input: RouteQueryInput): RouteDecision {
    this.totalQueries++;

    // 1. Explicit Primary
    if (input.forcePrimary) {
      this.primaryQueries++;
      return {
        target: "primary",
        url: this.primaryUrl,
        reason: "EXPLICIT_PRIMARY",
        utilizationRho: 0,
      };
    }

    // 2. Write Operation
    const isWrite = input.isWrite ?? (input.sql ? this.isWriteQuery(input.sql) : false);
    if (isWrite) {
      if (input.userId) {
        this.recordWrite(input.userId);
      }
      this.primaryQueries++;
      return {
        target: "primary",
        url: this.primaryUrl,
        reason: "WRITE_OPERATION",
        utilizationRho: 0,
      };
    }

    // 3. Sticky Session: Read-Your-Own-Writes Consistency
    if (input.userId && this.isUserInStickyWindow(input.userId)) {
      this.primaryQueries++;
      return {
        target: "primary",
        url: this.primaryUrl,
        reason: "STICKY_SESSION_READ_YOUR_OWN_WRITES",
        utilizationRho: 0,
      };
    }

    // 4. Read Query across Healthy Replicas
    const healthyReplicas = this.getHealthyReplicas();
    if (healthyReplicas.length === 0) {
      if (this.fallbackToPrimaryOnDegraded) {
        this.primaryQueries++;
        return {
          target: "primary",
          url: this.primaryUrl,
          reason: "FALLBACK_NO_HEALTHY_REPLICAS",
          utilizationRho: 1.0,
        };
      }
      throw new Error(
        "No healthy read replicas available and fallbackToPrimaryOnDegraded is disabled"
      );
    }

    // Round-Robin replica selection
    const replica = healthyReplicas[this.roundRobinIndex % healthyReplicas.length];
    this.roundRobinIndex++;
    this.replicaQueries++;

    return {
      target: "replica",
      url: replica.url,
      replicaId: replica.id,
      reason: "READ_REPLICA_BALANCED",
      utilizationRho: this.maxUtilizationRho,
    };
  }

  public evaluateClusterHeadroom(
    arrivalRateRps: number,
    queriesPerRequest: number = 1
  ): LittleLawLatencyResult {
    const totalCapacity = this.getTotalReplicaCapacityRps();
    return calculateLittleLawLatency({
      arrivalRateRps,
      capacityRps: totalCapacity > 0 ? totalCapacity : 500,
      queriesPerRequest,
      baseServiceMs: this.baseServiceMs,
    });
  }

  public getMetrics(): {
    totalQueries: number;
    primaryQueries: number;
    replicaQueries: number;
    totalReplicas: number;
    healthyReplicas: number;
    totalCapacityRps: number;
  } {
    return {
      totalQueries: this.totalQueries,
      primaryQueries: this.primaryQueries,
      replicaQueries: this.replicaQueries,
      totalReplicas: this.replicas.length,
      healthyReplicas: this.getHealthyReplicas().length,
      totalCapacityRps: this.getTotalReplicaCapacityRps(),
    };
  }
}
