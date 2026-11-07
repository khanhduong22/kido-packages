/**
 * @file full-suite-37-packages.k6.js
 * @description Grafana k6 Comprehensive Multi-Domain Load & Stress Benchmark Suite for @kido/* Packages
 *
 * Evaluates high-concurrency throughput and latencies across 5 core production domains:
 * 1. Infrastructure: Hot-Counter (Valkey write-behind & micro-batch) + SingleFlight SWR cache stampede shield
 * 2. Security: @kido/anti-spam (64-bit SimHash dedupe), @kido/audit-trail (SHA-256 hash chaining), @kido/tenant-guard (RLS injection)
 * 3. FinTech: @kido/wallet-ledger (Double-entry balance & WACB accounting), @kido/payment-vietqr (EMVCo payload & CRC16)
 * 4. E-Commerce: @kido/discount-loyalty (Voucher evaluation & tiering), @kido/bundle-pricing (Multi-variant tiered bundles)
 * 5. Logistics: @kido/bom-inventory (Recipe BOM explosion & 2-Opt TSP), @kido/geocoding-routing (Vincenty & Haversine)
 *
 * Workload Stages:
 * - Warm-up: 50 VUs (5s)
 * - Spike: 500 VUs (10s)
 * - Sustained Peak Load: 1,500 VUs (15s)
 * - Cooldown: 0 VUs (5s)
 *
 * Strict Multi-Domain Production SLAs:
 * - http_req_duration{domain:security}: p(95) < 25ms
 * - http_req_duration{domain:fintech}: p(95) < 15ms
 * - http_req_duration{domain:ecommerce}: p(95) < 15ms
 * - http_req_duration{domain:logistics}: p(95) < 35ms
 * - http_req_duration{domain:infra}: p(95) < 20ms
 * - http_req_failed: rate < 0.001 (< 0.1%)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Domain Latency Trends
const infraDuration = new Trend('infra_duration', true);
const securityDuration = new Trend('security_duration', true);
const fintechDuration = new Trend('fintech_duration', true);
const ecommerceDuration = new Trend('ecommerce_duration', true);
const logisticsDuration = new Trend('logistics_duration', true);

// Failure and Health Rates
const failedRate = new Rate('domain_failed_rate');
const successRate = new Rate('domain_success_rate');
const totalDomainOps = new Counter('total_domain_operations');

const BASE_URL = __ENV.TARGET_URL || 'http://127.0.0.1:4040';

export const options = {
  scenarios: {
    full_suite_multidomain: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 50 },    // Warm-up 50 VUs
        { duration: '10s', target: 500 },  // Spike to 500 VUs
        { duration: '15s', target: 1500 }, // Sustained load 1,500 VUs
        { duration: '5s', target: 0 },     // Cooldown
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    'http_req_duration{domain:infra}': ['p(95)<20'],
    'http_req_duration{domain:security}': ['p(95)<25'],
    'http_req_duration{domain:fintech}': ['p(95)<15'],
    'http_req_duration{domain:ecommerce}': ['p(95)<15'],
    'http_req_duration{domain:logistics}': ['p(95)<35'],
    'http_req_failed': ['rate<0.001'],
    'domain_failed_rate': ['rate<0.001'],
    'domain_success_rate': ['rate>0.999'],
  },
};

export default function () {
  const vuId = `vu-${__VU}-${__ITER}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-vu-id': vuId,
  };

  // Deterministic round-robin domain selection per iteration to distribute load evenly
  const domainSelector = __ITER % 5;

  if (domainSelector === 0) {
    // -------------------------------------------------------------------------
    // 1. INFRASTRUCTURE DOMAIN: Hot-Counter & SingleFlight Cache
    // -------------------------------------------------------------------------
    const resCounter = http.post(
      `${BASE_URL}/tier2-bigtech/hot-counter`,
      JSON.stringify({ sku: 'hot-product-sku-1', delta: 1 }),
      { headers, tags: { domain: 'infra', test: 'hot-counter' } }
    );
    infraDuration.add(resCounter.timings.duration);
    const okCounter = check(resCounter, {
      'infra counter 200': (r) => r.status === 200,
      'infra counter slot present': (r) => JSON.parse(r.body).slotId !== undefined,
    });
    if (okCounter) {
      successRate.add(1);
    } else {
      failedRate.add(1);
    }
    totalDomainOps.add(1);

    const resCache = http.get(
      `${BASE_URL}/tier2/singleflight-cache`,
      { headers, tags: { domain: 'infra', test: 'singleflight' } }
    );
    infraDuration.add(resCache.timings.duration);
    const okCache = check(resCache, {
      'infra cache 200': (r) => r.status === 200,
      'infra singleflight collapsed': (r) => JSON.parse(r.body).mode === 'tier2-singleflight',
    });
    if (okCache) {
      successRate.add(1);
    } else {
      failedRate.add(1);
    }
    totalDomainOps.add(1);

  } else if (domainSelector === 1) {
    // -------------------------------------------------------------------------
    // 2. SECURITY DOMAIN: Anti-Spam SimHash + Audit Trail SHA-256 + Tenant Guard RLS
    // -------------------------------------------------------------------------
    const resSpam = http.post(
      `${BASE_URL}/benchmark/security/anti-spam`,
      JSON.stringify({ text: `Khuyến mãi đặc biệt duy nhất trong ngày hôm nay vu-${__VU}` }),
      { headers, tags: { domain: 'security', test: 'anti-spam' } }
    );
    securityDuration.add(resSpam.timings.duration);
    const okSpam = check(resSpam, {
      'security spam 200': (r) => r.status === 200,
      'security simhash present': (r) => JSON.parse(r.body).simhash !== undefined,
    });
    if (okSpam) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);

    const resAudit = http.post(
      `${BASE_URL}/benchmark/security/audit-trail`,
      JSON.stringify({ action: 'TRANSACTION_CONFIRMED' }),
      { headers, tags: { domain: 'security', test: 'audit-trail' } }
    );
    securityDuration.add(resAudit.timings.duration);
    const okAudit = check(resAudit, {
      'security audit 200': (r) => r.status === 200,
      'security hash present': (r) => JSON.parse(r.body).hash !== undefined,
    });
    if (okAudit) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);

    const resTenant = http.post(
      `${BASE_URL}/benchmark/security/tenant-guard`,
      null,
      { headers, tags: { domain: 'security', test: 'tenant-guard' } }
    );
    securityDuration.add(resTenant.timings.duration);
    const okTenant = check(resTenant, {
      'security tenant 200': (r) => r.status === 200,
      'security rls injected': (r) => JSON.parse(r.body).whereClause !== undefined,
    });
    if (okTenant) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);

  } else if (domainSelector === 2) {
    // -------------------------------------------------------------------------
    // 3. FINTECH DOMAIN: Wallet-Ledger Double-Entry + Payment-VietQR EMVCo CRC16
    // -------------------------------------------------------------------------
    const resLedger = http.post(
      `${BASE_URL}/benchmark/fintech/wallet-ledger`,
      null,
      { headers, tags: { domain: 'fintech', test: 'wallet-ledger' } }
    );
    fintechDuration.add(resLedger.timings.duration);
    const okLedger = check(resLedger, {
      'fintech ledger 200': (r) => r.status === 200,
      'fintech balance valid': (r) => JSON.parse(r.body).balance !== undefined,
    });
    if (okLedger) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);

    const resVietqr = http.post(
      `${BASE_URL}/benchmark/fintech/payment-vietqr`,
      null,
      { headers, tags: { domain: 'fintech', test: 'payment-vietqr' } }
    );
    fintechDuration.add(resVietqr.timings.duration);
    const okVietqr = check(resVietqr, {
      'fintech vietqr 200': (r) => r.status === 200,
      'fintech crc valid': (r) => JSON.parse(r.body).crc.length === 4,
    });
    if (okVietqr) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);

  } else if (domainSelector === 3) {
    // -------------------------------------------------------------------------
    // 4. E-COMMERCE DOMAIN: Discount-Loyalty Voucher + Bundle-Pricing Multi-Variant Tier
    // -------------------------------------------------------------------------
    const resDiscount = http.post(
      `${BASE_URL}/benchmark/ecommerce/discount-loyalty`,
      null,
      { headers, tags: { domain: 'ecommerce', test: 'discount-loyalty' } }
    );
    ecommerceDuration.add(resDiscount.timings.duration);
    const okDiscount = check(resDiscount, {
      'ecommerce discount 200': (r) => r.status === 200,
      'ecommerce finalTotal valid': (r) => JSON.parse(r.body).finalTotal > 0,
    });
    if (okDiscount) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);

    const resBundle = http.post(
      `${BASE_URL}/benchmark/ecommerce/bundle-pricing`,
      null,
      { headers, tags: { domain: 'ecommerce', test: 'bundle-pricing' } }
    );
    ecommerceDuration.add(resBundle.timings.duration);
    const okBundle = check(resBundle, {
      'ecommerce bundle 200': (r) => r.status === 200,
      'ecommerce savings valid': (r) => JSON.parse(r.body).savings > 0,
    });
    if (okBundle) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);

  } else {
    // -------------------------------------------------------------------------
    // 5. LOGISTICS DOMAIN: BOM Explosion 2-Opt TSP + Geocoding Vincenty / Haversine
    // -------------------------------------------------------------------------
    const resBom = http.post(
      `${BASE_URL}/benchmark/logistics/bom-inventory`,
      null,
      { headers, tags: { domain: 'logistics', test: 'bom-inventory' } }
    );
    logisticsDuration.add(resBom.timings.duration);
    const okBom = check(resBom, {
      'logistics bom 200': (r) => r.status === 200,
      'logistics route stops valid': (r) => JSON.parse(r.body).routeStopsCount > 0,
    });
    if (okBom) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);

    const resGeo = http.post(
      `${BASE_URL}/benchmark/logistics/geocoding-routing`,
      null,
      { headers, tags: { domain: 'logistics', test: 'geocoding-routing' } }
    );
    logisticsDuration.add(resGeo.timings.duration);
    const okGeo = check(resGeo, {
      'logistics geo 200': (r) => r.status === 200,
      'logistics haversine km valid': (r) => JSON.parse(r.body).haversineKm > 0,
    });
    if (okGeo) successRate.add(1); else failedRate.add(1);
    totalDomainOps.add(1);
  }

  sleep(0.01);
}

export function teardown() {
  const res = http.get(`${BASE_URL}/metrics`);
  if (res.status === 200) {
    const metrics = JSON.parse(res.body);
    console.log('\n=======================================================');
    console.log('  🏆 FULL-SUITE 37 PACKAGES TELEMETRY REPORT SUMMARY 🏆');
    console.log('=======================================================');
    console.log(JSON.stringify(metrics, null, 2));
  }
}
