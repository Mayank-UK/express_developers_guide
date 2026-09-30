import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { appConfig } from '../../core/config/app_config.js';
import {
  resetWebhookDemoStore,
  signWebhookBody,
  webhookSignatureMatches,
  WEBHOOK_DEMO_SECRET,
} from './webhooks_demo_routes.js';
import { UUID_RE } from '../../test_support/index.js';

const RECEIVE = '/api/demo/webhooks/receive';
const DELIVERIES = '/api/demo/webhooks/deliveries';
const SEND = '/api/demo/webhooks/send';

/** Builds one signed webhook request the way a real sender would. */
function signedWebhook(
  app: ReturnType<typeof createApp>,
  body: string,
  options: { signature?: string; timestampSeconds?: number } = {},
) {
  const timestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const signature = options.signature ?? signWebhookBody(body);
  return request(app)
    .post(RECEIVE)
    .set('content-type', 'application/json')
    .set('x-webhook-signature', signature)
    .set('x-webhook-timestamp', timestamp)
    .send(body);
}

const SAMPLE_EVENT = JSON.stringify({
  id: 'evt_1',
  type: 'post.created',
  created: '2026-09-28T12:00:00.000Z',
  data: { post: { title: 'Hello', author: 'the guide' } },
});

beforeEach(() => {
  resetWebhookDemoStore();
});

afterEach(() => {
  resetWebhookDemoStore();
});

describe('the signing helper (unit)', () => {
  it('produces the known HMAC-SHA256 hex for a known secret + body', () => {
    // Independently computed: echo -n '{"id":"evt_1","type":"post.created"}' |
    // openssl dgst -sha256 -hmac "whsec_teaching_demo"
    expect(signWebhookBody('{"id":"evt_1","type":"post.created"}')).toBe(
      'be686a7bdc3043bdac918f9bc9c02561bc59663e44627b923b16b4a15a091cbf',
    );
    expect(signWebhookBody('{"id":"evt_1","type":"post.created"}')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input and differs per byte and per secret', () => {
    expect(signWebhookBody(SAMPLE_EVENT)).toBe(signWebhookBody(Buffer.from(SAMPLE_EVENT, 'utf8')));
    expect(signWebhookBody(SAMPLE_EVENT)).not.toBe(signWebhookBody(`${SAMPLE_EVENT} `)); // byte-sensitive
    expect(signWebhookBody(SAMPLE_EVENT, 'whsec_other')).not.toBe(signWebhookBody(SAMPLE_EVENT));
  });

  it('webhookSignatureMatches accepts the right signature and rejects wrong ones', () => {
    expect(webhookSignatureMatches(SAMPLE_EVENT, signWebhookBody(SAMPLE_EVENT))).toBe(true);
    expect(webhookSignatureMatches(SAMPLE_EVENT, '0'.repeat(64))).toBe(false); // well-formed hex, wrong digest
    expect(webhookSignatureMatches(SAMPLE_EVENT, 'not-hex')).toBe(false); // malformed hex
    expect(webhookSignatureMatches(SAMPLE_EVENT, '')).toBe(false); // empty header
  });
});

describe('POST /api/demo/webhooks/receive — the receiver', () => {
  it('accepts a correctly signed, fresh delivery with 202 and stores it in the inbox', async () => {
    const app = createApp();
    const res = await signedWebhook(app, SAMPLE_EVENT);

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.deliveryId).toMatch(UUID_RE);
    expect(res.body.note).toMatch(/202/);

    const inbox = await request(app).get(DELIVERIES);
    expect(inbox.status).toBe(200);
    expect(inbox.body.count).toBe(1);
    expect(inbox.body.cap).toBe(50);
    expect(inbox.body.deliveries[0].signatureVerified).toBe(true);
    expect(inbox.body.deliveries[0].type).toBe('post.created');
    expect(inbox.body.deliveries[0].payload).toEqual(JSON.parse(SAMPLE_EVENT));
  });

  it('rejects a wrong signature with a 401 envelope and stores nothing', async () => {
    const app = createApp();
    const res = await signedWebhook(app, SAMPLE_EVENT, { signature: 'a'.repeat(64) });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(res.body.error.reason).toBe('invalid_signature');
    expect(res.body.error.requestId).toMatch(UUID_RE);

    const inbox = await request(app).get(DELIVERIES);
    expect(inbox.body.count).toBe(0); // rejected BEFORE storing — verify first
  });

  it('rejects a missing signature header with 401 and a reason', async () => {
    const res = await request(createApp())
      .post(RECEIVE)
      .set('content-type', 'application/json')
      .set('x-webhook-timestamp', String(Math.floor(Date.now() / 1000)))
      .send(SAMPLE_EVENT);

    expect(res.status).toBe(401);
    expect(res.body.error.reason).toBe('missing_signature');
  });

  it('rejects a stale timestamp with 401 (replay protection) even with a valid signature', async () => {
    const app = createApp();
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600; // window is 300s
    const res = await signedWebhook(app, SAMPLE_EVENT, { timestampSeconds: anHourAgo });

    expect(res.status).toBe(401);
    expect(res.body.error.reason).toBe('stale_timestamp');
    expect(res.body.error.maxSkewSeconds).toBe(300);

    const inbox = await request(app).get(DELIVERIES);
    expect(inbox.body.count).toBe(0);
  });

  it('rejects a malformed timestamp with 401', async () => {
    const res = await signedWebhook(createApp(), SAMPLE_EVENT, { timestampSeconds: Number.NaN });

    expect(res.status).toBe(401);
    expect(res.body.error.reason).toBe('malformed_timestamp');
  });

  it('rejects a non-JSON delivery with 400 — the signature is over bytes we never captured', async () => {
    const res = await request(createApp())
      .post(RECEIVE)
      .set('content-type', 'text/plain')
      .set('x-webhook-signature', signWebhookBody(SAMPLE_EVENT))
      .set('x-webhook-timestamp', String(Math.floor(Date.now() / 1000)))
      .send(SAMPLE_EVENT);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.reason).toBe('wrong_content_type');
  });

  it('caps the inbox at the 50 most recent deliveries (newest first)', async () => {
    const app = createApp();
    for (let index = 0; index < 55; index += 1) {
      const body = JSON.stringify({ id: `evt_${index}`, type: 'post.created', data: {} });
      const res = await signedWebhook(app, body);
      expect(res.status).toBe(202);
    }

    const inbox = await request(app).get(DELIVERIES);
    expect(inbox.body.count).toBe(50);
    // Newest first: the last-delivered event sits on top.
    expect(inbox.body.deliveries[0].payload.id).toBe('evt_54');
    expect(inbox.body.deliveries[49].payload.id).toBe('evt_5');
  });
});

