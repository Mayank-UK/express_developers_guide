import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { json, Router, type Request, type Response } from 'express';
import { appConfig } from '../../core/config/app_config.js';
import { UnauthorizedException, ValidationException } from '../../core/error_handling/exceptions.js';

/**
 * Webhook demo endpoints (the `webhooks` topic's flight simulator): this ONE
 * app plays both roles — the RECEIVER (verifies signatures, stores deliveries,
 * acknowledges fast) and the SENDER (builds a real event, signs it, delivers
 * it to our own receiver over real HTTP when a server is listening).
 *
 * The signature scheme is the industry shape (Stripe/GitHub): HMAC-SHA256,
 * hex-encoded, computed over the EXACT raw request body bytes. Getting those
 * bytes is the subtle part — see webhookJsonBodyParser below.
 *
 * Endpoints:
 * - POST /api/demo/webhooks/receive      — receiver: verify → store → 202
 * - GET  /api/demo/webhooks/deliveries   — the receiver's inbox (newest first)
 * - POST /api/demo/webhooks/send[?tamper=1] — sender: sign + deliver (+ a
 *   deliberately WRONG signature when tamper=1, so the receiver rejects 401)
 */

export const WEBHOOK_RECEIVE_PATH = '/api/demo/webhooks/receive';
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';
/** Replay window: deliveries older/newer than this many seconds are rejected. */
export const WEBHOOK_MAX_SKEW_SECONDS = 300;
/** The shared secret both demo roles use. Real secrets come from env, never code. */
export const WEBHOOK_DEMO_SECRET = 'whsec_teaching_demo';

/**
 * HMAC-SHA256 hex over the exact body bytes — the sender's whole signing
 * ceremony is this one expression. Exported so the topic (and the spec) can
 * prove the construction directly.
 */
