import { createHmac, timingSafeEqual } from 'node:crypto';
import { raw, Router, type Request, type Response } from 'express';
import { failureToException, NotFoundException, UnauthorizedException, ValidationException } from '../../core/error_handling/exceptions.js';
import { getContainer } from '../../di/container.js';
// Deliberate teaching exception (the dependency rule is presentation → domain
// ← data; same note as db_demo_routes.ts): the presigned-upload exhibit writes
// through the REAL files store, so the storage integration itself is the
// artifact being taught.
import {
  fileStore,
  sanitizeDisplayName,
  STORED_EXTENSIONS,
  type StoredFileMetadata,
} from '../../data/files/file_store.js';

/**
 * Third-party services demo endpoints (the `third-party` topic's live
 * surface) — three integrations at three levels of realness, each labeled
 * honestly:
 *
 * EMAIL — REAL adapter, real dependency: nodemailer's jsonTransport runs the
 * full message pipeline and captures the result as JSON. Nothing leaves the
 * machine (no SMTP host is configured anywhere — that is the point of the
 * transport choice). The service lives in domain/email and is wired through
 * the container, because it is the one integration here a real app runs
 * unchanged in dev (jsonTransport) and prod (SMTP/SES) alike.
 *
 * PAYMENTS — a MOCK that mirrors Stripe's SHAPES (PaymentIntent, client
 * secret, status ladder, decline codes) with zero money paths. Every response
 * carries `mock: true`. Stripe itself is a catalog mention in the content:
 * adding the SDK for a demo that cannot run without API keys would bloat the
 * install for nothing — the shapes are the teaching.
 *
 * STORAGE — a REAL signing flow over the REAL files store: presign issues an
 * HMAC-signed, expiry-bound token (the webhooks topic's signing ceremony
 * reused), and the upload endpoint verifies it and writes the raw body
 * through the file store's containment-guarded API. Only the bucket is
 * imaginary — the content says so.
 *
 * Mounted under /api by src/app.ts (the sibling demo routers' convention):
 * the routers register /demo/email|payments|storage/…, the full paths are
 * /api/demo/email|payments|storage/….
 */

export const THIRD_PARTY_DEMO_MOUNT_PATH = '/api/demo';

// ============================================================================
// EMAIL — the real adapter behind the container
// ============================================================================

async function emailSendController(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await getContainer().emailService.send({
    to: typeof body.to === 'string' ? body.to : '',
    subject: typeof body.subject === 'string' ? body.subject : '',
    text: typeof body.text === 'string' ? body.text : '',
    ...(typeof body.html === 'string' && { html: body.html }),
  });
  if (!result.ok) throw failureToException(result.error);

  res.status(201).json({
    ...result.value,
    outboxCount: getContainer().emailService.listOutbox().length,
    transport: 'jsonTransport',
    note: 'captured by jsonTransport — no network, no account. Swap the one createTransport() call for SMTP and this endpoint is production-shaped.',
  });
}

function emailOutboxController(_req: Request, res: Response): void {
  const outbox = getContainer().emailService.listOutbox();
  res.json({
    outbox,
    count: outbox.length,
    transport: 'jsonTransport',
    note: 'every "sent" message is the JSON nodemailer produced — address parsing, headers, messageId and all. The bytes it would have put on the wire are right here.',
  });
}

// ============================================================================
// PAYMENTS — the Stripe-shaped MOCK (no money paths anywhere)
// ============================================================================

/**
 * PaymentIntent statuses — Stripe's actual ladder. The mock walks exactly
 * these three; a real integration also meets `processing` and `canceled`.
 */
export type MockPaymentStatus = 'requires_confirmation' | 'succeeded' | 'requires_payment_method';

export interface MockPaymentIntent {
  id: string;
  amountCents: number;
  currency: string;
  clientSecret: string;
  status: MockPaymentStatus;
  created: string;
  /** Set on decline — mirrors Stripe's last_payment_error. */
  lastPaymentError?: { code: string; decline_code: string; message: string };
  /** Set on success — mirrors Stripe's latest_charge (expanded). */
  latestCharge?: { id: string; receiptId: string; capturedAt: string };
}

const PAYMENT_INTENT_CAP = 100;
const MIN_AMOUNT_CENTS = 50; // Stripe's own floor for most currencies
const MAX_AMOUNT_CENTS = 10_000_00;
const paymentIntents = new Map<string, MockPaymentIntent>();
let paymentSeq = 0;

/** Test hook: specs reset the mock store so assertions stay hermetic. */
export function resetThirdPartyDemoStores(): void {
  paymentIntents.clear();
  paymentSeq = 0;
}

