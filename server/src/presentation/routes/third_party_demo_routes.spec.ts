import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { getContainer } from '../../di/container.js';
import { EmailService, EMAIL_OUTBOX_CAP } from '../../domain/email/email_service.js';
import { fileStore } from '../../data/files/file_store.js';
import {
  resetThirdPartyDemoStores,
  signPresignToken,
  THIRD_PARTY_DEMO_MOUNT_PATH,
} from './third_party_demo_routes.js';

/**
 * The third-party hub's contract, per integration:
 *
 * EMAIL — the real jsonTransport adapter: a send is CAPTURED (messageId,
 * accepted, capturedAt) and lands in the outbox newest-first; invalid input
 * answers the canonical 400 envelope; the 50-cap holds (proven at the service
 * level with an injected no-latency sleep so 51 sends cost milliseconds).
 *
 * PAYMENTS — the Stripe-shaped mock: intent → confirm with the 4242 test card
 * → succeeded + receipt; "declined" → requires_payment_method with Stripe's
 * code/decline_code field names; unknown intent → 404; double-confirm → 400;
 * every response carries mock: true (no money paths anywhere).
 *
 * STORAGE — the real presign ceremony over the real files store: presign →
 * upload stores a file fetchable at the files topic's /raw endpoint; a
 * tampered token, an expired token, and a wrong-secret token all answer 401;
 * uploading with a content type the grant did not bind answers 400.
 */

const EMAIL_URL = `${THIRD_PARTY_DEMO_MOUNT_PATH}/email`;
const PAYMENTS_URL = `${THIRD_PARTY_DEMO_MOUNT_PATH}/payments`;
const STORAGE_URL = `${THIRD_PARTY_DEMO_MOUNT_PATH}/storage`;

beforeEach(() => {
  resetThirdPartyDemoStores();
  getContainer().emailService.clear();
});

// --- email --------------------------------------------------------------------

describe('POST /api/demo/email/send — the real jsonTransport adapter', () => {
  it('captures the message and the outbox lists it newest-first with the receipt fields', async () => {
    const send = await request(createApp())
      .post(`${EMAIL_URL}/send`)
      .send({ to: 'student@example.com', subject: 'Welcome to the guide', text: 'Chapter 1 is live.' });
    expect(send.status).toBe(201);
    expect(send.body.messageId).toMatch(/^<.+@.+>$/); // nodemailer minted this
    expect(send.body.accepted).toEqual(['student@example.com']);
    expect(send.body.capturedAt).toEqual(expect.any(String));
    expect(send.body.note).toContain('jsonTransport');

    const second = await request(createApp())
      .post(`${EMAIL_URL}/send`)
      .send({ to: 'reader@example.com', subject: 'Chapter 2', text: 'Hot off the press.' });
    expect(second.status).toBe(201);

    const outbox = await request(createApp()).get(`${EMAIL_URL}/outbox`);
    expect(outbox.status).toBe(200);
    expect(outbox.body.count).toBe(2);
    expect(outbox.body.outbox[0].to).toBe('reader@example.com'); // newest first
    expect(outbox.body.outbox[1].to).toBe('student@example.com');
    expect(outbox.body.outbox[1].subject).toBe('Welcome to the guide');
    expect(outbox.body.outbox[1].transportMessage).toContain('Chapter 1 is live.'); // the actual JSON
  });

  it('rejects a missing-@ recipient, a blank subject, and an over-200-char subject with the 400 envelope', async () => {
    for (const bad of [
      { to: 'not-an-address', subject: 's', text: 't' },
      { to: 'ok@example.com', subject: '', text: 't' },
      { to: 'ok@example.com', subject: 'x'.repeat(201), text: 't' },
      { to: 'ok@example.com', subject: 's' },
    ]) {
      const res = await request(createApp()).post(`${EMAIL_URL}/send`).send(bad);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'validation_failed', requestId: expect.any(String) });
    }
  });
});

describe('EmailService — the 50-cap outbox ring (service level, fake transporter + no-latency sleep)', () => {
  // The refactor cashed: the transporter is a required injected PORT, so the
  // spec passes a fake that satisfies it structurally — no nodemailer, no
  // message pipeline, just the reply shape the domain consumes.
  const fakeTransporter = {
    sendMail: async () => ({ messageId: '<cap-test@guide.example>', message: '{}' }),
  };

  it('keeps only the newest EMAIL_OUTBOX_CAP messages', async () => {
    const service = new EmailService({ transporter: fakeTransporter, sleep: async () => {} }); // latency off — this test is about the cap
    for (let i = 1; i <= EMAIL_OUTBOX_CAP + 2; i += 1) {
      const result = await service.send({ to: `user${String(i)}@example.com`, subject: `#${String(i)}`, text: 'cap test' });
      expect(result.ok).toBe(true);
    }
    const outbox = service.listOutbox();
    expect(outbox).toHaveLength(EMAIL_OUTBOX_CAP);
    expect(outbox[0]?.subject).toBe(`#${String(EMAIL_OUTBOX_CAP + 2)}`); // newest kept
    expect(outbox.at(-1)?.subject).toBe('#3'); // the two oldest were evicted
  });
});

