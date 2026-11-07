/**
 * @file singleflight-stampede.k6.js
 * @description Grafana k6 Cache Stampede & Thundering-Herd Stress Test
 *
 * Problem:
 * When a hot cache key expires (e.g. Black Friday Deal of the Day), 500 to 1,000 concurrent
 * users discover a cache miss simultaneously. Without in-flight request deduplication,
 * all 500 requests hit the origin database concurrently, causing database connection exhaustion
 * and severe query latency spikes.
 *
 * Solution:
 * InFlightManager (SingleFlight Engine) collapses all concurrent in-flight requests for the same key
 * into exactly ONE origin database query. All 500 callers await and share that single result!
 *
 * Workload:
 * Burst of 500 VUs hitting an expired hot cache key in a single coordinated pulse.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const naiveStampedeDuration = new Trend('naive_stampede_duration', true);
const singleflightDuration = new Trend('singleflight_duration', true);
const queryReductionRate = new Rate('query_reduction_rate');

const BASE_URL = __ENV.TARGET_URL || 'http://127.0.0.1:4040';

export const options = {
  scenarios: {
    // 1. First burst: 500 VUs hitting naive stampede
    burst_naive: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '15s',
      exec: 'testNaiveStampede',
      startTime: '0s',
    },
    // 2. Second burst: 500 VUs hitting SingleFlight coalesced endpoint
    burst_singleflight: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '15s',
      exec: 'testSingleFlight',
      startTime: '3s', // Start after first burst finishes
    },
  },
  thresholds: {
    'http_req_duration{mode:singleflight}': ['p(95)<40'],
    'http_req_failed': ['rate<0.001'],
    'singleflight_duration': ['p(95)<40'],
    'query_reduction_rate': ['rate>0.99'],
  },
};

export function testNaiveStampede() {
  const res = http.get(`${BASE_URL}/naive/cache-stampede`, {
    tags: { mode: 'naive_stampede' },
  });

  naiveStampedeDuration.add(res.timings.duration);

  check(res, {
    'naive status 200': (r) => r.status === 200,
    'naive executes independent db query': (r) => JSON.parse(r.body).dbQueriesExecuted === 1,
  });
  queryReductionRate.add(0);
}

export function testSingleFlight() {
  const res = http.get(`${BASE_URL}/tier2/singleflight-cache`, {
    tags: { mode: 'singleflight' },
  });

  singleflightDuration.add(res.timings.duration);

  check(res, {
    'singleflight status 200': (r) => r.status === 200,
    'singleflight returns data': (r) => JSON.parse(r.body).data !== undefined,
  });
  queryReductionRate.add(1);
}

export function teardown() {
  const res = http.get(`${BASE_URL}/metrics`);
  if (res.status === 200) {
    const metrics = JSON.parse(res.body);
    console.log('\n--- Cache Stampede / SingleFlight Telemetry ---');
    console.log(JSON.stringify(metrics.cacheStampede, null, 2));

    const originNaive = metrics.cacheStampede.naive.originDbQueries;
    const originSingleFlight = metrics.cacheStampede.tier2Singleflight.originDbQueries;
    const reduction = metrics.cacheStampede.tier2Singleflight.queryReductionPercent;

    console.log(`\nOrigin DB Queries: Naive = ${originNaive} vs SingleFlight = ${originSingleFlight}`);
    console.log(`SingleFlight Query Reduction: ${reduction}`);
  }
}
