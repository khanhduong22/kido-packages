import { AirwallexWebhookEvent } from './types';

function getCrypto(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('crypto');
  } catch {
    return null;
  }
}

/**
 * Verifies Airwallex webhook signature using HMAC-SHA256
 * Supports both timestamped signature (recommended by Airwallex: timestamp + payload)
 * and plain payload signature.
 *
 * @param payloadString Raw request body string
 * @param signature Hex signature from 'x-signature' header
 * @param secret Webhook signing secret from Airwallex Dashboard
 * @param timestamp Optional timestamp from 'x-timestamp' header
 */
export function verifyAirwallexWebhookSignature(
  payloadString: string,
  signature: string,
  secret: string,
  timestamp?: string
): boolean {
  if (!payloadString || !signature || !secret) {
    return false;
  }

  try {
    const nodeCrypto = getCrypto();
    if (!nodeCrypto) {
      return false;
    }

    const dataToSign = timestamp ? `${timestamp}${payloadString}` : payloadString;
    const computedSignature = nodeCrypto.createHmac('sha256', secret)
      .update(dataToSign)
      .digest('hex')
      .toLowerCase();

    const expectedBuffer = Buffer.from(computedSignature, 'utf-8');
    const providedBuffer = Buffer.from(signature.trim().toLowerCase(), 'utf-8');

    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return nodeCrypto.timingSafeEqual(expectedBuffer, providedBuffer);
  } catch {
    return false;
  }
}

export interface ParsedWebhookResult<T = any> {
  isValid: boolean;
  event: AirwallexWebhookEvent<T> | null;
  error?: string;
}

/**
 * Validates and parses an incoming Airwallex Webhook
 */
export function parseAirwallexWebhook<T = any>(
  rawPayload: string | Record<string, any>,
  signature: string,
  secret: string,
  timestamp?: string
): ParsedWebhookResult<T> {
  const payloadString =
    typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

  const isValidSig = verifyAirwallexWebhookSignature(
    payloadString,
    signature,
    secret,
    timestamp
  );

  if (!isValidSig) {
    return {
      isValid: false,
      event: null,
      error: 'Invalid Airwallex webhook signature',
    };
  }

  try {
    const event = (
      typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload
    ) as AirwallexWebhookEvent<T>;

    if (!event || typeof event !== 'object' || !event.name) {
      return {
        isValid: false,
        event: null,
        error: 'Malformed webhook payload structure (missing event name)',
      };
    }

    return {
      isValid: true,
      event,
    };
  } catch (err: any) {
    return {
      isValid: false,
      event: null,
      error: `Failed to parse webhook JSON: ${err.message}`,
    };
  }
}
