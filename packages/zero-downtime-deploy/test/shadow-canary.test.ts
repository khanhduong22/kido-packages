import { describe, it, expect } from 'bun:test';
import {
  runShadowParityCheck,
  buildShadowAndCanaryBashGate,
} from '../src/index';

describe('Tier-5/6/7 Shadow Parity, JIT Warm-up & Zero-Gap Canary Suite', () => {
  it('should pass shadow parity check when baseline and candidate match 100%', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'auth-api', timestamp: Date.now() }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    const result = await runShadowParityCheck({
      baselineUrl: 'http://baseline.internal:3000',
      candidateUrl: 'http://candidate.internal:3000',
      probeCount: 3,
      paths: ['/health'],
      fetchImpl: mockFetch,
    });

    expect(result.passed).toBe(true);
    expect(result.probesRun).toBe(3);
    expect(result.statusMismatches).toBe(0);
    expect(result.schemaMismatches).toBe(0);
    expect(result.reason).toBeUndefined();
  });

  it('should fail shadow parity check when candidate returns HTTP 500', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('candidate')) {
        return new Response(JSON.stringify({ error: 'Crash' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await runShadowParityCheck({
      baselineUrl: 'http://baseline.internal:3000',
      candidateUrl: 'http://candidate.internal:3000',
      probeCount: 2,
      paths: ['/health'],
      fetchImpl: mockFetch,
    });

    expect(result.passed).toBe(false);
    expect(result.statusMismatches).toBe(2);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('Status mismatch');
  });

  it('should fail shadow parity check when candidate JSON schema is missing keys', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('candidate')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Baseline has extra schema keys (e.g. version, commit)
      return new Response(JSON.stringify({ status: 'ok', version: '2.0.0', commit: 'abcdef' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await runShadowParityCheck({
      baselineUrl: 'http://baseline.internal:3000',
      candidateUrl: 'http://candidate.internal:3000',
      probeCount: 2,
      fetchImpl: mockFetch,
    });

    expect(result.passed).toBe(false);
    expect(result.schemaMismatches).toBe(2);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('Schema mismatch');
  });

  it('should generate bash gate containing --alias, canary log inspection, and zero-gap sequence', () => {
    const bash = buildShadowAndCanaryBashGate({
      activeContainer: 'order-api',
      candidateContainer: 'order-api_next',
      backupContainer: 'order-api_old',
      networkName: 'ops_bridge',
      internalPort: 3001,
      healthPath: '/health',
      shadowProbes: 5,
      canarySeconds: 10,
      drainSeconds: 3,
    });

    // Tier-6 Shadow JIT probes
    expect(bash).toContain('SHADOW_PROBES=5');
    expect(bash).toContain('X-Shadow-Probe: 1');

    // Tier-5 & Tier-7 Zero-Gap Alias & Canary Window
    expect(bash).toContain('docker network connect --alias "$ACTIVE_CONTAINER" "$NETWORK_NAME" "$CANDIDATE_CONTAINER"');
    expect(bash).toContain('CANARY_SECONDS=10');
    expect(bash).toContain('docker logs --since "${CANARY_SECONDS}s" "$CANDIDATE_CONTAINER"');
    expect(bash).toContain('panic:|uncaughtException|unhandledRejection|PrismaClientInitializationError|"status":50[0-9]');

    // Tier-5 Zero-gap Promotion & cutover
    expect(bash).toContain('docker network disconnect "$NETWORK_NAME" "$ACTIVE_CONTAINER"');
    expect(bash).toContain('docker rename "$ACTIVE_CONTAINER" "$BACKUP_CONTAINER"');
    expect(bash).toContain('docker rename "$CANDIDATE_CONTAINER" "$ACTIVE_CONTAINER"');
    expect(bash).toContain('DRAIN_SECONDS=3');
  });
});
