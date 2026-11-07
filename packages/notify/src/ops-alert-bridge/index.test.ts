import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertTransformer,
  detectAlertSource,
  normalizeStatus,
  normalizeSeverity,
  TelegramChannel,
  DiscordChannel,
  SlackChannel,
  escapeHtml,
  createAlertBridgeHandler,
  CanonicalAlert,
  AlertChannel,
  ChannelSendResult,
} from './index';

describe('@kido/ops-alert-bridge Test Suite', () => {
  describe('1. AlertTransformer & Payload Normalization', () => {
    it('should normalize status and severity correctly', () => {
      assert.equal(normalizeStatus('firing'), 'firing');
      assert.equal(normalizeStatus('down'), 'firing');
      assert.equal(normalizeStatus('resolved'), 'resolved');
      assert.equal(normalizeStatus('up'), 'resolved');
      assert.equal(normalizeStatus(1), 'resolved');
      assert.equal(normalizeStatus(0), 'firing');

      assert.equal(normalizeSeverity('critical'), 'critical');
      assert.equal(normalizeSeverity('fatal'), 'critical');
      assert.equal(normalizeSeverity('warning'), 'warning');
      assert.equal(normalizeSeverity('info'), 'info');
      assert.equal(normalizeSeverity(undefined, 'firing'), 'critical');
      assert.equal(normalizeSeverity(undefined, 'resolved'), 'info');
    });

    it('should detect source from payload shape', () => {
      assert.equal(detectAlertSource({ heartbeat: {}, monitor: {} }), 'uptime_kuma');
      assert.equal(detectAlertSource({ alerts: [{ labels: {}, annotations: {} }] }), 'alertmanager');
      assert.equal(detectAlertSource({ alertName: 'Test', state: 'FIRING' }), 'signoz');
      assert.equal(detectAlertSource({ message: 'Hello' }), 'generic');
    });

    it('should transform Prometheus / Alertmanager webhook payload', () => {
      const promPayload = {
        receiver: 'web.hook',
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: {
              alertname: 'HighCpuLoad',
              severity: 'critical',
              service: 'checkout-api',
              instance: 'prod-edge-01',
            },
            annotations: {
              summary: 'CPU usage > 90% for 5m',
              description: 'Host CPU is at 95% sustained',
            },
            startsAt: '2026-10-05T10:00:00Z',
            generatorURL: 'https://prometheus.khanhdp.com/graph?g0.expr=cpu_load',
          },
        ],
      };

      const alerts = AlertTransformer.transform(promPayload);
      assert.equal(alerts.length, 1);
      const a = alerts[0];
      assert.equal(a.status, 'firing');
      assert.equal(a.severity, 'critical');
      assert.equal(a.title.includes('[FIRING] HighCpuLoad (checkout-api)'), true);
      assert.equal(a.summary, 'CPU usage > 90% for 5m');
      assert.equal(a.description, 'Host CPU is at 95% sustained');
      assert.equal(a.service, 'checkout-api');
      assert.equal(a.source, 'alertmanager');
      assert.equal(a.url?.includes('prometheus.khanhdp.com'), true);
    });

    it('should transform Prometheus resolved alert', () => {
      const promResolved = {
        status: 'resolved',
        alerts: [
          {
            status: 'resolved',
            labels: { alertname: 'HighCpuLoad', severity: 'warning', service: 'caddy' },
            annotations: { summary: 'CPU returned to normal' },
            startsAt: '2026-10-05T10:00:00Z',
            endsAt: '2026-10-05T10:10:00Z',
          },
        ],
      };

      const alerts = AlertTransformer.transform(promResolved);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].status, 'resolved');
      assert.equal(alerts[0].title.includes('[RESOLVED]'), true);
      assert.equal(alerts[0].endsAt, '2026-10-05T10:10:00Z');
    });

    it('should transform Uptime Kuma down and up alerts', () => {
      // Down alert
      const kumaDownPayload = {
        heartbeat: {
          status: 0,
          msg: 'Connection timed out after 3000ms',
          ping: null,
          time: '2026-10-05 10:15:00.000',
        },
        monitor: {
          id: 5,
          name: 'Beszel Hub',
          url: 'https://beszel.khanhdp.com',
          type: 'http',
        },
        msg: '[🔴 Down] [Beszel Hub] Connection timed out',
      };

      const alertsDown = AlertTransformer.transform(kumaDownPayload);
      assert.equal(alertsDown.length, 1);
      assert.equal(alertsDown[0].status, 'firing');
      assert.equal(alertsDown[0].severity, 'critical');
      assert.equal(alertsDown[0].service, 'Beszel Hub');
      assert.equal(alertsDown[0].title.includes('Service Outage: Beszel Hub'), true);
      assert.equal(alertsDown[0].summary.includes('Connection timed out'), true);
      assert.equal(alertsDown[0].url, 'https://beszel.khanhdp.com');

      // Up alert
      const kumaUpPayload = {
        heartbeat: {
          status: 1,
          msg: '200 OK',
          ping: 35,
          time: '2026-10-05 10:18:00.000',
        },
        monitor: {
          id: 5,
          name: 'Beszel Hub',
          url: 'https://beszel.khanhdp.com',
          type: 'http',
        },
      };

      const alertsUp = AlertTransformer.transform(kumaUpPayload);
      assert.equal(alertsUp.length, 1);
      assert.equal(alertsUp[0].status, 'resolved');
      assert.equal(alertsUp[0].severity, 'info');
      assert.equal(alertsUp[0].title.includes('Service Recovered: Beszel Hub'), true);
      assert.equal(alertsUp[0].summary.includes('ping: 35ms'), true);
    });

    it('should transform SigNoz webhook format', () => {
      const signozPayload = {
        alertName: 'PostgresHighLatency',
        state: 'FIRING',
        severity: 'critical',
        service: 'postgres-db',
        summary: 'Query latency p95 > 200ms',
        ruleUrl: 'https://signoz.khanhdp.com/alerts/123',
      };

      const alerts = AlertTransformer.transform(signozPayload);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].status, 'firing');
      assert.equal(alerts[0].source, 'signoz');
      assert.equal(alerts[0].service, 'postgres-db');
      assert.equal(alerts[0].url, 'https://signoz.khanhdp.com/alerts/123');
    });

    it('should transform generic payload gracefully', () => {
      const genericPayload = {
        title: 'Manual DB Maintenance',
        status: 'ok',
        summary: 'Vacuum analyze completed successfully',
      };

      const alerts = AlertTransformer.transform(genericPayload);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].status, 'resolved');
      assert.equal(alerts[0].source, 'generic');
    });
  });

  describe('2. Notification Channels (Telegram, Discord, Slack)', () => {
    const sampleAlert: CanonicalAlert = {
      id: 'alert_test_123',
      status: 'firing',
      severity: 'critical',
      title: 'Database Disk Full',
      summary: '/var/lib/postgresql disk space at 94%',
      description: 'Runbook: ssh prod-node-01 "df -h" & clean archived WAL',
      service: 'postgresql-prod',
      source: 'alertmanager',
      startsAt: '2026-10-05T10:20:00Z',
      labels: { instance: 'prod-node-01' },
      annotations: {},
      url: 'https://grafana.khanhdp.com/d/db',
    };

    it('should escape HTML correctly for Telegram', () => {
      assert.equal(
        escapeHtml('<script>alert("xss") & test</script>'),
        '&lt;script&gt;alert(&quot;xss&quot;) &amp; test&lt;/script&gt;'
      );
    });

    it('should format Telegram HTML and send via customFetch', async () => {
      let sentUrl = '';
      let sentBody: Record<string, unknown> = {};

      const mockFetch: typeof fetch = async (url, init) => {
        sentUrl = String(url);
        sentBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), { status: 200 });
      };

      const channel = new TelegramChannel({
        botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        chatId: -100123456789,
        messageThreadId: 42,
        headerPrefix: '[KT-PROD]',
        customFetch: mockFetch,
      });

      const formattedHtml = channel.formatAlertHtml(sampleAlert);
      assert.equal(formattedHtml.includes('🔴 <b>[KT-PROD] [FIRING]'), true);
      assert.equal(formattedHtml.includes('<b>Service:</b> <code>postgresql-prod</code>'), true);
      assert.equal(formattedHtml.includes('https://grafana.khanhdp.com/d/db'), true);

      const results = await channel.send([sampleAlert]);
      assert.equal(results.length, 1);
      assert.equal(results[0].success, true);
      assert.equal(results[0].channel, 'telegram');
      assert.equal(sentUrl.includes('api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage'), true);
      assert.equal(sentBody.chat_id, -100123456789);
      assert.equal(sentBody.message_thread_id, 42);
    });

    it('should format Discord Embed and send via customFetch', async () => {
      let sentBody: Record<string, unknown> = {};

      const mockFetch: typeof fetch = async (_url, init) => {
        sentBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      };

      const channel = new DiscordChannel({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
        username: 'KT Ops Sentry',
        customFetch: mockFetch,
      });

      const embed = channel.formatEmbed(sampleAlert);
      assert.equal(embed.title, 'Database Disk Full');
      assert.equal(embed.color, 0xDC2626); // Red for critical firing

      const results = await channel.send([sampleAlert]);
      assert.equal(results[0].success, true);
      assert.equal(sentBody.username, 'KT Ops Sentry');
      assert.equal(Array.isArray(sentBody.embeds), true);
    });

    it('should format Slack Block Kit and send via customFetch', async () => {
      let sentBody: Record<string, unknown> = {};

      const mockFetch: typeof fetch = async (_url, init) => {
        sentBody = JSON.parse(String(init?.body));
        return new Response('ok', { status: 200 });
      };

      const channel = new SlackChannel({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/X00',
        channel: '#ops-alerts',
        customFetch: mockFetch,
      });

      const payload = channel.formatPayload(sampleAlert);
      assert.equal(payload.channel, '#ops-alerts');

      const results = await channel.send([sampleAlert]);
      assert.equal(results[0].success, true);
      assert.equal(sentBody.channel, '#ops-alerts');
    });
  });

  describe('3. Webhook Bridge Handler & Server Integration', () => {
    class MockChannel implements AlertChannel {
      public readonly name = 'mock_channel';
      public sentAlerts: CanonicalAlert[] = [];

      public async send(alerts: CanonicalAlert[]): Promise<ChannelSendResult[]> {
        this.sentAlerts.push(...alerts);
        return alerts.map((a) => ({
          channel: this.name,
          success: true,
          alertId: a.id,
          statusCode: 200,
        }));
      }
    }

    it('should reject non-POST requests with 405 Method Not Allowed', async () => {
      const mockChannel = new MockChannel();
      const bridge = createAlertBridgeHandler({ channels: [mockChannel] });

      const req = new Request('http://localhost:3030/webhook', { method: 'GET' });
      const res = await bridge.handleRequest(req);
      assert.equal(res.status, 405);
    });

    it('should enforce secret authentication when configured', async () => {
      const mockChannel = new MockChannel();
      const bridge = createAlertBridgeHandler({
        secret: 'kido_ops_secret_2026',
        channels: [mockChannel],
      });

      // 1. Missing secret -> 401
      const reqMissing = new Request('http://localhost:3030/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test' }),
      });
      const resMissing = await bridge.handleRequest(reqMissing);
      assert.equal(resMissing.status, 401);

      // 2. Bearer Authorization -> 200
      const reqBearer = new Request('http://localhost:3030/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer kido_ops_secret_2026',
        },
        body: JSON.stringify({ title: 'Test' }),
      });
      const resBearer = await bridge.handleRequest(reqBearer);
      assert.equal(resBearer.status, 200);

      // 3. X-Webhook-Secret header -> 200
      const reqHeader = new Request('http://localhost:3030/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': 'kido_ops_secret_2026',
        },
        body: JSON.stringify({ title: 'Test' }),
      });
      const resHeader = await bridge.handleRequest(reqHeader);
      assert.equal(resHeader.status, 200);

      // 4. Query param token -> 200
      const reqQuery = new Request('http://localhost:3030/webhook?token=kido_ops_secret_2026', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test' }),
      });
      const resQuery = await bridge.handleRequest(reqQuery);
      assert.equal(resQuery.status, 200);
    });

    it('should reject malformed JSON with 400', async () => {
      const mockChannel = new MockChannel();
      const bridge = createAlertBridgeHandler({ channels: [mockChannel] });

      const req = new Request('http://localhost:3030/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json-content{{{',
      });
      const res = await bridge.handleRequest(req);
      assert.equal(res.status, 400);
    });

    it('should process webhook and trigger onAlert callback', async () => {
      const mockChannel = new MockChannel();
      const alertedItems: CanonicalAlert[] = [];

      const bridge = createAlertBridgeHandler({
        channels: [mockChannel],
        onAlert: (alert) => {
          alertedItems.push(alert);
        },
      });

      const kumaPayload = {
        heartbeat: { status: 0, msg: 'Bad Gateway 502', time: '2026-10-05 10:00:00' },
        monitor: { name: 'Checkout Core API', url: 'https://api.example.com/api/health' },
      };

      const req = new Request('http://localhost:3030/webhook/uptime-kuma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kumaPayload),
      });

      const res = await bridge.handleRequest(req);
      assert.equal(res.status, 200);

      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(json.success, true);
      assert.equal(json.alertsProcessed, 1);
      assert.equal(alertedItems.length, 1);
      assert.equal(alertedItems[0].service, 'Checkout Core API');
      assert.equal(mockChannel.sentAlerts.length, 1);
    });

    it('should invoke onError callback when exception happens', async () => {
      let capturedError: Error | null = null;

      const failingChannel: AlertChannel = {
        name: 'failing_channel',
        send: async () => {
          throw new Error('Connection refused by remote peer');
        },
      };

      const bridge = createAlertBridgeHandler({
        channels: [failingChannel],
        onError: (err) => {
          capturedError = err;
        },
      });

      const req = new Request('http://localhost:3030/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Crash Test' }),
      });

      const res = await bridge.handleRequest(req);
      assert.equal(res.status, 500);
      const errObj = capturedError as Error | null;
      assert.ok(errObj !== null);
      assert.equal(errObj.message, 'Connection refused by remote peer');
    });
  });
});