// --- payments -----------------------------------------------------------------

describe('POST /api/demo/payments — the Stripe-shaped mock', () => {
  it('creates a requires_confirmation intent with a masked-shape client secret, labeled mock', async () => {
    const res = await request(createApp())
      .post(`${PAYMENTS_URL}/intent`)
      .send({ amountCents: 1999, currency: 'usd' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.stringMatching(/^pi_mock_\d+$/),
      amountCents: 1999,
      currency: 'usd',
      clientSecret: expect.stringMatching(/^pi_mock_\d+_secret_demo$/),
      status: 'requires_confirmation',
      mock: true,
    });
  });

  it('validates amountCents and currency with 400 envelopes', async () => {
    for (const bad of [
      { amountCents: 10, currency: 'usd' }, // below Stripe's own 50c floor
      { amountCents: 19.99, currency: 'usd' }, // not whole cents
      { amountCents: 1999, currency: 'dollar' },
      { currency: 'usd' },
    ]) {
      const res = await request(createApp()).post(`${PAYMENTS_URL}/intent`).send(bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('4242 → succeeded with a receipt; declined → requires_payment_method with Stripe decline fields', async () => {
    // SUCCEED first, on a fresh intent.
    const okIntent = (await request(createApp()).post(`${PAYMENTS_URL}/intent`).send({ amountCents: 1999 })).body;
    const confirmed = await request(createApp())
      .post(`${PAYMENTS_URL}/confirm`)
      .send({ paymentIntentId: okIntent.id, card: '4242424242424242' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.paymentIntent.status).toBe('succeeded');
    expect(confirmed.body.paymentIntent.latestCharge).toMatchObject({
      id: expect.stringMatching(/^ch_mock_/),
      receiptId: expect.stringMatching(/^rcpt_mock_/),
    });
    expect(confirmed.body.receipt.id).toBe(confirmed.body.paymentIntent.latestCharge.receiptId);
    expect(confirmed.body.mock).toBe(true);
    // Status endpoint agrees.
    const status = await request(createApp()).get(`${PAYMENTS_URL}/${String(okIntent.id)}`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('succeeded');

    // DECLINE on a second intent — status FALLS BACK, last_payment_error lands.
    const badIntent = (await request(createApp()).post(`${PAYMENTS_URL}/intent`).send({ amountCents: 500 })).body;
    const declined = await request(createApp())
      .post(`${PAYMENTS_URL}/confirm`)
      .send({ paymentIntentId: badIntent.id, card: 'declined' });
    expect(declined.status).toBe(200);
    expect(declined.body.paymentIntent.status).toBe('requires_payment_method');
    expect(declined.body.paymentIntent.lastPaymentError).toEqual({
      code: 'card_declined',
      decline_code: 'generic_decline',
      message: 'Your card was declined.',
    });
    expect(declined.body.declineCode).toBe('card_declined');
  });

  it('unknown intent → 404; double-confirm → 400; unknown card → 400', async () => {
    const missing = await request(createApp())
      .post(`${PAYMENTS_URL}/confirm`)
      .send({ paymentIntentId: 'pi_mock_9999', card: '4242' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');

    const intent = (await request(createApp()).post(`${PAYMENTS_URL}/intent`).send({ amountCents: 1200 })).body;
    const unknownCard = await request(createApp())
      .post(`${PAYMENTS_URL}/confirm`)
      .send({ paymentIntentId: intent.id, card: '1234' });
    expect(unknownCard.status).toBe(400);

    await request(createApp()).post(`${PAYMENTS_URL}/confirm`).send({ paymentIntentId: intent.id, card: '4242' });
    const double = await request(createApp())
      .post(`${PAYMENTS_URL}/confirm`)
      .send({ paymentIntentId: intent.id, card: '4242' });
    expect(double.status).toBe(400);
    expect(double.body.error.message).toContain('already succeeded');
  });
});

// --- storage ------------------------------------------------------------------

describe('POST /api/demo/storage — the real presign ceremony over the real store', () => {
  beforeEach(() => {
    fileStore.reset(); // the uploads land in the files topic's store
  });

  it('presign → upload roundtrip stores a REAL file, fetchable at the files topic raw endpoint', async () => {
    const presign = await request(createApp())
      .post(`${STORAGE_URL}/presign`)
      .send({ filename: 'hello-presign.txt', contentType: 'text/plain' });
    expect(presign.status).toBe(201);
    expect(presign.body.uploadUrl).toMatch(/^\/api\/demo\/storage\/upload\?token=/);
    expect(presign.body.expiresIn).toBe(300);
    expect(presign.body.mock).toBe(true);

    const token = new URL(presign.body.uploadUrl as string, 'http://x').searchParams.get('token') ?? '';
    const upload = await request(createApp())
      .post(`${STORAGE_URL}/upload?token=${encodeURIComponent(token)}`)
      .set('content-type', 'text/plain')
      .send('presigned payload — the bytes went straight to the store');
    expect(upload.status).toBe(201);
    expect(upload.body.file).toMatchObject({
      id: expect.stringMatching(/^files-/),
      originalName: 'hello-presign.txt',
      mimeType: 'text/plain',
      kind: 'file',
    });
    expect(upload.body.rawUrl).toBe(`/api/demo/files/${String(upload.body.file.id)}/raw`);

    // Fetch the SAME bytes back through the files topic's endpoint — the store is real.
    const raw = await request(createApp()).get(String(upload.body.rawUrl));
    expect(raw.status).toBe(200);
    expect(raw.text).toBe('presigned payload — the bytes went straight to the store');
  });

  it('rejects a presign for a content type outside the files allowlist', async () => {
    const res = await request(createApp())
      .post(`${STORAGE_URL}/presign`)
      .send({ filename: 'evil.exe', contentType: 'application/octet-stream' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('tampered token → 401 (signature did not match the granted fields)', async () => {
    const presign = await request(createApp())
      .post(`${STORAGE_URL}/presign`)
      .send({ filename: 'a.txt', contentType: 'text/plain' });
    const token = new URL(presign.body.uploadUrl as string, 'http://x').searchParams.get('token') ?? '';
    expect(token).toContain('.');
    const [payload, signature] = token.split('.');

    // Flip the last hex char of the signature.
    const lastChar = signature.slice(-1);
    const flipped = lastChar === 'a' ? 'b' : 'a';
    const tamperedSignature = `${token.slice(0, -1)}${flipped}`;
    const tamperedSig = await request(createApp())
      .post(`${STORAGE_URL}/upload?token=${encodeURIComponent(tamperedSignature)}`)
      .set('content-type', 'text/plain')
      .send('payload');
    expect(tamperedSig.status).toBe(401);
    expect(tamperedSig.body.error).toMatchObject({ code: 'unauthorized', reason: 'invalid_signature' });

    // Rewrite the payload's filename (keeping a same-length payload) — the
    // signature no longer covers what the payload claims.
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { filename: string; contentType: string; expiresAtMs: number };
    claims.filename = 'other.txt';
    const forgedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const tamperedPayload = await request(createApp())
      .post(`${STORAGE_URL}/upload?token=${encodeURIComponent(`${forgedPayload}.${signature}`)}`)
      .set('content-type', 'text/plain')
      .send('payload');
    expect(tamperedPayload.status).toBe(401);
    expect(tamperedPayload.body.error).toMatchObject({ reason: 'invalid_signature' });

    // Missing token entirely → 400 (nothing to verify).
    const missing = await request(createApp())
      .post(`${STORAGE_URL}/upload`)
      .set('content-type', 'text/plain')
      .send('payload');
    expect(missing.status).toBe(400);
  });

  it('expired token → 401 (crafted via the exported signer — the clean clock)', async () => {
    const expired = signPresignToken({ filename: 'late.txt', contentType: 'text/plain', expiresAtMs: Date.now() - 1000 });
    const res = await request(createApp())
      .post(`${STORAGE_URL}/upload?token=${encodeURIComponent(expired)}`)
      .set('content-type', 'text/plain')
      .send('too late');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ reason: 'expired' });
    expect(res.body.error.message).toContain('expired');
  });

  it('uploading with a content type the grant did not bind → 400', async () => {
    const presign = await request(createApp())
      .post(`${STORAGE_URL}/presign`)
      .send({ filename: 'granted.txt', contentType: 'text/plain' });
    const token = new URL(presign.body.uploadUrl as string, 'http://x').searchParams.get('token') ?? '';
    const res = await request(createApp())
      .post(`${STORAGE_URL}/upload?token=${encodeURIComponent(token)}`)
      .set('content-type', 'application/pdf')
      .send('%PDF-1.4 not really');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ reason: 'content_type_mismatch' });
  });

  it('empty body → 400 and an over-cap body → 400 (the controller enforces the ceiling)', async () => {
    const presign = await request(createApp())
      .post(`${STORAGE_URL}/presign`)
      .send({ filename: 'big.txt', contentType: 'text/plain' });
    const token = new URL(presign.body.uploadUrl as string, 'http://x').searchParams.get('token') ?? '';

    const empty = await request(createApp())
      .post(`${STORAGE_URL}/upload?token=${encodeURIComponent(token)}`)
      .set('content-type', 'text/plain')
      .send();
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatchObject({ reason: 'empty_body' });

    const tooBig = await request(createApp())
      .post(`${STORAGE_URL}/upload?token=${encodeURIComponent(token)}`)
      .set('content-type', 'text/plain')
      .send(Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatchObject({ reason: 'too_large' });
  });
});
