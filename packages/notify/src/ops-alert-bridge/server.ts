import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createServer } from 'node:http';
import type {
  AlertBridgeConfig,
  AlertBridgeResult,
  AlertSource,
  CanonicalAlert,
  ChannelSendResult,
} from './types';
import { AlertTransformer } from './transformer';

function extractSourceFromUrl(urlStr: string): AlertSource | undefined {
  try {
    const url = new URL(urlStr, 'http://localhost');
    const path = url.pathname.toLowerCase();
    const querySource = url.searchParams.get('source')?.toLowerCase();

    if (querySource === 'prometheus' || querySource === 'alertmanager' || querySource === 'signoz' || querySource === 'uptime_kuma') {
      return querySource as AlertSource;
    }

    if (path.includes('uptime') || path.includes('kuma')) return 'uptime_kuma';
    if (path.includes('prom') || path.includes('alertmanager')) return 'alertmanager';
    if (path.includes('signoz')) return 'signoz';
  } catch {
    // ignore
  }
  return undefined;
}

function verifySecret(req: Request, expectedSecret?: string): boolean {
  if (!expectedSecret) return true;

  // 1. Authorization header: Bearer <secret>
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const [type, token] = authHeader.split(' ');
    if (type?.toLowerCase() === 'bearer' && token === expectedSecret) {
      return true;
    }
  }

  // 2. Custom header: X-Webhook-Secret
  const secretHeader = req.headers.get('x-webhook-secret');
  if (secretHeader && secretHeader === expectedSecret) {
    return true;
  }

  // 3. Query string parameter: ?token=<secret> or ?secret=<secret>
  try {
    const url = new URL(req.url, 'http://localhost');
    const tokenParam = url.searchParams.get('token') || url.searchParams.get('secret');
    if (tokenParam && tokenParam === expectedSecret) {
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

export interface AlertBridgeHandler {
  handleRequest(req: Request): Promise<Response>;
  handleNodeHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
  startStandaloneServer(port?: number, host?: string): Server;
}

/**
 * Creates a zero-dependency Alert Bridge handler compatible with Web Standard Request (Hono, Bun.serve, Next.js),
 * Node.js http (Express, Fastify), and standalone HTTP server.
 */
export function createAlertBridgeHandler(config: AlertBridgeConfig): AlertBridgeHandler {
  const handleRequest = async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!verifySecret(req, config.secret)) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Invalid or missing webhook secret' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let rawPayload: unknown;
    try {
      rawPayload = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body in request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const sourceHint = extractSourceFromUrl(req.url) || config.defaultSource;
      const alerts: CanonicalAlert[] = AlertTransformer.transform(rawPayload, sourceHint);

      if (alerts.length === 0) {
        return new Response(JSON.stringify({ success: true, alertsProcessed: 0, results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Execute onAlert callback if provided
      if (config.onAlert) {
        for (const alert of alerts) {
          await config.onAlert(alert);
        }
      }

      // Dispatch concurrently to all configured channels
      const channelPromises = (config.channels || []).map((channel) => channel.send(alerts));
      const channelResultsNested = await Promise.all(channelPromises);
      const flatResults: ChannelSendResult[] = channelResultsNested.flat();

      const bridgeResult: AlertBridgeResult = {
        success: flatResults.every((r) => r.success),
        alertsProcessed: alerts.length,
        results: flatResults,
        alerts,
      };

      return new Response(JSON.stringify(bridgeResult), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (config.onError) {
        config.onError(error, rawPayload);
      }

      return new Response(JSON.stringify({ error: 'Internal Bridge Error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };

  const handleNodeHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Read request body from stream
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost';
    const fullUrl = `${protocol}://${host}${req.url || '/'}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
    }

    const webReq = new Request(fullUrl, {
      method: req.method || 'GET',
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuffer : undefined,
    });

    const webRes = await handleRequest(webReq);

    res.statusCode = webRes.status;
    for (const [headerKey, headerVal] of webRes.headers.entries()) {
      res.setHeader(headerKey, headerVal);
    }

    const resBody = await webRes.text();
    res.end(resBody);
  };

  const startStandaloneServer = (port = 3030, host = '0.0.0.0'): Server => {
    const server = createServer(async (req, res) => {
      try {
        await handleNodeHttp(req, res);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server Handler Failed', details: String(err) }));
      }
    });

    server.listen(port, host);
    return server;
  };

  return {
    handleRequest,
    handleNodeHttp,
    startStandaloneServer,
  };
}

/**
 * Starts a standalone HTTP webhook server for the Alert Bridge.
 */
export function startStandaloneServer(
  config: AlertBridgeConfig,
  port = 3030,
  host = '0.0.0.0'
): Server {
  return createAlertBridgeHandler(config).startStandaloneServer(port, host);
}

