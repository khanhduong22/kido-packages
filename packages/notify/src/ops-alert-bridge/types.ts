export type AlertStatus = 'firing' | 'resolved';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertSource =
  | 'prometheus'
  | 'alertmanager'
  | 'signoz'
  | 'uptime_kuma'
  | 'generic';

export interface CanonicalAlert {
  id: string;
  status: AlertStatus;
  severity: AlertSeverity;
  title: string;
  summary: string;
  description?: string;
  service?: string;
  source: AlertSource;
  startsAt: string;
  endsAt?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  url?: string;
}

export interface ChannelSendResult {
  channel: string;
  success: boolean;
  alertId?: string;
  statusCode?: number;
  error?: string;
}

export interface AlertChannel {
  readonly name: string;
  send(alerts: CanonicalAlert[]): Promise<ChannelSendResult[]>;
}

export interface BaseChannelOptions {
  timeoutMs?: number;
  retries?: number;
  customFetch?: typeof fetch;
}

export interface TelegramChannelOptions extends BaseChannelOptions {
  botToken: string;
  chatId: string | number;
  messageThreadId?: number;
  parseMode?: 'HTML' | 'MarkdownV2';
  disableWebPagePreview?: boolean;
  headerPrefix?: string;
}

export interface DiscordChannelOptions extends BaseChannelOptions {
  webhookUrl: string;
  username?: string;
  avatarUrl?: string;
}

export interface SlackChannelOptions extends BaseChannelOptions {
  webhookUrl: string;
  username?: string;
  iconEmoji?: string;
  channel?: string;
}

export interface AlertBridgeConfig {
  secret?: string;
  channels: AlertChannel[];
  defaultSource?: AlertSource;
  onAlert?: (alert: CanonicalAlert) => void | Promise<void>;
  onError?: (error: Error, rawPayload: unknown) => void;
}

export interface AlertBridgeResult {
  success: boolean;
  alertsProcessed: number;
  results: ChannelSendResult[];
  alerts: CanonicalAlert[];
}
