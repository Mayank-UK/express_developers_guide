import type { Topic } from '../types.js';

/**
 * The Third-Party Services topic — the LAST topic in the guide: email
 * (nodemailer) · payments (Stripe) · cloud storage, as three parts of one
 * lesson. Every integration here is honest about its level of realness: the
 * email adapter is a REAL dependency (nodemailer's jsonTransport — the full
 * message pipeline, zero network), payments is a Stripe-shaped MOCK (the
 * shapes are the teaching), and storage is a REAL HMAC presign ceremony over
 * the files topic's real store. The content names which is which, always.
 */
export const topicThirdParty: Topic = {
  id: 'third-party',
  title: 'Third-Party Services',
  subtitle:
    'Email, payments, and cloud storage — integrating the outside world behind clean seams.',
  group: 'platform',
  order: 13,
  sections: [
    {
      id: 'thirdparty-integrating-vs-building',
      title: 'Integrating vs building',
      lead:
        'Email, payments, storage are commodity capabilities — buy them. The discipline is what you sign up for, and the seam you put between you and the vendor.',
      blocks: [
        {
          kind: 'text',
          id: 'thirdparty-integrating-vs-building:when-to-buy',
          body: `BUY THE COMMODITY, BUILD THE DIFFERENTIATOR. If a capability is identical for you and every competitor — delivering email, moving money, storing blobs — a third party has already paid the cost you would pay alone: SMTP reputations and bounce handling (email), PCI compliance and card networks (payments), durability and egress engineering (storage). Your version would be worse and cost more; this is not a skill issue, it is an economy-of-scale issue. WHAT YOU SIGN UP FOR, said plainly: LATENCY (a network round trip now sits inside your request path — the reliability topic's timeout discipline is not optional); OUTAGES ON THEIR SCHEDULE (Stripe, AWS, and every mail provider go down; your users experience it as YOUR outage); VENDOR TERMS (pricing changes, API deprecations, account suspensions that arrive by email); DATA FLOW (customer PII, payment metadata, and file bytes now pass through — and rest inside — someone else's infrastructure; the security topic's data-flow thinking applies). NONE OF THIS MEANS DON'T — it means integrate deliberately, with eyes open.`,
        },
        {
          kind: 'text',
          id: 'thirdparty-integrating-vs-building:the-adapter-lesson',
          body: `THE ADAPTER LESSON — THE ONE STRUCTURAL RULE OF THIS WHOLE TOPIC: wrap every third party behind YOUR interface, so the vendor is a swappable implementation detail (ports-and-adapters; the architecture topic's dependency rule pointing at YOUR port, not their SDK). Define the operation you need — sendEmail(message), createPaymentIntent(amount, currency), presignUpload(name, type) — as a small interface YOU own, and put the vendor's SDK inside exactly one module that implements it. What this buys: swapping providers (Postmark→SES, Stripe→Adyen, S3→R2) is ONE new adapter, not a refactor scattered across your codebase; testing is trivial (a fake adapter behind the same port — the same seam the fake/live repositories use in this app's container); and vendor quirks (pagination styles, error taxonomies, rate-limit headers) get translated into YOUR vocabulary at the boundary instead of leaking everywhere. This guide practices it for real below: the EmailTransporter interface IS the port, EmailService IS the domain service that speaks it (importing no vendor at all), nodemailer IS the adapter behind it, and the jsonTransport/SMTP swap is one constructor call at the composition root.`,
        },
        {
          kind: 'code',
          id: 'thirdparty-integrating-vs-building:port-shape',
          language: 'ts',
          caption:
            'The seam, drawn once — YOUR interfaces on top, the vendor handed in at the composition root (domain/email/email_service.ts, verbatim: the ports this whole topic calls through)',
          source: 'server/src/domain/email/email_service.ts',
          code: `// YOUR ports — the operations you need, in YOUR vocabulary.
// No vendor type appears in them; callers never import the SDK.
/** The message shape callers speak — OUR interface, not nodemailer's options bag. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative; the plain-text part is ALWAYS required. */
  html?: string;
}

/** The transporter PORT — "something that can send" as the domain sees it. */
export interface EmailTransporter {
  sendMail(mail: EmailTransportMail): Promise<EmailSendInfo>;
}

// The vendor appears in exactly ONE file: the composition root, which
// constructs the transporter and hands it in. Swap vendors by re-wiring
// the container: zero call sites change.
export class EmailService {
  private readonly transporter: EmailTransporter;

  constructor(options: EmailServiceOptions) {
    this.transporter = options.transporter; // REQUIRED — the domain constructs nothing
    // ^ the container passes nodemailer.createTransport({ jsonTransport: true })
    //   here — in prod: createTransport({ host, port, auth }), or a Postmark/SES
    //   adapter. The interface does not care. That is the whole point.
  }

  async send(message: EmailMessage): Promise<Result<EmailSendReceipt, Failure>> {`,
        },
      ],
    },
    {
      id: 'thirdparty-email-nodemailer',
      title: 'Email with nodemailer',
      lead:
        'The one integration in this topic you run for real — nodemailer behind an adapter, jsonTransport in dev, SMTP in prod, and the deliverability homework code cannot do for you.',
      blocks: [
        {
          kind: 'text',
          id: 'thirdparty-email-nodemailer:transport-abstraction',
          body: `THE TRANSPORT IS THE ABSTRACTION nodemailer gives you: one sendMail() API over SMTP, SES, Sendmail, and — the one this guide runs — JSON. \`jsonTransport: true\` executes nodemailer's ENTIRE real pipeline (address parsing, header assembly, MIME structure, messageId minting) and then hands you the message AS JSON instead of opening a socket: zero network, zero account, zero credentials, which is exactly why it is also the standard test/dev transport in production apps. THIS APP'S REAL ADAPTER (quoted below) wraps it in a domain service that validates input, simulates the 30–80ms hop a real send always costs, captures every message in a 50-deep outbox (the demo's evidence), and returns a Result — failures are values, the domain never throws (the exception-handling topic's rule). It is wired in the composition root like every other dependency, because "which transport" is WIRING, not domain logic.`,
        },
        {
          kind: 'code',
          id: 'thirdparty-email-nodemailer:adapter-quote',
          language: 'ts',
          caption:
            'Verbatim (abridged) — the real adapter this app runs (domain/email/email_service.ts, mounted via the container)',
          source: 'server/src/domain/email/email_service.ts',
          code: `export class EmailService {
  private readonly transporter: EmailTransporter;

  constructor(options: EmailServiceOptions) {
    // No construction here — the domain RECEIVES its transporter. The ONE
    // createTransport call lives in the composition root: jsonTransport in
    // this build, { host, port, auth } in prod. That is the adapter
    // lesson, cashed.
    this.transporter = options.transporter;
  }

  async send(message: EmailMessage): Promise<Result<EmailSendReceipt, Failure>> {
    const validation = this.validate(message);        // to must be address-shaped,
    if (validation !== undefined) return fail(validation); // subject ≤200, text always required
    // …the simulated 30–80ms hop — a send is a network round trip, not a
    // function call, and the caller's latency budget is built knowing it…
    let info: EmailSendInfo;
    try {
      info = await this.transporter.sendMail({
        from: EMAIL_FROM_ADDRESS,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined && { html: message.html }),
      });
    } catch (error) {
      // …jsonTransport cannot realistically fail here (no I/O), but the
      // shape is the honest adapter contract for the day the transport is
      // real → an 'unavailable' Failure…
    }
    // …derive 'accepted' from the envelope; capture into the outbox (cap 50)…
    return ok({ messageId: entry.messageId, accepted: entry.accepted, capturedAt });
  }
}`,
        },
        {
          kind: 'text',
          id: 'thirdparty-email-nodemailer:message-and-deliverability',
          body: `THE MESSAGE SHAPE: from / to / subject / text / html. Two rules worth their incidents: ALWAYS include a plain-text part (spam filters score HTML-only mail lower, and some clients render text only), and NEVER construct the HTML by string-splicing user input — that is an XSS delivered to an inbox; template with escaped variables like any other view. DELIVERABILITY IS DNS HOMEWORK, NOT CODE — the three records, one paragraph each: SPF (a TXT record listing which servers may SEND for your domain — without it, your own mail looks forged); DKIM (a cryptographic signature on every message, verified against a public key you publish — proof the message wasn't tampered in transit, and the mechanism providers weigh hardest); DMARC (the policy record telling receivers what to DO when SPF/DKIM fail — report-only while you tune alignment, then enforce — and where failure reports get sent, which is your only window into who is spoofing you). None of these are in your code; all three gate whether your mail arrives at all. TRANSACTIONAL vs MARKETING is a legal and technical split: transactional (receipts, resets — mail the user's action caused) can be sent to that user; marketing (newsletters, campaigns) requires consent and an unsubscribe link by law (CAN-SPAM/GDPR) and by inbox providers' volume reputations — use a different sending identity for each so a marketing reputation problem cannot sink your password resets. BOUNCES AND COMPLAINTS COME BACK AS WEBHOOKS: providers POST delivery/bounce/complaint events to your endpoint — verify the signature exactly like the webhooks topic's HMAC receiver, acknowledge 202 fast, and process async; and HARD-bounced addresses must be suppressed (sending to them again is the fastest way to burn your reputation), which is why the events belong in a store, not a log line.`,
        },
      ],
    },
    {
      id: 'thirdparty-email-as-job',
      title: 'Email as a job (recap)',
      lead:
        'The background-jobs topic sent email through a simulated sender by design. This is the swap: real adapter at the bottom, same queue on top — retries, dedupe, and all.',
      blocks: [
        {
          kind: 'text',
          id: 'thirdparty-email-as-job:the-swap',
          body: `RECAP THE SETUP: the jobs topic's hand-rolled queue ran an email handler with a SIMULATED sender (injected latency, injected failures) — its header note promised that a real transport "lands with the third-party services section; the queue's contract stays exactly this shape." THIS IS THAT PROMISE KEPT: the EmailService above IS the real bottom of that stack, and swapping it in changes nothing the queue knows — enqueue(email, payload) still means "deliver this eventually," the retry/backoff/dead-letter machinery still absorbs transient SMTP failures, and the handler body shrinks to one adapter call. THE LESSON GENERALIZES: when the EXPENSIVE, FLAKY part of a request is a third-party call, moving it behind a queue converts a synchronous vendor outage into an async backlog — your API answers 202-fast (the webhooks receiver's own contract) while retries ride out the outage. WHAT THE QUEUE ADDS ON TOP: RETRIES with exponential backoff and jitter (a dead-lettered email job is visible and replayable instead of silently dropped — requeue with a FRESH attempt budget, exactly the jobs demo's button), and the concurrency ceiling that keeps you under the provider's rate limit instead of thundering into it.`,
        },
        {
          kind: 'text',
          id: 'thirdparty-email-as-job:idempotency',
          body: `IDEMPOTENCY FOR EMAIL — THE RECEIPT-ID DEDUPE, one paragraph: a queue that retries WILL occasionally run a job whose send actually succeeded on attempt one (the response was lost, not the send) — so the handler must be idempotent or a retried "send welcome email" becomes two welcome emails. The standard pattern: before sending, look up a dedupe key (the job id, or a purpose-scoped key like receipt:{orderId}) in a "sent" table; if present, return success WITHOUT sending; after the provider accepts, record the key alongside the provider's messageId. The send-plus-record is not perfectly atomic (crash between the two re-sends), and the honest fix is the same idempotency-key support providers expose on their APIs — pass the dedupe key AS the provider's idempotency key and let THEIR side collapse the double-send too. The jobs topic's warning is the summary: "requeueing a succeeded job is how duplicate emails happen" — the dedupe table is the seatbelt for when it happens anyway.`,
        },
      ],
    },
    {
      id: 'thirdparty-payments-stripe',
      title: 'Payments with Stripe',
      lead:
        'The one integration you must not learn by shipping: PaymentIntent anatomy, the webhook as the source of truth, idempotency keys — sketched here, because the shapes are the teaching.',
      blocks: [
        {
          kind: 'text',
          id: 'thirdparty-payments-stripe:flow-anatomy',
          body: `WHY STRIPE IS A SKETCH IN THIS GUIDE, SAID HONESTLY: the SDK would bloat the install for demos that cannot run without API keys and real money — so this topic teaches the SHAPES with a labeled mock (every demo response carries mock: true) — the quoted routes below are that mock's real code, with the real SDK's method names carried in the framing. THE FLOW ANATOMY, the part every integration must get right: (1) your server CREATES a PaymentIntent for an amount — server-side only, because prices computed in the browser are a suggestion; (2) Stripe returns a CLIENT SECRET — the one credential designed to reach the browser; (3) the CLIENT confirms (Stripe.js/Mobile Elements collect the card — card data NEVER touches your server, which is what keeps you out of PCI scope); (4) the WEBHOOK is the truth: \`payment_intent.succeeded\` arriving server-to-server, signature-verified, is what fulfills the order. NEVER TRUST THE CLIENT'S SUCCESS REDIRECT — a return URL saying "thanks, paid" is trivially reachable by typing it; fulfillment keyed to it ships free goods. THE STATUS LADDER is a small state machine — requires_payment_method → requires_confirmation → processing → succeeded (or canceled, or back to requires_payment_method after a decline with last_payment_error carrying the reason) — the mock below walks it with the real field names.`,
        },
        {
          kind: 'code',
          id: 'thirdparty-payments-stripe:create-intent-sketch',
          language: 'ts',
          caption:
            'Verbatim — the create-intent endpoint this app really serves (the labeled mock, third_party_demo_routes.ts); the real SDK call it mirrors is stripe.paymentIntents.create({ amount, currency }, { idempotencyKey }) — server-side only, the one place amounts come from',
          source: 'server/src/presentation/routes/third_party_demo_routes.ts',
          code: `function paymentsIntentController(req: Request, res: Response): void {
  // …amountCents + currency validated at the boundary → the 400 envelope…
  // (the real SDK: amount is SERVER-computed — computeOrderTotalCents — never
  // client-sent; the idempotencyKey means a retried request returns the SAME
  // intent instead of charging twice: retries collapse at the vendor)…

  paymentSeq += 1;
  const id = \`pi_mock_\${String(paymentSeq).padStart(4, '0')}\`;
  const intent: MockPaymentIntent = {
    id,
    amountCents,
    currency: currencyRaw,
    clientSecret: \`\${id}_secret_demo\`,
    status: 'requires_confirmation',
    created: new Date().toISOString(),
  };
  paymentIntents.set(id, intent);
  // Cap enforcement: evict the OLDEST beyond the cap (insertion order).

  res.status(201).json({
    ...intentResponse(intent),
    // …testCards: 4242… always succeeds, 'declined' → card_declined —
    // Stripe's own test-mode inputs, mirrored by the mock…
  });
}`,
        },
        {
          kind: 'code',
          id: 'thirdparty-payments-stripe:webhook-sketch',
          language: 'ts',
          caption:
            'Verbatim — the HMAC ceremony this app really runs on its own webhook receiver (webhooks_demo_routes.ts); stripe.webhooks.constructEvent IS this, vendor-packaged — signature over the RAW bytes, constant-time, rejected BEFORE any business logic',
          source: 'server/src/presentation/routes/webhooks_demo_routes.ts',
          code: `// SERVER: the source of truth. Signature FIRST (over the RAW body bytes —
// the same raw-body capture lesson as this app's webhook receiver), then
// fulfill on the verified event, 202 fast.
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

// Stripe's stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'],
// process.env.STRIPE_WEBHOOK_SECRET!) is exactly this ceremony — reject BEFORE
// any business logic (400 on a bad signature), then acknowledge 202 NOW and
// fulfill async: void fulfillOrder(event.data.object.id).`,
        },
        {
          kind: 'text',
          id: 'thirdparty-payments-stripe:dev-loop-and-honesty',
          body: `THE DEV LOOP IS TEST MODE, not a sandbox afterthought: Stripe's test mode gives you CARDS AS INPUTS — 4242 4242 4242 4242 always succeeds, 4000 0000 0000 0002 always declines with card_declined, 4000 0000 0000 9995 is insufficient_funds — meaning your ENTIRE payment flow (intent → confirm → webhook → fulfillment, decline → recovery UI) is exercisable end-to-end in CI with zero money, and the mock below mirrors exactly these outcomes so the UI teaches against the truth. IDEMPOTENCY KEYS, one paragraph: every money-moving call takes one (a UUID minted per logical operation — per checkout attempt, per refund click); the vendor stores request+response under the key and replays the SAME response on retry, so a timeout-then-retry cannot double-charge — it is the receipt-dedupe paragraph above, implemented at the vendor. REFUNDS are their own endpoint (stripe.refunds.create with the charge/payment id) and their own webhook (charge.refunded) — refund on the webhook, not the API response, for the same source-of-truth reason; and refunds AFTER settlement take days, which your support copy should say. THE TAX/COMPLIANCE PARAGRAPH, HONESTLY: payments are not just code — you owe sales tax/VAT somewhere (Stripe Tax can compute and remit-collect it, but the LIABILITY and registration decisions are yours), you will sign agreements with the processor and the card networks, disputes arrive as chargebacks with evidence deadlines and fees even when you win, and currency conversion and payout schedules have their own costs. Budget for the operational surface, not just the API integration — the engineering is honestly the easy part.`,
        },
      ],
    },
    {
      id: 'thirdparty-cloud-storage',
      title: 'Cloud storage',
      lead:
        'Buckets and keys, presigned URLs for direct-to-bucket uploads, signed downloads, a CDN in front — with a real signing ceremony you can run right here.',
      blocks: [
        {
          kind: 'text',
          id: 'thirdparty-cloud-storage:object-model-and-presign',
          body: `THE OBJECT MODEL IS ONE FLAT NAMESPACE: a BUCKET (a named container with its own permissions and region) full of OBJECTS addressed by KEY (an arbitrary string — conventionally slash-shaped like users/42/avatar.png, but there are no folders; "directories" are key prefixes your tooling draws as trees). No open, no seek, no partial write: you PUT whole bytes with metadata (content-type, cache-control) and GET them back by exact key. TWO UPLOAD FLOWS, and why the second wins: SERVER-MEDIATED (client uploads to your API, your server streams to the bucket) keeps everything behind your auth but makes your server a byte-funnel — every megabyte passes through twice, occupying memory, bandwidth, and event-loop attention (the performance topic's streaming discipline applies the day you must); PRESIGNED URLs (the winner for anything sizeable) hand the client a short-lived, scoped URL it PUTs to DIRECTLY — your server authorizes (who, what filename, what content type, until when) WITHOUT ever touching the bytes, and the bucket enforces the grant. THIS APP RUNS THE REAL CEREMONY (below): presign mints an HMAC token over filename|contentType|expiry — the webhooks topic's signing ceremony in the AUTHORIZE direction — and the upload endpoint verifies signature and expiry before writing the raw body through the files topic's containment-guarded store. Only the bucket is imaginary; the signing, the verification, and the stored file are real and fetchable.`,
        },
        {
          kind: 'code',
          id: 'thirdparty-cloud-storage:presign-quote',
          language: 'ts',
          caption:
            'Verbatim (abridged) — this app\u2019s real presign signer + verifier (presentation/routes/third_party_demo_routes.ts)',
          source: 'server/src/presentation/routes/third_party_demo_routes.ts',
          code: `/** Canonical string the HMAC covers — every granted field is a verified field. */
function presignCanonical(payload: PresignPayload): string {
  return \`\${payload.filename}|\${payload.contentType}|\${String(payload.expiresAtMs)}\`;
}

// SIGN (the grant): HMAC-SHA256 over that canonical string — the webhooks
// topic's ceremony, granting instead of verifying.
export function signPresignToken(payload: PresignPayload, secret: string = PRESIGN_DEMO_SECRET): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(presignCanonical(payload)).digest('hex');
  return \`\${body}.\${signature}\`;
}

// VERIFY (the upload): structure → signature, constant-time → expiry. A
// real presigned S3/R2/GCS URL is this same one-grant-one-expiry shape with
// the vendor's key material; the mechanics you can read are the lesson.
export function verifyPresignToken(token: string, nowMs: number = Date.now(), secret: string = PRESIGN_DEMO_SECRET): PresignVerification {
  // … parse payload, recompute the HMAC, timingSafeEqual the signatures …
  if (nowMs >= payload.expiresAtMs) {
    return { ok: false, reason: 'expired', expiresAtMs: payload.expiresAtMs };
  }
  return { ok: true, payload };
}`,
        },
        {
          kind: 'text',
          id: 'thirdparty-cloud-storage:types-downloads-cdn-cost',
          body: `CONTENT TYPES ARE AN ALLOWLIST, NOT A FIELD: never accept "whatever the client says" — the presign grant here binds the content type and the upload rejects a mismatched one, reusing the files topic's exact MIME allowlist (one upload policy in one place), because a stored text/html you serve back same-origin is stored XSS. DOWNLOADS WANT SIGNING TOO: presigned GET URLs (same ceremony, read scope) with short expiries are how you serve private objects without proxying bytes — and expiring links are why download pages sometimes say "link expired, request a new one." PUT A CDN IN FRONT (the scaling topic's edge lesson): object storage + CDN is the classic pairing — cache immutable content forever (the caching topic's content-hash lesson: keys that embed a version or hash get max-age=31536000), keep mutable content short-TTL or signed, and the CDN's egress pricing beats the bucket's. THE AWS SDK (@aws-sdk/client-s3) is this topic's catalog mention — installed nowhere in this guide for the same reason as Stripe: the demo would need keys and a real bucket to run, and the transferable parts (the presign ceremony, the allowlist, the cost model) are taught runnable instead. THE COST MODEL, one paragraph: you pay three separate meters — STORAGE (per GB-month, cheap and falling), REQUESTS (per thousand operations, where a chatty app quietly bleeds), and EGRESS (per GB leaving the provider — the one that surprises: serving 100GB of downloads costs real money while storing them cost cents, and it is why CDNs with included egress change the math). Lifecycle rules (old objects → cheaper/colder tiers or deletion) are the fourth lever; set them the day you open the bucket, not the month the bill doubles.`,
        },
      ],
    },
    {
      id: 'thirdparty-keys-quotas-blast-radius',
      title: 'Keys, quotas, and blast radius',
      lead:
        'The operational contract of every integration: keys in env, limits on their schedule, timeouts and breakers on yours, test mode first, and the status-page habit.',
      blocks: [
        {
          kind: 'text',
          id: 'thirdparty-keys-quotas-blast-radius:keys-and-limits',
          body: `API KEYS LIVE IN ENV, NEVER CODE — the environments topic's whole contract: secrets arrive as environment variables, get validated at boot, and are masked in any introspection (its inspector's name-rule hides anything secret-shaped; a key committed to a repo is a key leaked to every clone and every CI log, and rotating a payments key mid-incident is its own outage). SEPARATE KEYS PER ENVIRONMENT and per surface: a test-mode key for dev/CI, live keys only in prod, publishable keys (the client-safe kind, like the client secret) distinct from secret keys — and SCOPED keys where the vendor offers them (a storage key that can only write one prefix). RATE LIMITS RUN ON THEIR SCHEDULE, NOT YOURS: quota windows reset hourly or daily at the VENDOR, your traffic spike does not wait for it, and per-key limits mean one noisy tenant can starve every other request — so know each integration's limit model (per second? per minute? burst?), surface the vendor's rate-limit headers in your metrics, and back off when told (the HTTP topic's 429/Retry-After is the client side of this same contract).`,
        },
        {
          kind: 'text',
          id: 'thirdparty-keys-quotas-blast-radius:blast-radius',
          body: `A VENDOR OUTAGE MUST NOT TAKE YOU DOWN — the reliability topic, applied outward: every third-party call gets a TIMEOUT you chose (their hang is your held-open socket), retries only where idempotent, and a CIRCUIT BREAKER on anything where you'd rather fail fast than queue the world (the watchable breaker in that topic exists for exactly this); and DEGRADE GRACEFULLY where the feature allows — "email queued, will send when the provider returns" (the queue IS the degradation), "checkout temporarily unavailable" beats a 500 storm, "uploads paused" beats a hung progress bar. SANDBOX/TEST MODE FIRST, always: every serious vendor has one (Stripe test cards, S3 localstack/minio in CI, jsonTransport right here) — if your first live-key exercise is also your first end-to-end run, you are testing in production with money. AND THE STATUS-PAGE HABIT: bookmark status.stripe.com, health.aws.amazon.com, your mail provider's status — before you debug YOUR stack for an hour, check theirs (their RSS/webhooks can page you when THEY degrade, which halves your MTTR on the outages that aren't yours). The one-line summary of the whole topic: integrate like the vendor will someday be down, expensive, or replaced — adapter at the seam, timeouts on the wire, test mode underneath, and the truth arriving by signed webhook.`,
        },
        {
          kind: 'code',
          id: 'thirdparty-keys-quotas-blast-radius:blast-radius-sketch',
          language: 'ts',
          caption:
            'Verbatim — one call through the breaker this app really runs (reliability_demo_routes.ts); vendor hygiene is the same shape with fetch underneath: a deadline (AbortSignal.timeout), the breaker around it, degradation when it opens',
          source: 'server/src/presentation/routes/reliability_demo_routes.ts',
          code: `// The shape every outbound vendor call deserves (reliability topic, outward):
//   a deadline (the breaker's 300ms — for a vendor, AbortSignal.timeout(2_000):
//   THEIR hang is YOUR held socket), the breaker you already own around it,
//   and degradation when it is OPEN — never silence.
const result = await breaker.execute((signal) => flaky.call(signal));

// …the response reports the verdict honestly:
//   outcome: 'success' | 'rejected-fast' | 'failure'
//   rejected-fast ≈ 0ms — the dependency was never touched (load shed)
//   timedOut: true — the deadline expired before the hop answered
// retries: only idempotent ops, only ONE layer, only with backoff+jitter —
// a timeout+immediate-retry loop is a self-inflicted DDoS with extra steps.
// When the breaker is OPEN: degrade — queue the email (jobs topic), gray the
// checkout button, and say so in the UI. Silence is the worst failure mode.`,
        },
      ],
    },
    {
      id: 'thirdparty-see-it-live',
      title: 'See it live',
      lead:
        'The hub: a real captured email, a Stripe-shaped mock payment, a real presigned upload — three panels, three levels of realness, each labeled.',
      blocks: [
        {
          kind: 'text',
          id: 'thirdparty-see-it-live:what-you-see',
          body: `THREE PANELS, THREE LEVELS OF REALNESS, LABELED: EMAIL is the real thing — POST /api/demo/email/send goes through the REAL nodemailer adapter (jsonTransport), and the outbox below shows what was captured: messageId, recipients, and the exact JSON nodemailer produced. Nothing was sent anywhere; swap one createTransport() call and it would be. PAYMENTS is the labeled mock — create an intent ($19.99 by default), watch the client secret and the requires_confirmation status, then CONFIRM with the 4242 test card (succeeded + receipt, the shapes a payment_intent.succeeded webhook delivers) or the declined card (status falls back to requires_payment_method with last_payment_error carrying code and decline_code — Stripe's real field names). STORAGE is a real signing flow — presign mints the HMAC token (filename, content type, 300s expiry), then the upload button PUTs a payload through the presigned URL: signature verified, expiry checked, and the file lands in the files topic's REAL store, fetchable at its raw endpoint. Only the bucket is imaginary — the content above says so, and so does every response's note field. Or drive it with curl:`,
        },
        {
          kind: 'code',
          id: 'thirdparty-see-it-live:curl',
          language: 'bash',
          caption: 'The whole hub over curl — email, payment, presigned upload',
          code: `# EMAIL — the real adapter; the outbox holds the captured JSON:
curl -s -X POST localhost:4000/api/demo/email/send \\
  -H 'content-type: application/json' \\
  -d '{"to":"student@example.com","subject":"Welcome","text":"Chapter 1 is live."}' \\
  && curl -s localhost:4000/api/demo/email/outbox | python3 -m json.tool | head -20

# PAYMENTS — the Stripe-shaped mock: intent → confirm with each test card:
curl -s -X POST localhost:4000/api/demo/payments/intent \\
  -H 'content-type: application/json' -d '{"amountCents":1999,"currency":"usd"}'
curl -s -X POST localhost:4000/api/demo/payments/confirm \\
  -H 'content-type: application/json' \\
  -d '{"paymentIntentId":"pi_mock_0001","card":"4242"}'   # or "declined"

# STORAGE — the real ceremony: presign, then upload through the grant:
URL=$(curl -s -X POST localhost:4000/api/demo/storage/presign \\
  -H 'content-type: application/json' \\
  -d '{"filename":"hello.txt","contentType":"text/plain"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["uploadUrl"])')
curl -s -X POST "localhost:4000$URL" -H 'content-type: text/plain' \\
  -d 'presigned bytes — straight into the real store'`,
        },
        {
          kind: 'demo',
          id: 'thirdparty-see-it-live:demo',
          demoId: 'thirdparty:hub',
          title: 'The integration hub',
          description:
            'Email: the real nodemailer jsonTransport adapter — send and watch the outbox of captured messages (never sent, never any network). Payments: a clearly-labeled Stripe-shaped mock — PaymentIntent lifecycle, client secret, 4242-success and decline outcomes with Stripe\u2019s real field names. Storage: a real HMAC presign ceremony — signed grant, expiry countdown, upload into the files topic\u2019s real store.',
        },
      ],
    },
  ],
};