const MOCK_PAYMENT_NOTE =
  'MOCK — the shapes mirror Stripe (PaymentIntent, client_secret, status ladder, decline codes) but no money moves and no SDK is installed; the real create-intent + webhook flow is sketched in the topic content.';

function intentResponse(intent: MockPaymentIntent): MockPaymentIntent & Record<string, unknown> {
  return { ...intent, mock: true, note: MOCK_PAYMENT_NOTE };
}

function paymentsIntentController(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const amountCents = body.amountCents;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    throw new ValidationException(
      `"amountCents" must be a whole number of cents between ${String(MIN_AMOUNT_CENTS)} and ${String(MAX_AMOUNT_CENTS)}`,
      { parameter: 'amountCents', received: amountCents, validRange: [MIN_AMOUNT_CENTS, MAX_AMOUNT_CENTS] },
    );
  }
  const currencyRaw = typeof body.currency === 'string' && body.currency !== '' ? body.currency.toLowerCase() : 'usd';
  if (!/^[a-z]{3}$/.test(currencyRaw)) {
    throw new ValidationException('"currency" must be a three-letter ISO code (e.g. "usd")', {
      parameter: 'currency',
      received: body.currency,
    });
  }

  paymentSeq += 1;
  const id = `pi_mock_${String(paymentSeq).padStart(4, '0')}`;
  const intent: MockPaymentIntent = {
    id,
    amountCents,
    currency: currencyRaw,
    clientSecret: `${id}_secret_demo`,
    status: 'requires_confirmation',
    created: new Date().toISOString(),
  };
  paymentIntents.set(id, intent);
  // Cap enforcement: evict the OLDEST beyond the cap (insertion order).
  while (paymentIntents.size > PAYMENT_INTENT_CAP) {
    const oldest = paymentIntents.keys().next().value;
    if (oldest === undefined) break;
    paymentIntents.delete(oldest);
  }

  res.status(201).json({
    ...intentResponse(intent),
    testCards: [
      { number: '4242 4242 4242 4242', outcome: 'succeeds' },
      { number: 'declined', outcome: 'card_declined — status returns to requires_payment_method' },
    ],
  });
}

function requireIntent(id: unknown): MockPaymentIntent {
  if (typeof id !== 'string' || id === '') {
    throw new ValidationException('"paymentIntentId" is required', { parameter: 'paymentIntentId' });
  }
  const intent = paymentIntents.get(id);
  if (intent === undefined) {
    throw new NotFoundException(`no payment intent with id "${id}"`, { paymentIntentId: id });
  }
  return intent;
}

function paymentsConfirmController(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const intent = requireIntent(body.paymentIntentId);
  const card = body.card;

  if (intent.status === 'succeeded') {
    throw new ValidationException(
      'this intent already succeeded — confirming twice would double-charge; real Stripe rejects it and so does the mock',
      { paymentIntentId: intent.id, status: intent.status },
    );
  }
  if (typeof card !== 'string' || card === '') {
    throw new ValidationException('"card" is required — the test card to confirm with', {
      parameter: 'card',
      hint: 'any string starting "4242" succeeds; "declined" declines (the real test cards are in the content)',
    });
  }

  if (card.startsWith('4242')) {
    // The success path: status flips to succeeded and a charge object lands on
    // the intent — the shapes a webhook (payment_intent.succeeded) delivers.
    intent.status = 'succeeded';
    delete intent.lastPaymentError;
    const receiptId = `rcpt_mock_${intent.id.slice('pi_mock_'.length)}`;
    intent.latestCharge = {
      id: `ch_mock_${intent.id.slice('pi_mock_'.length)}`,
      receiptId,
      capturedAt: new Date().toISOString(),
    };
    res.json({
      paymentIntent: intentResponse(intent),
      receipt: { id: receiptId, at: intent.latestCharge.capturedAt },
      mock: true,
      note: `${MOCK_PAYMENT_NOTE} In the real flow the client confirms with the clientSecret via Stripe.js — the SERVER learns "succeeded" from the webhook, never from the client's redirect.`,
    });
    return;
  }

  if (card === 'declined') {
    // The decline path: status FALLS BACK to requires_payment_method (the
    // customer keeps their place in the flow) and last_payment_error carries
    // Stripe's code + decline_code — exactly the fields you inspect to decide
    // whether to retry, re-collect, or give up.
    intent.status = 'requires_payment_method';
    intent.lastPaymentError = {
      code: 'card_declined',
      decline_code: 'generic_decline',
      message: 'Your card was declined.',
    };
    res.json({
      paymentIntent: intentResponse(intent),
      declineCode: 'card_declined',
      mock: true,
      note: `${MOCK_PAYMENT_NOTE} Real Stripe puts code "card_declined" + decline_code "generic_decline" on last_payment_error — the mock mirrors the field names so your error handling can be written against the truth.`,
    });
    return;
  }

  throw new ValidationException('"card" must be a 4242… test card or "declined" — this mock has no other outcomes', {
    parameter: 'card',
    received: card,
  });
}

