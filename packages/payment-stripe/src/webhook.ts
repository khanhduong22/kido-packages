import * as crypto from 'node:crypto';
import type {
  IdempotencyStore,
  StripeEventType,
  StripeStandardEventType,
  StripeWebhookEvent,
  WebhookDispatchResult,
  WebhookHandlerFn,
  WebhookVerificationOptions,
} from './types';

/**
 * Custom error thrown when Stripe webhook signature verification fails.
 */
export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

/**
 * In-memory store for Webhook Event Idempotency.
 * Default TTL is 24 hours (86,400 seconds).
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly events = new Map<string, number>();

  public has(eventId: string): boolean {
    const expiresAt = this.events.get(eventId);
    if (!expiresAt) {
      return false;
    }
    if (Date.now() > expiresAt) {
      this.events.delete(eventId);
      return false;
    }
    return true;
  }

  public set(eventId: string, ttlSeconds = 86400): void {
    this.events.set(eventId, Date.now() + ttlSeconds * 1000);
  }

  public delete(eventId: string): void {
    this.events.delete(eventId);
  }

  public clear(): void {
    this.events.clear();
  }

  public pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, expiresAt] of this.events.entries()) {
      if (now > expiresAt) {
        this.events.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}

/**
 * Parses Stripe-Signature header into timestamp and v1 signature hashes.
 * Format: "t=1614555845,v1=5257a8...,v1=...,v0=..."
 */
export function parseStripeSignatureHeader(header: string): {
  timestamp: number;
  signatures: string[];
} {
  if (!header || typeof header !== 'string') {
    throw new WebhookSignatureError('Missing or empty Stripe-Signature header');
  }

  const parts = header.split(',');
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, ...valueParts] = part.trim().split('=');
    const value = valueParts.join('=');

    if (key === 't') {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        timestamp = parsed;
      }
    } else if (key === 'v1' && value) {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) {
    throw new WebhookSignatureError(
      'Unable to extract timestamp (t) or v1 signature from header'
    );
  }

  return { timestamp, signatures };
}

/**
 * Computes the expected HMAC-SHA256 signature for Stripe webhook payload.
 */