export function signWebhookBody(body: string | Buffer, secret: string = WEBHOOK_DEMO_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Constant-time comparison of a provided hex signature against the expected digest. */
export function webhookSignatureMatches(
  rawBody: string | Buffer,
  provided: string,
  secret: string = WEBHOOK_DEMO_SECRET,
): boolean {
  const expected = Buffer.from(signWebhookBody(rawBody, secret), 'hex');
  // Invalid hex yields a short/empty buffer; length must match before compare.
  const received = Buffer.from(provided, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// --- raw body capture: the load-bearing detail --------------------------------

/**
 * The app's root body parser, with two deliberate deviations from a bare
 * express.json(): the `limit` PINNED at the default 100kb (explicit, not
 * inherited — the app-wide body budget is written down here), and the `verify`
 * hook body-parser calls with the raw buffer BEFORE parsing — the only honest
 * place to capture the bytes a signature is computed over. JSON
 * re-serialization (what you get from `JSON.stringify(req.body)`) can change
 * the bytes (key order, spacing, escaping), which silently breaks HMACs; the
 * raw buffer cannot.
 *
 * Mounted in app.ts INSTEAD of the bare express.json() that used to sit there
 * — the capture must happen before/inside parsing, once, at the root. It only
 * stores the buffer for the webhook receive path, so no other route pays for it.
 */
export const webhookJsonBodyParser = json({
  // Pinned at body-parser's 100kb default ON PURPOSE — behavior-preserving,
  // but EXPLICIT (never let a silent framework default own a security-relevant
  // budget): this is the app-wide ROOT parser (app.ts mounts it for every
  // route), and on the webhook receive path every byte under this cap is raw
  // HMAC material, so the cap also bounds signature-input size. Same
  // pin-and-comment discipline as the CSP in app.ts and multer's limits in
  // files_demo_routes.ts.
  limit: '100kb',
  verify: (req, _res, buf) => {
    const request = req as typeof req & { rawBody?: Buffer; originalUrl?: string };
    const path = (request.originalUrl ?? '').split('?')[0];
    if (request.method === 'POST' && path === WEBHOOK_RECEIVE_PATH) {
      request.rawBody = buf;
    }
  },
});

// --- the receiver's inbox (in-memory, capped — a teaching store) ---------------

export interface StoredDelivery {
  id: string;
  receivedAt: string;
  type: string;
  signatureVerified: boolean;
  payload: unknown;
}

const DELIVERY_CAP = 50;
const deliveries: StoredDelivery[] = [];

/** Test hook: specs reset the inbox so assertions stay hermetic. */
export function resetWebhookDemoStore(): void {
  deliveries.length = 0;
}

function storeDelivery(type: string, payload: unknown): StoredDelivery {
  const delivery: StoredDelivery = {
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
    type,
    signatureVerified: true, // only stored after verification passes
    payload,
  };
  // Newest first, capped — the inbox is a window, like the client request logs.
  deliveries.unshift(delivery);
  deliveries.splice(DELIVERY_CAP);
  return delivery;
}

// --- receiver -------------------------------------------------------------------

/**
 * The receiver's three obligations, in order: verify BEFORE processing,
 * acknowledge fast (202 — "accepted for processing", not "processed"), and
 * treat the payload as untrusted input until the signature says otherwise.
 */
function receiveController(req: Request, res: Response): void {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!(rawBody instanceof Buffer)) {
    // No rawBody means the verify hook never ran — i.e. the request did not
    // arrive as application/json. The signature is over bytes we never got.
    throw new ValidationException(
      'webhook receiver expects application/json (the signature is computed over the raw body bytes)',
      { reason: 'wrong_content_type' },
    );
  }

  const providedSignature = req.get(WEBHOOK_SIGNATURE_HEADER);
  if (providedSignature === undefined || providedSignature === '') {
    throw new UnauthorizedException('webhook rejected: signature header missing', {
      reason: 'missing_signature',
    });
  }
  if (!webhookSignatureMatches(rawBody, providedSignature)) {
    throw new UnauthorizedException('webhook rejected: signature did not match the raw body bytes', {
      reason: 'invalid_signature',
    });
  }

  // Replay protection: a valid signature over an OLD body is still an attack
  // (captured requests can be replayed verbatim). Freshness bounds the window.
  const rawTimestamp = req.get(WEBHOOK_TIMESTAMP_HEADER);
  const timestamp = rawTimestamp !== undefined ? Number(rawTimestamp) : Number.NaN;
  if (!Number.isFinite(timestamp) || !/^\d+$/.test(rawTimestamp ?? '')) {
    throw new UnauthorizedException(
      'webhook rejected: x-webhook-timestamp must be unix seconds',
      { reason: 'malformed_timestamp' },
    );
  }
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (skewSeconds > WEBHOOK_MAX_SKEW_SECONDS) {
    throw new UnauthorizedException(
      `webhook rejected: stale timestamp (${String(skewSeconds)}s old, window is ${String(WEBHOOK_MAX_SKEW_SECONDS)}s) — replay protection`,
      { reason: 'stale_timestamp', skewSeconds, maxSkewSeconds: WEBHOOK_MAX_SKEW_SECONDS },
    );
  }

  // Verified. Store now, process "later" (here: immediately, but the 202 below
  // is the honest contract — a real receiver queues and processes async).
  const payload: unknown = req.body;
  const type =
    typeof payload === 'object' && payload !== null && typeof (payload as { type?: unknown }).type === 'string'
      ? (payload as { type: string }).type
      : 'unknown';
  const delivery = storeDelivery(type, payload);

  res.status(202).json({
    accepted: true,
    deliveryId: delivery.id,
    receivedAt: delivery.receivedAt,
    note: 'signature verified + delivery stored; 202 Accepted means "queued", not "processed" — the receiver pattern.',
  });
}

function deliveriesController(_req: Request, res: Response): void {
  res.json({ deliveries, count: deliveries.length, cap: DELIVERY_CAP });
}

// --- sender ---------------------------------------------------------------------

const EVENT_TYPES = ['post.created', 'post.updated'] as const;
type WebhookEventType = (typeof EVENT_TYPES)[number];

/**
 * The sender's job: build the event, serialize it ONCE, sign those exact
 * bytes, and deliver them untouched. `?tamper=1` signs with the wrong secret
 * on purpose — the demo watches the receiver reject the flight with a 401.
 */
async function sendController(req: Request, res: Response): Promise<void> {
  const rawType = req.query.type;
  if (rawType !== undefined && typeof rawType !== 'string' && !Array.isArray(rawType)) {
    throw new ValidationException('"type" query parameter must be a string', { parameter: 'type' });
  }
  const requested = Array.isArray(rawType) ? rawType[0] : rawType;
  if (requested !== undefined && requested !== '' && !EVENT_TYPES.includes(requested as WebhookEventType)) {
    throw new ValidationException(`"type" must be one of: ${EVENT_TYPES.join(', ')}`, {
      parameter: 'type',
      validValues: [...EVENT_TYPES],
    });
  }
  const eventType: WebhookEventType = requested === 'post.updated' ? 'post.updated' : 'post.created';
  const tampered = req.query.tamper === '1';

  const payload = {
    id: randomUUID(),
    type: eventType,
    created: new Date().toISOString(),
    data: {
      post: {
        title: 'Webhooks are reversed APIs',
        author: 'the guide',
        ...(eventType === 'post.updated' ? { changed: ['title'] } : {}),
      },
    },
  };
  // Serialize once; THIS string is what gets signed AND delivered — the same
  // bytes on both sides is the entire trick the raw-body capture protects.
  const body = JSON.stringify(payload);
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const signature = tampered ? signWebhookBody(body, 'whsec_wrong_secret') : signWebhookBody(body);

  const url = `http://127.0.0.1:${String(appConfig.port)}${WEBHOOK_RECEIVE_PATH}`;
  const wouldDeliver = {
    url,
    method: 'POST' as const,
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      [WEBHOOK_TIMESTAMP_HEADER]: String(timestampSeconds),
    },
    body,
  };

  let delivered = false;
  let outcome: { status: number; body: string } | undefined;
  let note: string | undefined;
  try {
    // The self-call: only possible when the server is really listening (dev/
    // docker boot). Under Supertest nothing listens on appConfig.port — the
    // catch path is the graceful answer, not an error.
    const response = await fetch(url, {
      method: 'POST',
      headers: wouldDeliver.headers,
      body,
      signal: AbortSignal.timeout(1500),
    });
    delivered = true;
    outcome = { status: response.status, body: await response.text() };
  } catch {
    note =
      'receiver unreachable (no server listening in this context) — but the flight below is exactly what WOULD be delivered: same body bytes, same signature the receiver would verify.';
  }

  res.json({
    event: payload,
    signature,
    signatureAlgorithm: 'hmac-sha256, hex-encoded, over the exact request body bytes',
    tampered,
    ...(tampered && { tamperNote: 'signed with the WRONG secret on purpose — expect the receiver to answer 401' }),
    wouldDeliver,
    delivered,
    ...(outcome !== undefined && { outcome }),
    ...(note !== undefined && { note }),
  });
}

export const webhooksDemoRouter = Router();
webhooksDemoRouter.post('/demo/webhooks/receive', receiveController);
webhooksDemoRouter.get('/demo/webhooks/deliveries', deliveriesController);
webhooksDemoRouter.post('/demo/webhooks/send', sendController);
