/**
 * @file read-replica-littles-law.k6.js
 * @description Grafana k6 Load Test Suite reproducing Black Friday Little's Law Saturation
 *
 * Workload:
 * 1,500 page_read/s x 3 sequential SQL queries = 4,500 sql_read/s
 *
 * Little's Law Queuing Trap:
 * - 9 Replicas: Capacity = 4,500 sql/s. Utilization rho = 1.0 (100% saturation).
 *   Queue factor 1/(1-rho) diverges -> queuing latency explodes to 400ms - 600ms+.
 * - 10 Replicas: Capacity = 5,000 sql/s. Utilization rho = 0.90 (10% headroom).
 *   Queue factor rho/(1-rho) = 9.0x -> latency is strictly bounded < 200ms (~60ms).
 *
 * Strict SLA:
 * - http_req_duration{tier:10_replicas}: p(95) < 200ms
 * - http_req_failed{tier:10_replicas}: rate < 0.001 (< 0.1%)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const replica9Duration = new Trend('replica_9_duration', true);
const replica10Duration = new Trend('replica_10_duration', true);
const replica10SlaMet = new Rate('replica_10_sla_met_rate');

const BASE_URL = __ENV.TARGET_URL || 'http://127.0.0.1:4040';

export const options = {
  scenarios: {
    // Scenario 1: 10 Replicas with 10% Headroom (rho = 0.90)
    tier1_10_replicas: {
      executor: 'constant-arrival-rate',
      rate: 750, // 750 page_read/s (2,250 sql/s)
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 150,
      maxVUs: 500,
      exec: 'test10Replicas',
    },
    // Scenario 2: 9 Replicas at 100% Saturation Trap (rho = 1.0)
    naive_9_replicas: {
      executor: 'constant-arrival-rate',
      rate: 750, // 750 page_read/s (2,250 sql/s)
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 200,
      maxVUs: 800,
      exec: 'test9Replicas',
    },
  },
  thresholds: {
    'http_req_duration{tier:10_replicas}': ['p(95)<200'],
    'replica_10_duration': ['p(95)<200'],
    'http_req_failed{tier:10_replicas}': ['rate<0.001'],
    'replica_10_sla_met_rate': ['rate>0.99'],
  },
};

export function test10Replicas() {
  const res = http.get(`${BASE_URL}/tier1/read-replica`, {
    tags: { tier: '10_replicas' },
  });

  replica10Duration.add(res.timings.duration);

  const ok = check(res, {
    '10_replicas status 200': (r) => r.status === 200,
    '10_replicas latency under 200ms SLA': (r) => r.timings.duration < 200,
  });

  replica10SlaMet.add(ok ? 1 : 0);
}

export function test9Replicas() {
  const res = http.get(`${BASE_URL}/naive/read-replica`, {
    tags: { tier: '9_replicas' },
  });

  replica9Duration.add(res.timings.duration);

  check(res, {
    '9_replicas status 200': (r) => r.status === 200,
    '9_replicas suffers queue delay': (r) => r.timings.duration > 200,
  });
}

export function teardown() {
  const res = http.get(`${BASE_URL}/metrics`);
  if (res.status === 200) {
    const metrics = JSON.parse(res.body);
    console.log('\n--- Read Replica Little\'s Law Telemetry ---');
    console.log(JSON.stringify(metrics.readReplica, null, 2));
  }
}