describe('POST /api/demo/webhooks/send — the sender', () => {
  // The self-call targets the REAL configured port, which a dev server may or
  // may not be occupying while tests run — so the flight itself is stubbed per
  // test (unreachable / answered), keeping the specs hermetic either way.
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed (ECONNREFUSED)'); // no listener
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers 200 with the exact would-be flight and a graceful unreachable note when nothing listens', async () => {
    const res = await request(createApp()).post(SEND);

    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(false); // the stubbed fetch could not connect
    expect(res.body.note).toMatch(/unreachable/);

    expect(res.body.event.type).toBe('post.created'); // default event type
    expect(res.body.event.id).toMatch(UUID_RE);
    expect(res.body.tampered).toBe(false);
    expect(res.body.signature).toMatch(/^[0-9a-f]{64}$/);

    // The flight is verifiable with the receiver's own logic.
    expect(res.body.wouldDeliver.url).toBe(`http://127.0.0.1:${String(appConfig.port)}${RECEIVE}`);
    expect(res.body.wouldDeliver.headers['x-webhook-signature']).toBe(res.body.signature);
    expect(webhookSignatureMatches(res.body.wouldDeliver.body, res.body.signature)).toBe(true);

    // The signature is over the DELIVERED bytes, and they parse back to the event.
    expect(JSON.parse(res.body.wouldDeliver.body)).toEqual(res.body.event);
  });

  it('honours ?type=post.updated and rejects unknown types with a 400 envelope', async () => {
    const updated = await request(createApp()).post(`${SEND}?type=post.updated`);
    expect(updated.status).toBe(200);
    expect(updated.body.event.type).toBe('post.updated');
    expect(updated.body.event.data.post.changed).toEqual(['title']);

    const bogus = await request(createApp()).post(`${SEND}?type=post.deleted`);
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.code).toBe('validation_failed');
    expect(bogus.body.error.parameter).toBe('type');
  });

  it('?tamper=1 signs with the wrong secret and flags the attempt', async () => {
    const res = await request(createApp()).post(`${SEND}?tamper=1`);

    expect(res.status).toBe(200);
    expect(res.body.tampered).toBe(true);
    expect(res.body.tamperNote).toMatch(/401/);
    // The tampered signature will NOT verify against the delivered bytes.
    expect(webhookSignatureMatches(res.body.wouldDeliver.body, res.body.signature)).toBe(false);
    expect(webhookSignatureMatches(res.body.wouldDeliver.body, res.body.signature, 'whsec_wrong_secret')).toBe(true);
  });

  it('names the algorithm so clients can render the scheme', async () => {
    const res = await request(createApp()).post(SEND);
    expect(res.body.signatureAlgorithm).toMatch(/hmac-sha256/i);
    expect(res.body.signatureAlgorithm).toMatch(/body bytes/);
  });

  it('records the receiver\'s answer when the flight connects — and flies exactly the documented bytes', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'unauthorized',
              message: 'webhook rejected: signature did not match the raw body bytes',
              requestId: '9a1f5c33-7e42-4b08-b5d6-8c7e2f1a0b4c',
            },
          }),
          { status: 401 },
        ),
    );
    const res = await request(createApp()).post(`${SEND}?tamper=1`);

    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(true);
    expect(res.body.outcome.status).toBe(401); // the receiver rejected the tampered signature
    expect(res.body.outcome.body).toMatch(/invalid_signature|signature did not match/);

    // The flight was EXACTLY the one documented in wouldDeliver.
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(res.body.wouldDeliver.url);
    expect((calledInit as RequestInit).method).toBe('POST');
    expect((calledInit as RequestInit).body).toBe(res.body.wouldDeliver.body);
    expect((calledInit as RequestInit).headers).toEqual(res.body.wouldDeliver.headers);
  });
});