function paymentsStatusController(req: Request, res: Response): void {
  const intent = requireIntent(req.params.id);
  res.json(intentResponse(intent));
}

// ============================================================================
// STORAGE — a real presign ceremony over the real files store
// ============================================================================

/**
 * Presigned-URL semantics, miniature: a short-lived token that authorizes ONE
 * upload of ONE filename at ONE content type until ONE expiry. The signing is
 * the webhooks topic's ceremony — HMAC-SHA256 over a canonical string — now
 * used in the AUTHORIZE direction (grant, not verify): the same crypto, the
 * opposite direction of trust.
 */
export const PRESIGN_DEMO_SECRET = 'presign_teaching_demo'; // real secrets come from env, never code
/** How long a presigned upload URL stays valid — short, because it is a grant. */
export const PRESIGN_EXPIRES_IN_SECONDS = 300;
/** Same size ceiling the files topic's multer upload enforces. */
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The files topic's allowlist, DERIVED from the store's MIME→extension map —
 * one upload policy in one place (the store), so the two topics cannot drift.
 */
const ALLOWED_UPLOAD_MIME_TYPES: readonly string[] = Object.keys(STORED_EXTENSIONS);

export interface PresignPayload {
  filename: string;
  contentType: string;
  expiresAtMs: number;
}

/** Canonical string the HMAC covers — every granted field is a verified field. */
function presignCanonical(payload: PresignPayload): string {
  return `${payload.filename}|${payload.contentType}|${String(payload.expiresAtMs)}`;
}

/** Sign a presign grant. Exported so the spec can craft expired tokens directly. */
export function signPresignToken(payload: PresignPayload, secret: string = PRESIGN_DEMO_SECRET): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(presignCanonical(payload)).digest('hex');
  return `${body}.${signature}`;
}

export type PresignVerification =
  | { ok: true; payload: PresignPayload }
  | { ok: false; reason: 'malformed_token' | 'invalid_signature' | 'expired'; expiresAtMs?: number };

/** Verify a presign grant: structure → signature (constant-time) → expiry. */
export function verifyPresignToken(token: string, nowMs: number = Date.now(), secret: string = PRESIGN_DEMO_SECRET): PresignVerification {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { ok: false, reason: 'malformed_token' };
  }
  let payload: PresignPayload;
  try {
    const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded !== 'object' || decoded === null ||
      typeof (decoded as PresignPayload).filename !== 'string' ||
      typeof (decoded as PresignPayload).contentType !== 'string' ||
      typeof (decoded as PresignPayload).expiresAtMs !== 'number'
    ) {
      return { ok: false, reason: 'malformed_token' };
    }
    payload = decoded as PresignPayload;
  } catch {
    return { ok: false, reason: 'malformed_token' };
  }

  const expected = Buffer.from(
    createHmac('sha256', secret).update(presignCanonical(payload)).digest('hex'),
    'hex',
  );
  const received = Buffer.from(parts[1], 'hex');
  // Invalid hex yields a wrong-length buffer; length must match before compare.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (nowMs >= payload.expiresAtMs) {
    return { ok: false, reason: 'expired', expiresAtMs: payload.expiresAtMs };
  }
  return { ok: true, payload };
}

function storagePresignController(req: Request, res: Response): void {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filename = body.filename;
  const contentType = body.contentType;

  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new ValidationException('"filename" is required (the display name the stored file keeps)', {
      parameter: 'filename',
    });
  }
  if (typeof contentType !== 'string' || !ALLOWED_UPLOAD_MIME_TYPES.includes(contentType)) {
    throw new ValidationException(`"contentType" must be one of the files topic's allowlist: ${ALLOWED_UPLOAD_MIME_TYPES.join(', ')}`, {
      parameter: 'contentType',
      received: typeof contentType === 'string' ? contentType : typeof contentType,
      allowedMimeTypes: [...ALLOWED_UPLOAD_MIME_TYPES],
    });
  }

  const expiresAtMs = Date.now() + PRESIGN_EXPIRES_IN_SECONDS * 1000;
  const token = signPresignToken({ filename, contentType, expiresAtMs });

  res.status(201).json({
    uploadUrl: `/api/demo/storage/upload?token=${encodeURIComponent(token)}`,
    method: 'POST',
    headers: { 'content-type': contentType },
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresIn: PRESIGN_EXPIRES_IN_SECONDS,
    filename,
    contentType,
    signature: 'hmac-sha256 over filename|contentType|expiry — the webhooks topic\u2019s ceremony, granting instead of verifying',
    mock: true,
    note: 'the SIGNING and the STORE are real (the upload lands in the files topic\u2019s store, through its containment guard); only the BUCKET is imaginary — a real presigned URL points at S3/R2/GCS with the same one-grant, one-expiry shape.',
  });
}

