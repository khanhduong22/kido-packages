import webpush, { WebPushError } from 'web-push';
import {
  VapidConfig,
  VapidKeys,
  WebPushOptions,
  WebPushPayload,
  WebPushSendResult,
  WebPushSubscription,
} from './types';

export { WebPushError };

/**
 * Generates a URL-safe, base64-encoded VAPID public and private key pair.
 */
export function generateVAPIDKeys(): VapidKeys {
  return webpush.generateVAPIDKeys();
}

/**
 * Sends a Web Push notification to a target subscription using VAPID.
 * 
 * Safely catches push service errors (like 410 Gone / 404 Not Found)
 * and returns `isExpired: true` so the caller can clean up the inactive subscription from the database.
 */
export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: WebPushPayload | string,
  vapid: VapidConfig,
  options?: WebPushOptions
): Promise<WebPushSendResult> {
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return {
      success: false,
      isExpired: false,
      error: 'Invalid push subscription: endpoint and keys (p256dh, auth) are required',
    };
  }

  if (!vapid || !vapid.subject || !vapid.publicKey || !vapid.privateKey) {
    return {
      success: false,
      isExpired: false,
      error: 'VAPID credentials missing: subject, publicKey, and privateKey are required',
    };
  }

  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);

  try {
    const res = await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
      },
      payloadString,
      {
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        ...options,
      }
    );

    return {
      success: true,
      statusCode: res.statusCode,
      isExpired: false,
    };
  } catch (err: unknown) {
    const errorObj = err as { statusCode?: number; status?: number; message?: string };
    const statusCode = errorObj.statusCode ?? errorObj.status;
    const isExpired = statusCode === 410 || statusCode === 404;
    const errorMessage = err instanceof Error ? err.message : String(err);

    return {
      success: false,
      statusCode: typeof statusCode === 'number' ? statusCode : undefined,
      isExpired,
      error: errorMessage,
    };
  }
}

/**
 * High-level Web Push Notifier Client pre-configured with VAPID credentials
 */
export class WebPushNotifier {
  private vapid: VapidConfig;

  constructor(vapid: VapidConfig) {
    this.vapid = vapid;
  }

  /**
   * Send notification to a push subscriber
   */
  async send(
    subscription: WebPushSubscription,
    payload: WebPushPayload | string,
    options?: WebPushOptions
  ): Promise<WebPushSendResult> {
    return sendWebPush(subscription, payload, this.vapid, options);
  }
}

/**
 * Factory function to create a pre-configured WebPushNotifier
 */
export function createWebPushNotifier(vapid: VapidConfig): WebPushNotifier {
  return new WebPushNotifier(vapid);
}
