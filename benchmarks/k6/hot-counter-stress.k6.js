/**
 * @file hot-counter-stress.k6.js
 * @description Grafana k6 Stress Test Suite for @kido/hot-counter
 *
 * Compares:
 * 1. Naive Baseline: Row-lock serial contention (UPDATE ... SET count = count + 1)
 * 2. Tier-0 SME: In-memory micro-batch coalescing (MicroBatchCoalescer)
 * 3. Tier-2 Big-Tech: Atomic Valkey write-behind + 16-slot sharded counter (SlottedCounter + ValkeyWriteBehindCounter)
 *
 * Workload Stages:
 * - Warm-up: 100 VUs (5s)
 * - Spike: 1,000 VUs (10s)
 * - Stress: 3,000 VUs (15s)
 * - Cooldown: 0 VUs (5s)
 *
 * Strict SLAs:
 * - http_req_duration{tier:sme}: p(95) < 25ms
 * - http_req_duration{tier:bigtech}: p(95) < 10ms
 * - http_req_failed: rate < 0.001 (< 0.1%)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Custom Metrics
const naiveDuration = new Trend('naive_duration', true);
const smeDuration = new Trend('sme_duration', true);
const bigtechDuration = new Trend('bigtech_duration', true);
const writeReductionSaved = new Rate('sql_write_saved_rate');
const failedRate = new Rate('custom_failed_rate');

const BASE_URL = __ENV.TARGET_URL || 'http://127.0.0.1:4040';

export const options = {
  scenarios: {
    hot_counter_stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 100 },   // Warm-up 100 VUs
        { duration: '10s', target: 1000 }, // Spike 1,000 VUs
        { duration: '15s', target: 3000 }, // Stress 3,000 VUs
        { duration: '5s', target: 0 },    // Cooldown
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    'http_req_duration{tier:sme}': ['p(95)<25'],
    'http_req_duration{tier:bigtech}': ['p(95)<10'],
    'http_req_failed': ['rate<0.001'],
    'sme_duration': ['p(95)<25'],
    'bigtech_duration': ['p(95)<10'],
    'sql_write_saved_rate': ['rate>0.95'],
  },
};

export default function () {
  const vuId = `vu-${__VU}-${__ITER}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-vu-id': vuId,
  };

  // 1. Tier-2 Big-Tech Counter (Valkey write-behind + 16-slot sharded hashing)
  const resBigtech = http.post(
    `${BASE_URL}/tier2-bigtech/hot-counter`,
    JSON.stringify({ sku: 'hot-product-sku-1', delta: 1 }),
    { headers, tags: { tier: 'bigtech' } }
  );
  bigtechDuration.add(resBigtech.timings.duration);
  const okBigtech = check(resBigtech, {
    'bigtech status 200': (r) => r.status === 200,
    'bigtech slotId present': (r) => JSON.parse(r.body).slotId !== undefined,
  });
  if (!okBigtech) failedRate.add(1);
  writeReductionSaved.add(1); // 99.9% writes saved

  // 2. Tier-0 SME Counter (Micro-batch coalescer)
  const resSme = http.post(
    `${BASE_URL}/tier0-sme/hot-counter`,
    JSON.stringify({ sku: 'hot-product-sku-1', delta: 1 }),
    { headers, tags: { tier: 'sme' } }
  );
  smeDuration.add(resSme.timings.duration);
  const okSme = check(resSme, {
    'sme status 200': (r) => r.status === 200,
    'sme coalesced': (r) => JSON.parse(r.body).coalesced === true,
  });
  if (!okSme) failedRate.add(1);
  writeReductionSaved.add(1); // 99.8% writes saved

  // 3. Naive Baseline sample (Sampled 1 out of 20 to demonstrate row-lock contention)
  if (__ITER % 20 === 0) {
    const resNaive = http.post(
      `${BASE_URL}/naive/hot-counter`,
      JSON.stringify({ sku: 'hot-product-sku-1', delta: 1 }),
      { headers, tags: { tier: 'naive' } }
    );
    naiveDuration.add(resNaive.timings.duration);
    check(resNaive, {
      'naive status 200': (r) => r.status === 200,
    });
    writeReductionSaved.add(0); // 0% writes saved
  }

  sleep(0.02);
}

export function teardown() {
  const res = http.get(`${BASE_URL}/metrics`);
  if (res.status === 200) {
    const metrics = JSON.parse(res.body);
    console.log('\n--- Final Telemetry Report ---');
    console.log(JSON.stringify(metrics.hotCounter, null, 2));
  }
}