/**
 * The upload endpoint the presigned URL points at. `raw()` accepts ANY
 * content type as a Buffer (the root JSON parser would only parse
 * application/json) with the same 5MB limit the files topic enforces.
 */
async function storageUploadController(req: Request, res: Response): Promise<void> {
  const token = req.query.token;
  if (typeof token !== 'string' || token === '') {
    throw new ValidationException('"token" query parameter is required — this endpoint only answers presigned requests', {
      parameter: 'token',
    });
  }
  const verification = verifyPresignToken(token);
  if (!verification.ok) {
    const messages: Record<typeof verification.reason, string> = {
      malformed_token: 'presign token is malformed (expected base64url-payload.signature)',
      invalid_signature: 'presign token rejected: signature did not match the granted filename/contentType/expiry',
      expired: `presign token expired at ${verification.expiresAtMs !== undefined ? new Date(verification.expiresAtMs).toISOString() : '(unknown)'}`,
    };
    throw new UnauthorizedException(`upload rejected: ${messages[verification.reason]}`, {
      reason: verification.reason,
    });
  }
  const grant = verification.payload;

  // The request's declared type must BE the granted type — the token binds it.
  const requestType = req.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (requestType !== grant.contentType) {
    throw new ValidationException(
      `content-type "${requestType || '(none)'}" does not match the presigned grant ("${grant.contentType}") — the token binds filename AND type AND expiry`,
      { reason: 'content_type_mismatch', granted: grant.contentType, received: requestType || null },
    );
  }

  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (bytes.length === 0) {
    throw new ValidationException('the upload body is empty — presigned PUTs carry the raw bytes as the body', {
      reason: 'empty_body',
    });
  }
  if (bytes.length > UPLOAD_MAX_BYTES) {
    throw new ValidationException(`upload exceeds the ${String(UPLOAD_MAX_BYTES)} byte cap (${String(bytes.length)} received)`, {
      reason: 'too_large',
      fileSizeLimitBytes: UPLOAD_MAX_BYTES,
    });
  }

  // Store through the files topic's REAL API: server-generated stored name
  // (the client filename never becomes a path), containment-guarded write,
  // registered metadata, cap eviction. writeVariant() is the store's guarded
  // byte-write; the presigned path reuses it for the original because the
  // guard is the point, not the variant-ness.
  const storedName = fileStore.reserveStoredName(grant.contentType);
  await fileStore.writeVariant(storedName, bytes);
  const meta: StoredFileMetadata = fileStore.register({
    id: fileStore.nextId(),
    originalName: sanitizeDisplayName(grant.filename),
    storedName,
    mimeType: grant.contentType,
    size: bytes.length,
    kind: grant.contentType.startsWith('image/') ? 'image' : 'file',
    note: 'stored via the presigned-URL flow — bytes as delivered (no sharp decode on this path)',
  });

  res.status(201).json({
    file: meta,
    rawUrl: `/api/demo/files/${meta.id}/raw`,
    grant: { filename: grant.filename, contentType: grant.contentType },
    mock: true,
    note: 'a REAL file in the REAL store — fetch it back at rawUrl. The presign ceremony (sign → verify → expiry) is production-shaped; only the destination is this machine instead of a bucket.',
  });
}

// ============================================================================
// the router
// ============================================================================

export const thirdPartyDemoRouter = Router();
thirdPartyDemoRouter.post('/demo/email/send', emailSendController);
thirdPartyDemoRouter.get('/demo/email/outbox', emailOutboxController);
thirdPartyDemoRouter.post('/demo/payments/intent', paymentsIntentController);
thirdPartyDemoRouter.post('/demo/payments/confirm', paymentsConfirmController);
thirdPartyDemoRouter.get('/demo/payments/:id', paymentsStatusController);
thirdPartyDemoRouter.post('/demo/storage/presign', storagePresignController);
thirdPartyDemoRouter.post(
  '/demo/storage/upload',
  // Limit sits above the 5MB cap so the CONTROLLER enforces the real ceiling
  // with the canonical 400 envelope (teaching our cap), not body-parser's 413.
  raw({ type: () => true, limit: '6mb' }),
  storageUploadController,
);
