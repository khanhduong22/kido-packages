import type {
  AlertSeverity,
  AlertSource,
  AlertStatus,
  CanonicalAlert,
} from './types';

function generateAlertId(prefix = 'alert'): string {
  const timestamp = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${rand}`;
}

export function normalizeStatus(val: unknown): AlertStatus {
  if (typeof val === 'number') {
    return val === 1 ? 'resolved' : 'firing';
  }

  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (['resolved', 'ok', 'up', 'recovered', 'healthy', 'success', 'cleared'].includes(s)) {
      return 'resolved';
    }
  }

  return 'firing';
}

export function normalizeSeverity(val: unknown, status?: AlertStatus): AlertSeverity {
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (['critical', 'fatal', 'error', 'page', 'high', 'p1', 'p0'].includes(s)) {
      return 'critical';
    }
    if (['warning', 'warn', 'medium', 'p2', 'p3'].includes(s)) {
      return 'warning';
    }
    if (['info', 'informational', 'low', 'p4', 'notice'].includes(s)) {
      return 'info';
    }
  }

  return status === 'resolved' ? 'info' : 'critical';
}

export function detectAlertSource(payload: unknown): AlertSource {
  if (!payload || typeof payload !== 'object') {
    return 'generic';
  }

  const p = payload as Record<string, unknown>;

  // 1. Uptime Kuma (has heartbeat and monitor)
  if (p.heartbeat !== undefined && p.monitor !== undefined) {
    return 'uptime_kuma';
  }

  // 2. AlertManager / Prometheus (has alerts array with labels and annotations)
  if (Array.isArray(p.alerts) && p.alerts.length > 0) {
    const first = p.alerts[0];
    if (typeof first === 'object' && first !== null) {
      if ('labels' in first || 'annotations' in first) {
        return 'alertmanager';
      }
    }
  }

  // 3. SigNoz (either alertName & state, or signoz in ruleUrl)
  if (
    (typeof p.alertName === 'string' && typeof p.state === 'string') ||
    (typeof p.ruleUrl === 'string' && p.ruleUrl.includes('signoz'))
  ) {
    return 'signoz';
  }

  return 'generic';
}

export class AlertTransformer {
  /**
   * Transforms heterogeneous monitoring webhook payloads (Prometheus, AlertManager,
   * SigNoz, Uptime Kuma, or Generic) into a standardized array of CanonicalAlert objects.
   */
  public static transform(payload: unknown, sourceHint?: AlertSource): CanonicalAlert[] {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const source = sourceHint || detectAlertSource(payload);
    const p = payload as Record<string, unknown>;

    switch (source) {
      case 'uptime_kuma':
        return AlertTransformer.transformUptimeKuma(p);
      case 'alertmanager':
      case 'prometheus':
        return AlertTransformer.transformAlertManager(p, source);
      case 'signoz':
        return AlertTransformer.transformSigNoz(p);
      case 'generic':
      default:
        return AlertTransformer.transformGeneric(p);
    }
  }

  private static transformUptimeKuma(p: Record<string, unknown>): CanonicalAlert[] {
    const heartbeat = (p.heartbeat || {}) as Record<string, unknown>;
    const monitor = (p.monitor || {}) as Record<string, unknown>;

    // 0 = DOWN (firing), 1 = UP (resolved), 2 = PENDING
    const isUp = heartbeat.status === 1;
    const status: AlertStatus = isUp ? 'resolved' : 'firing';
    const severity: AlertSeverity = isUp ? 'info' : 'critical';

    const monitorName = String(monitor.name || 'Uptime Monitor');
    const monitorUrl = monitor.url ? String(monitor.url) : undefined;
    const errorMsg = heartbeat.msg ? String(heartbeat.msg) : (p.msg ? String(p.msg) : '');
    const pingTime = heartbeat.ping !== undefined && heartbeat.ping !== null ? `${heartbeat.ping}ms` : undefined;

    const startsAt = heartbeat.time ? new Date(String(heartbeat.time)).toISOString() : new Date().toISOString();

    const title = isUp
      ? `✅ Service Recovered: ${monitorName}`
      : `🔴 Service Outage: ${monitorName}`;

    const summary = isUp
      ? `Monitor '${monitorName}' is back online${pingTime ? ` (ping: ${pingTime})` : ''}.`
      : `Monitor '${monitorName}' is DOWN. Error: ${errorMsg || 'No response'}`;

    const alert: CanonicalAlert = {
      id: generateAlertId('kuma'),
      status,
      severity,
      title,
      summary,
      description: errorMsg,
      service: monitorName,
      source: 'uptime_kuma',
      startsAt,
      labels: {
        monitor_id: String(monitor.id || ''),
        monitor_type: String(monitor.type || 'http'),
        ...(pingTime ? { ping: pingTime } : {}),
      },
      annotations: {
        error: errorMsg,
      },
      url: monitorUrl,
    };

    return [alert];
  }

  private static transformAlertManager(
    p: Record<string, unknown>,
    source: AlertSource
  ): CanonicalAlert[] {
    const rawAlerts = Array.isArray(p.alerts) ? p.alerts : [];
    if (rawAlerts.length === 0) {
      // AlertManager root firing/resolved notification without alert items
      const globalStatus = normalizeStatus(p.status);
      return [
        {
          id: generateAlertId('prom'),
          status: globalStatus,
          severity: normalizeSeverity(p.severity, globalStatus),
          title: `AlertManager Notification (${globalStatus.toUpperCase()})`,
          summary: String(p.commonAnnotations ? (p.commonAnnotations as Record<string, unknown>).summary || '' : 'No summary'),
          source,
          startsAt: new Date().toISOString(),
          labels: (p.commonLabels as Record<string, string>) || {},
          annotations: (p.commonAnnotations as Record<string, string>) || {},
        },
      ];
    }

    return rawAlerts.map((item) => {
      const a = (item || {}) as Record<string, unknown>;
      const labels = (a.labels || {}) as Record<string, string>;
      const annotations = (a.annotations || {}) as Record<string, string>;

      const alertStatus = normalizeStatus(a.status || p.status);
      const alertSeverity = normalizeSeverity(labels.severity || a.severity, alertStatus);

      const alertName = labels.alertname || labels.alert_name || 'PrometheusAlert';
      const service = labels.service || labels.job || labels.instance || 'infra';
      const summary = annotations.summary || annotations.message || `${alertName} is ${alertStatus}`;
      const description = annotations.description || annotations.runbook_url || '';
      const startsAt = a.startsAt ? String(a.startsAt) : new Date().toISOString();
      const endsAt = a.endsAt && String(a.endsAt) !== '0001-01-01T00:00:00Z' ? String(a.endsAt) : undefined;
      const generatorUrl = a.generatorURL ? String(a.generatorURL) : undefined;

      const title = alertStatus === 'firing'
        ? `🔴 [FIRING] ${alertName} (${service})`
        : `✅ [RESOLVED] ${alertName} (${service})`;

      return {
        id: generateAlertId('prom'),
        status: alertStatus,
        severity: alertSeverity,
        title,
        summary,
        description,
        service,
        source,
        startsAt,
        endsAt,
        labels,
        annotations,
        url: generatorUrl,
      };
    });
  }

  private static transformSigNoz(p: Record<string, unknown>): CanonicalAlert[] {
    // SigNoz may have alerts array (Alertmanager format) or direct object
    if (Array.isArray(p.alerts)) {
      return AlertTransformer.transformAlertManager(p, 'signoz');
    }

    const state = String(p.state || p.status || 'FIRING');
    const status = normalizeStatus(state);
    const severity = normalizeSeverity(p.severity, status);

    const alertName = String(p.alertName || p.ruleName || 'SigNoz Alert');
    const service = (p.labels as Record<string, string>)?.service || String(p.service || 'service');
    const description = String(p.description || p.message || '');
    const summary = String(p.summary || description || `${alertName} in ${state}`);
    const startsAt = p.startsAt ? String(p.startsAt) : new Date().toISOString();
    const url = p.ruleUrl ? String(p.ruleUrl) : undefined;

    const title = status === 'firing'
      ? `🔴 [SIGNOZ] ${alertName} (${service})`
      : `✅ [SIGNOZ RESOLVED] ${alertName} (${service})`;

    return [
      {
        id: generateAlertId('signoz'),
        status,
        severity,
        title,
        summary,
        description,
        service,
        source: 'signoz',
        startsAt,
        labels: (p.labels as Record<string, string>) || {},
        annotations: (p.annotations as Record<string, string>) || {},
        url,
      },
    ];
  }

  private static transformGeneric(p: Record<string, unknown>): CanonicalAlert[] {
    const status = normalizeStatus(p.status || p.state);
    const severity = normalizeSeverity(p.severity || p.level, status);
    const title = String(p.title || p.name || 'Ops Webhook Alert');
    const summary = String(p.summary || p.message || p.msg || title);
    const description = p.description ? String(p.description) : undefined;
    const service = p.service ? String(p.service) : undefined;
    const url = p.url ? String(p.url) : undefined;
    const startsAt = p.timestamp ? String(p.timestamp) : new Date().toISOString();

    return [
      {
        id: generateAlertId('gen'),
        status,
        severity,
        title: status === 'firing' ? `🔴 ${title}` : `✅ ${title}`,
        summary,
        description,
        service,
        source: 'generic',
        startsAt,
        labels: (p.labels as Record<string, string>) || {},
        annotations: (p.annotations as Record<string, string>) || {},
        url,
      },
    ];
  }
}