export function computeStripeSignature(
  payload: string | Buffer,
  secret: string,
  timestamp: number
): string {
  const rawBody = typeof payload === 'string' ? payload : payload.toString('utf8');
  const signedPayload = `${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
}

/**
 * Verifies the Stripe webhook signature against secret, tolerance window, and timing-safe equality.
 * Throws WebhookSignatureError on failure.
 * Returns parsed StripeWebhookEvent on success.
 */
export function verifyStripeWebhook<T = any>(
  rawPayload: string | Buffer,
  signatureHeader: string,
  secret: string,
  options: WebhookVerificationOptions = {}
): StripeWebhookEvent<T> {
  const {
    toleranceInSeconds = 300, // 5 minutes default tolerance
    enforceTolerance = true,
    referenceTime = Math.floor(Date.now() / 1000),
  } = options;

  if (!secret) {
    throw new WebhookSignatureError('Webhook signing secret is required');
  }

  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);

  // 1. Tolerance window check (Replay Attack defense)
  if (enforceTolerance) {
    const age = Math.abs(referenceTime - timestamp);
    if (age > toleranceInSeconds) {
      throw new WebhookSignatureError(
        `Webhook timestamp outside tolerance window (tolerance: ${toleranceInSeconds}s, age: ${age}s)`
      );
    }
  }

  // 2. Compute expected HMAC-SHA256 signature
  const expectedSignatureHex = computeStripeSignature(rawPayload, secret, timestamp);
  const expectedBuffer = Buffer.from(expectedSignatureHex, 'hex');

  // 3. Timing-safe equality comparison against all v1 signatures provided
  let isValid = false;
  for (const candidateHex of signatures) {
    const candidateBuffer = Buffer.from(candidateHex, 'hex');
    if (
      candidateBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, candidateBuffer)
    ) {
      isValid = true;
      break;
    }
  }

  if (!isValid) {
    throw new WebhookSignatureError('Signature verification failed: no matching v1 signature');
  }

  // 4. Parse payload to JSON
  try {
    const payloadStr = typeof rawPayload === 'string' ? rawPayload : rawPayload.toString('utf8');
    return JSON.parse(payloadStr) as StripeWebhookEvent<T>;
  } catch (err: any) {
    throw new WebhookSignatureError(`Invalid JSON payload: ${err.message}`);
  }
}

/**
 * Stripe Webhook Router with Event-Driven Dispatch & Built-in Idempotency.
 */
export class StripeWebhookRouter {
  private readonly handlers = new Map<string, WebhookHandlerFn[]>();
  private readonly anyHandlers: WebhookHandlerFn[] = [];
  private readonly idempotencyStore: IdempotencyStore;
  private readonly defaultSecret?: string;
  private readonly defaultTolerance: number;

  constructor(options?: {
    secret?: string;
    toleranceInSeconds?: number;
    idempotencyStore?: IdempotencyStore;
  }) {
    this.defaultSecret = options?.secret;
    this.defaultTolerance = options?.toleranceInSeconds ?? 300;
    this.idempotencyStore = options?.idempotencyStore ?? new InMemoryIdempotencyStore();
  }

  /**
   * Register a handler for a specific Stripe event type.
   */
  public on<T = any>(
    eventType: StripeEventType,
    handler: WebhookHandlerFn<T>
  ): this {
    const existing = this.handlers.get(eventType) || [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
    return this;
  }

  /**
   * Convenience helpers for core subscription events.
   */
  public onCheckoutSessionCompleted<T = any>(handler: WebhookHandlerFn<T>): this {
    return this.on('checkout.session.completed', handler);
  }

  public onSubscriptionCreated<T = any>(handler: WebhookHandlerFn<T>): this {
    return this.on('customer.subscription.created', handler);
  }

  public onSubscriptionUpdated<T = any>(handler: WebhookHandlerFn<T>): this {
    return this.on('customer.subscription.updated', handler);
  }

  public onSubscriptionDeleted<T = any>(handler: WebhookHandlerFn<T>): this {
    return this.on('customer.subscription.deleted', handler);
  }

  public onInvoicePaid<T = any>(handler: WebhookHandlerFn<T>): this {
    return this.on('invoice.paid', handler);
  }

  public onInvoicePaymentFailed<T = any>(handler: WebhookHandlerFn<T>): this {
    return this.on('invoice.payment_failed', handler);
  }

  /**
   * Register a catch-all handler for all received webhook events.
   */
  public onAny<T = any>(handler: WebhookHandlerFn<T>): this {
    this.anyHandlers.push(handler);
    return this;
  }

  /**
   * Dispatches a verified Stripe webhook event or verifies signature first from raw payload and headers.
   */
  public async handleWebhook(
    rawPayload: string | Buffer,
    signatureHeader: string,
    secret?: string,
    verificationOptions?: WebhookVerificationOptions
  ): Promise<WebhookDispatchResult> {
    const signingSecret = secret || this.defaultSecret;
    if (!signingSecret) {
      throw new WebhookSignatureError('No webhook signing secret provided');
    }

    const event = verifyStripeWebhook(rawPayload, signatureHeader, signingSecret, {
      toleranceInSeconds: this.defaultTolerance,
      ...verificationOptions,
    });

    return this.dispatchEvent(event);
  }

  /**
   * Dispatches an already verified or constructed event with idempotency check.
   */
  public async dispatchEvent<T = any>(
    event: StripeWebhookEvent<T>
  ): Promise<WebhookDispatchResult<T>> {
    const eventId = event.id;
    const eventType = event.type;

    // 1. Idempotency guard check
    const isDuplicate = await this.idempotencyStore.has(eventId);
    if (isDuplicate) {
      return {
        eventId,
        eventType,
        duplicate: true,
        handled: false,
        handlerResults: [],
        event,
      };
    }

    // 2. Mark event as processed in idempotency store
    await this.idempotencyStore.set(eventId);

    // 3. Dispatch to matching handlers
    const specificHandlers = this.handlers.get(eventType) || [];
    const allHandlers = [...specificHandlers, ...this.anyHandlers];

    const handlerResults: any[] = [];
    for (const handler of allHandlers) {
      const res = await handler(event);
      handlerResults.push(res);
    }

    return {
      eventId,
      eventType,
      duplicate: false,
      handled: allHandlers.length > 0,
      handlerResults,
      event,
    };
  }

  public getIdempotencyStore(): IdempotencyStore {
    return this.idempotencyStore;
  }
}
