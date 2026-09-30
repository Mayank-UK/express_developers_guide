import type { Topic } from '../types.js';

/**
 * The Webhooks topic: reversed APIs, event design, HMAC signing with the
 * raw-body lesson, sender obligations (retries, backoff, dead-lettering),
 * receiver obligations (fast 2xx, verify-first, idempotency), and the local
 * development story — concept-first, then the REAL flight simulator this app
 * serves (webhooks_demo_routes.ts), which plays both sender and receiver with
 * node:crypto HMACs over raw body bytes. Snippets marked verbatim are the
 * running source; illustrative sketches say so in their captions.
 */
export const topicWebhooks: Topic = {
  id: 'webhooks',
  title: 'Webhooks',
  subtitle:
    'Sending and receiving event callbacks safely: signatures, retries, and idempotency.',
  group: 'apis',
  order: 4,
  sections: [
    {
      id: 'webhooks-reversed',
      title: 'Webhooks are reversed APIs',
      lead: 'Everything you know about building an API server stays; what flips is who calls whom — and that single inversion quietly swaps your obligations, your failure modes, and your debugging story.',
      blocks: [
        {
          kind: 'text',
          id: 'webhooks-reversed:inversion',
          body: `A request-response API is PULL: the client decides WHEN, your server just answers. A webhook is PUSH: something happened in your system (a payment settled, a build finished, a post was created), and YOUR server now plays HTTP CLIENT — opening a connection to somebody else's URL and delivering the news as an HTTP request. The recipient's endpoint (their "webhook receiver") is the server in the conversation. That is the entire mechanism — no protocol, no library, just "I will POST JSON to the URL you registered" — and it is why webhooks are everywhere: they are the cheapest possible way to make two systems react to each other in near-real-time without polling.\n\nThe inversion swaps your obligations in ways that surprise request-mode thinking. YOU now care about THEIR availability: if their server 500s, the event still happened — you must retry, and you will learn exponential backoff and dead-letter queues the hard way. THEY cannot authenticate the way request-clients do (no API key in a login step): the request arrives from your servers at a URL they told you about, so proving "this really is Stripe calling" needs CRYPTOGRAPHY — the HMAC signatures this topic is largely about. THEIR endpoint is now PUBLIC attack surface answering unauthenticated traffic, and it must be ONLINE even when its own app is half-broken — hence the acknowledge-fast-then-process-async pattern. And DEBUGGING inverts: when a webhook "doesn't work", the evidence is on the RECEIVING side's logs (and, if you are a serious sender, on your per-delivery delivery log — Stripe's webhook dashboard exists precisely because senders own observability for flights they cannot step through). You have already used the pull version of this app's demo endpoints (you curl, the server answers); the flight simulator at the bottom runs the push version — this app's sender route constructs an event, signs it, and calls this app's own receiver route, so you watch both sides of one delivery.`,
        },
        {
          kind: 'code',
          id: 'webhooks-reversed:shape',
          language: 'txt',
          caption: 'One event, both directions of the table — who initiates, who serves, and what each side must get right',
          code: `request/response API (PULL)              webhook (PUSH)
---------------------------------------  ---------------------------------------
the CLIENT initiates                     the SENDER initiates (on an event)
your server serves; client consumes      your system is the HTTP CLIENT
client authenticates (API key/login)     receiver authenticates the SENDER (HMAC)
client cares about your uptime           you care about the RECEIVER's uptime
failure = one bad request, one answer    failure = event delivered? retried? lost?
debug on the caller side                 evidence on the receiver's logs (yours,
                                         if you are the sender, in your delivery log)
polling to learn "did it happen yet?"    the push IS the answer to that question

the wire is boring on purpose (this app's real flight):
POST /api/demo/webhooks/receive HTTP/1.1     ← sender → receiver
content-type: application/json
x-webhook-signature: 9f86d081884c7d65…      ← HMAC-SHA256 hex over the body bytes
x-webhook-timestamp: 1798848000              ← unix seconds, for replay windows

{"id":"…uuid…","type":"post.created","created":"2026-09-28T…","data":{ … }}`,
        },
      ],
    },
    {
      id: 'webhooks-design',
      title: 'Designing a webhook',
      lead: 'Three decisions age well or haunt you: event names that stay self-describing, payloads that are complete without a return trip, and delivery semantics the receiver can rely on blindly.',
      blocks: [
        {
          kind: 'text',
          id: 'webhooks-design:naming',
          body: `EVENT NAMES: resource.action, past tense — post.created, invoice.paid, build.finished. The resource first (it names the noun the event is about), the action second (what happened TO it), past tense because a webhook reports HISTORY — it is a fact, not a command (command-shaped names like post.create or CreatePostEvent seduce receivers into treating delivery as instruction, which breaks the moment you add a second consumer or replay old events). Avoid the laziness traps: a bare "update" event per table row (row-changed tells the receiver nothing about intent), and verb phrases that leak your internals (user_permissions_recalculation_queue_drained is your architecture, not their business). NAMING IS MIGRATION: once receivers filter on your type strings, renaming is a breaking API change — pick the grammar on day one and keep it boring.\n\nPAYLOAD SHAPE: an envelope plus data, complete without a return trip. The envelope this app sends (and the one to copy): id (a unique event id — the receiver's idempotency key and your support lookup), type (the name above), created (when the EVENT happened — not when it was delivered; retries make those differ by hours), and data (the resource snapshot or the changed subset). Two design rules inside that: send ENOUGH data that typical receivers need zero extra requests (the API-design topic's under-fetching lesson, worse here — every follow-up request happens inside their request handler), and document whether data is the FULL resource or a DELTA (Stripe sends full snapshots for most events, deltas for some — ambiguity here is the #1 source of receiver bugs). Version evolution rides the same additive rules as REST bodies: add fields freely, never rename or remove; when you must break, send a NEW event type (post.created.v2 or a separate version field you negotiate per endpoint) rather than mutating the old one's meaning.\n\nDELIVERY EXPECTATIONS you should publish and implement: AT-LEAST-ONCE delivery (you WILL occasionally deliver twice — retries race with success; receivers must be idempotent on event id, and the next section's receiver code does exactly that in miniature), no ordering guarantee across event types (post.created may arrive after post.updated for the same resource during retry storms — receivers key on version or timestamp, not arrival order), and a documented retry schedule with a final give-up (the sender section below: what happens when you stop trying).`,
        },
        {
          kind: 'code',
          id: 'webhooks-design:envelope',
          language: 'ts',
          caption: 'Verbatim — the event this app\'s sender route constructs (webhooks_demo_routes.ts): the envelope plus a data snapshot',
          source: 'server/src/presentation/routes/webhooks_demo_routes.ts',
          code: `const payload = {
  id: randomUUID(),                          // unique event id: idempotency key,
  type: eventType,                           // 'post.created' | 'post.updated' — resource.action
  created: new Date().toISOString(),         // when the EVENT happened (not delivery)
  data: {
    post: {                                  // the snapshot: enough to act without a
      title: 'Webhooks are reversed APIs',   //   follow-up GET; document snapshot-vs-delta
      author: 'the guide',
      ...(eventType === 'post.updated' ? { changed: ['title'] } : {}),
    },
  },
};
// Serialize ONCE; THIS string is what gets signed AND delivered — the same
// bytes on both sides is the entire trick the raw-body capture protects.
const body = JSON.stringify(payload);
// …and the signing line, exactly as the sender runs it (the tamper branch is
// the demo's deliberately WRONG secret — HMAC-SHA256 hex, next section):
const signature = tampered ? signWebhookBody(body, 'whsec_wrong_secret') : signWebhookBody(body);`,
        },
      ],
    },
    {
      id: 'webhooks-signing',
      title: 'Signing and verifying',
      lead: "The receiver's endpoint answers unauthenticated POSTs from the whole internet, so the proof must ride in the request. The industry answer is an HMAC over the exact body bytes — and 'exact bytes' is where every naive implementation quietly breaks.",
      blocks: [
        {
          kind: 'text',
          id: 'webhooks-signing:scheme',
          body: `THE SCHEME (Stripe's, GitHub's, Shopify's — cosmetic differences, same bones): when the receiver registers, both sides hold a SHARED SECRET (out-of-band — a settings page, an API response; never inside the event). The sender computes HMAC-SHA256(secret, rawBodyBytes), hex-encodes it, ships it in a header (x-webhook-signature here; Stripe signs a timestamp+body composite in stripe-signature, GitHub ships hex in x-hub-signature-256). The receiver computes the same digest over the bytes it received and compares — if they match, the sender knew the secret AND the body arrived unmodified. Two refinements matter. TIMESTAMPS: a valid signature over an OLD body proves nothing — captured requests can be replayed verbatim forever — so the sender stamps x-webhook-timestamp (unix seconds) and the receiver rejects anything outside a window (5 minutes here; Stripe embeds the timestamp INSIDE the signed payload so it cannot be swapped). CONSTANT-TIME COMPARISON: comparing digests with === leaks how many leading bytes matched, byte by byte, through response timing — node:crypto's timingSafeEqual exists for exactly this, and it wants equal-length buffers, so guard the length first.\n\nWHY THE RAW BODY — the lesson this app's implementation exists to teach: JSON.parse then JSON.stringify does NOT reproduce the bytes you received. Key order CAN shift (in practice V8 preserves parse order — until a numeric-ish key, a spread, or a re-serialization by another language's library is involved), spacing is gone, escaping normalizes (\\u0041 vs A), numbers round-trip through float formatting. The signature was computed over the ORIGINAL bytes; your re-serialization is a DIFFERENT document that happens to parse to the same value — and HMAC is over bytes, not values, so verification fails for every sender whose serializer differs from yours in any particular. The fix is to capture the buffer BEFORE or DURING parsing: express.json()'s verify hook hands you the raw buffer pre-parse (this app's whole root parser exists for this — quoted below), the same reason Stripe's Node examples mount a dedicated parser on the webhook route. The receiver code checks, in order: signature present → HMAC matches → timestamp fresh → only then touch req.body as data.`,
        },
        {
          kind: 'code',
          id: 'webhooks-signing:verbatim',
          language: 'ts',
          caption: 'Verbatim — sign, compare constant-time, and capture the raw body (webhooks_demo_routes.ts + the root parser it installs in app.ts)',
          source: 'server/src/presentation/routes/webhooks_demo_routes.ts',
          code: `// The sender's whole signing ceremony is one expression:
export function signWebhookBody(body: string | Buffer, secret: string = WEBHOOK_DEMO_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// The receiver's comparison — constant-time, length-guarded (hex decode of
// garbage yields a short buffer):
export function webhookSignatureMatches(
  rawBody: string | Buffer,
  provided: string,
  secret: string = WEBHOOK_DEMO_SECRET,
): boolean {
  const expected = Buffer.from(signWebhookBody(rawBody, secret), 'hex');
  const received = Buffer.from(provided, 'hex');            // invalid hex → short/empty
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// THE RAW-BODY CAPTURE — body-parser's verify hook runs with the buffer
// BEFORE parsing; mounted as the app's root json parser (app.ts), path-gated
// so only the webhook route pays for it (limit pinned at the default — every
// byte under it is HMAC material here):
export const webhookJsonBodyParser = json({
  limit: '100kb',
  verify: (req, _res, buf) => {
    const request = req as typeof req & { rawBody?: Buffer; originalUrl?: string };
    const path = (request.originalUrl ?? '').split('?')[0];
    if (request.method === 'POST' && path === WEBHOOK_RECEIVE_PATH) {
      request.rawBody = buf;   // the EXACT bytes — never reconstruct them
    }
  },
});

// And the receiver's freshness gate (replay protection):
const rawTimestamp = req.get(WEBHOOK_TIMESTAMP_HEADER);
const timestamp = rawTimestamp !== undefined ? Number(rawTimestamp) : Number.NaN;
if (!Number.isFinite(timestamp) || !/^\\d+$/.test(rawTimestamp ?? '')) {
  throw new UnauthorizedException(
    'webhook rejected: x-webhook-timestamp must be unix seconds',
    { reason: 'malformed_timestamp' },
  );
}
const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
if (skewSeconds > WEBHOOK_MAX_SKEW_SECONDS) {               // 300 here
  throw new UnauthorizedException(
    \`webhook rejected: stale timestamp (\${String(skewSeconds)}s old, window is \${String(WEBHOOK_MAX_SKEW_SECONDS)}s) — replay protection\`,
    { reason: 'stale_timestamp', skewSeconds, maxSkewSeconds: WEBHOOK_MAX_SKEW_SECONDS },
  );
}`,
        },
      ],
    },
    {
      id: 'webhooks-delivering',
      title: 'Delivering: retries, backoff, dead-lettering',
      lead: 'You are now the client of someone else\'s flaky endpoint. The sender\'s obligations are a reliability checklist: bounded retries with exponential backoff and jitter, a dead-letter resting place, and per-delivery observability.',
      blocks: [
        {
          kind: 'text',
          id: 'webhooks-delivering:obligations',
          body: `The event already happened — that is the sender\'s fundamental bind: delivery is now a JOB you owe, not a request you serve. The checklist: RETRY ON FAILURE — any 5xx, any timeout, any connection reset means "try again later"; 4xx means "this delivery is malformed for THIS receiver" and retrying is usually pointless (one exception worth coding: 429 with a Retry-After header is "later, they said when"). EXPONENTIAL BACKOFF WITH JITTER — 1s, 2s, 4s, 8s… capped (say 1h), each delay PLUS random jitter (0-100% of it): exponential alone synchronizes every failed delivery into thundering reconvergences on the receiver's first good second (your 10,000 failed webhooks all become due at 09:00:00 sharp), and jitter is the de-synchronization trick — the same idea the reliability-patterns topic applies to any retry loop. BOUNDED GIVE-UP — after N attempts (Stripe: up to 3 days), STOP, because infinite retry is a self-inflicted queue that never drains. DEAD-LETTER the give-ups: persist the event, the endpoint, the final error, and every attempt's outcome somewhere queryable (a dead_letter_deliveries table is plenty), because "we gave up" must be discoverable — by you, in a dashboard, before it is discovered by the customer whose integration has been silently dead for a week. OBSERVABILITY PER DELIVERY: log every attempt (endpoint, event id, status, latency, next retry at) and expose it — receivers debug through YOUR delivery log when their handler has a bug, and "check the webhook site" is the standard support move. And two receiver-facing courtesies: send a meaningful USER-AGENT and identifiable sender (an API prefix, a dedicated egress IP range you publish — receivers firewall to it), and honor Retry-After/429 politeness.\n\nThis app's sender is a teaching reduction — ONE attempt, no retry loop — but it keeps the observability obligation honestly: the send endpoint returns the exact flight (URL, headers, body bytes, computed signature) plus the receiver's outcome, and the demo renders that per-delivery record, which is precisely the shape a production delivery log row takes.`,
        },
        {
          kind: 'code',
          id: 'webhooks-delivering:sketch',
          language: 'ts',
          caption: 'The retry spine as this repo really runs it (domain/jobs/job_queue.ts — the background-jobs topic\'s queue; a webhook sender owes exactly these bones: attempt budget, backoff with jitter, visible dead-letter). This app\'s demo sender intentionally fires once — see webhooks_demo_routes.ts for the real single-flight code',
          source: 'server/src/domain/jobs/job_queue.ts',
          code: `// After a failed attempt: retry with backoff, or dead-letter — visibly.
// (Real lines from the queue's worker loop; swap "job" for "delivery" and
// this IS a webhook sender's spine:)
    } else {
      job.attempts += 1;
      job.lastError = outcome.error;
      if (job.attempts < this.maxAttempts) {
        const delayMs = this.backoffDelayMs(job.attempts);
        const runAtMs = this.now() + delayMs;
        job.status = 'queued';
        due.runAtMs = runAtMs;
        job.runAt = this.isoFromMs(runAtMs);
        job.history.push({
          at: this.isoNow(),
          event: 'retry_scheduled',   // observability FIRST: every attempt logged
          attempt: job.attempts,
          delayMs,
        });
      } else {
        job.status = 'dead';          // give up, visibly — the dead-letter state
        job.history.push({
          at: this.isoNow(),
          event: 'dead_lettered',
          attempt: job.attempts,
          lastError: outcome.error,   // "we gave up" must be discoverable
        });
      }
    }

// The schedule underneath: exponential backoff WITH jitter:
  private backoffDelayMs(attempt: number): number {
    const raw = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = raw * JITTER_FRACTION * (Math.random() * 2 - 1);
    return Math.max(1, Math.round(raw + jitter));
  }
// (A production webhook sender caps the schedule — 1s, 2s, 4s… up to ~1h —
// and honors 429 Retry-After; the queue's DEMO_BASE_DELAY_MS is 300ms only
// so the live demo shows a full cycle in about a second.)`,
        },
      ],
    },
    {
      id: 'webhooks-receiving',
      title: 'Receiving: fast 2xx, verify, process async',
      lead: "Your webhook endpoint is an unauthenticated, internet-facing function that must stay responsive while its own dependencies burn. The pattern that survives that sentence has three beats — and the idempotency one is not optional.",
      blocks: [
        {
          kind: 'text',
          id: 'webhooks-receiving:pattern',
          body: `Beat one: ACKNOWLEDGE FAST. The sender's timeout is short (Stripe: ~15s, and many senders far less) and what it wants is a 2xx ANY 2xx that says "received", not "processed" — that is exactly what 202 Accepted means, and answering it BEFORE heavy work is the whole trick. Do work past the acknowledgement asynchronously: enqueue (a background-jobs topic queue, or at minimum a fire-and-forget promise with error logging — the honest floor). Slow receivers get their webhooks disabled: senders mark chronically-timing-out endpoints as failing and eventually dead-letter them, so a handler that calls four APIs inline is an integration that eventually stops receiving anything. Beat two: VERIFY BEFORE PROCESSING — the signature check (and the timestamp window) happens before the payload is treated as anything but bytes: not "verify eventually", not "verify in the async part" — FIRST, because everything downstream (your database writes, your handler's business logic) must be able to assume the event is genuine. An unverified webhook is an unauthenticated API call wearing a POST body; this app's receiver stores deliveries with signatureVerified: true only because verification already passed when the store write happens. Beat three: IDEMPOTENCY — at-least-once delivery MEANS duplicates will arrive (a retry races your 200; the sender's timeout fires while your handler succeeded). Deduplicate on the event id: a unique index on event_id in your webhook_events table, INSERT ... ON CONFLICT DO NOTHING, and a repeated id becomes a no-op 202 instead of a double-charged customer. The same discipline extends to ORDER: with retries in flight, post.updated can beat post.created — key writes on the event's created timestamp or a version, never on arrival order.\n\nThe failure surface to know: your receiver will be probed by scanners (wrong paths, junk bodies — that is why the verify-first order costs nothing: junk fails the signature and never reaches your logic), and it must be UP even when the app behind it is degraded — which is the strongest argument for the queue: the receiver's only job becomes "verify, dedupe, enqueue, 202", and every one of those verbs is local and fast.`,
        },
        {
          kind: 'code',
          id: 'webhooks-receiving:verbatim',
          language: 'ts',
          caption: 'Verbatim — this app\'s receiver in order of operations (webhooks_demo_routes.ts): capture check, verify-first, freshness, then store-and-202',
          source: 'server/src/presentation/routes/webhooks_demo_routes.ts',
          code: `function receiveController(req: Request, res: Response): void {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!(rawBody instanceof Buffer)) {          // verify needs the exact bytes
    throw new ValidationException(
      'webhook receiver expects application/json (the signature is computed over the raw body bytes)',
      { reason: 'wrong_content_type' },
    );
  }

  const providedSignature = req.get(WEBHOOK_SIGNATURE_HEADER);
  if (providedSignature === undefined || providedSignature === '') {
    throw new UnauthorizedException('webhook rejected: signature header missing', {
      reason: 'missing_signature',             // 1. verify BEFORE processing —
    });
  }
  if (!webhookSignatureMatches(rawBody, providedSignature)) {
    throw new UnauthorizedException('webhook rejected: signature did not match the raw body bytes', {
      reason: 'invalid_signature',             //    junk never reaches logic
    });
  }

  // 2. freshness — a valid signature over an OLD body is still an attack
  const rawTimestamp = req.get(WEBHOOK_TIMESTAMP_HEADER);
  const timestamp = rawTimestamp !== undefined ? Number(rawTimestamp) : Number.NaN;
  if (!Number.isFinite(timestamp) || !/^\\d+$/.test(rawTimestamp ?? '')) {
    throw new UnauthorizedException(
      'webhook rejected: x-webhook-timestamp must be unix seconds',
      { reason: 'malformed_timestamp' },
    );
  }
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (skewSeconds > WEBHOOK_MAX_SKEW_SECONDS) {
    throw new UnauthorizedException(
      \`webhook rejected: stale timestamp (\${String(skewSeconds)}s old, window is \${String(WEBHOOK_MAX_SKEW_SECONDS)}s) — replay protection\`,
      { reason: 'stale_timestamp', skewSeconds, maxSkewSeconds: WEBHOOK_MAX_SKEW_SECONDS },
    );
  }

  // 3. store now, process "later" — a real receiver enqueues; the 202 below
  //    is the honest contract: accepted-for-processing, not processed.
  const payload: unknown = req.body;
  // …the event's type is read out of the payload (gap)…
  const delivery = storeDelivery(type, payload);        // signatureVerified: true
  res.status(202).json({
    accepted: true,
    deliveryId: delivery.id,
    receivedAt: delivery.receivedAt,
    note: 'signature verified + delivery stored; 202 Accepted means "queued", not "processed" — the receiver pattern.',
  });
}
// Production idempotency, one line of SQL away (illustrative):
//   INSERT INTO webhook_events (event_id, payload) VALUES ($1, $2)
//   ON CONFLICT (event_id) DO NOTHING;  -- a duplicate delivery no-ops`,
        },
      ],
    },
    {
      id: 'webhooks-local',
      title: 'The local development story',
      lead: 'A sender on your laptop needs to reach a receiver on someone else\'s, and a receiver on your laptop is unreachable from the internet. The ecosystem\'s answer is a small toolbox of tunnels, echo endpoints, and replay.',
      blocks: [
        {
          kind: 'text',
          id: 'webhooks-local:toolbox',
          body: `THE PROBLEM: webhooks are delivered TO a URL, and a localhost address is not one the internet can find. When you are RECEIVING (integrating Stripe into a local dev server), the sender must be able to reach you. THE TUNNEL: a localtunnel/stripe-cli/ngrok-style service gives your laptop a temporary public HTTPS URL that forwards to a local port — register that URL as the endpoint, and production-shaped traffic (right down to TLS) arrives at your dev server; the stripe-cli tunnel additionally logs and FORWARDS events, which doubles as the replay tool below. WHEN YOU ARE SENDING, the same trick in reverse plus the ECHO ENDPOINT: webhook.site and requestbin-style pages give you a throwaway URL that renders everything that hits it — headers, raw body, your signature header — so you can eyeball your sender's flights without writing a receiver at all (the fastest way to answer "is my HMAC even right?"). THE REPLAY TOOLS: serious senders keep delivery logs and expose "resend" (Stripe's dashboard and CLI: stripe events resend evt_…) — when a receiver's bug is fixed, replaying real historical events is the honest integration test, and it is also why your receiver's idempotency cannot be optional: a replay button is a deliberate duplicate. LOCAL-FIRST ALTERNATIVE: point your sender's endpoint config at a local receiver on another port (or the same process — exactly what this app does: the sender and receiver are two routes on one server, and the send endpoint self-calls over real HTTP), with the shared secret in both sides' .env files; you get the full protocol minus the internet. The last local-dev habit worth forming: make your receiver's rejection REASONS visible (this app's 401 envelope carries reason: invalid_signature / stale_timestamp / missing_signature) — when you are your own sender, the reason string is the difference between a five-second fix and an afternoon of hex dumps.`,
        },
        {
          kind: 'code',
          id: 'webhooks-local:workflow',
          language: 'bash',
          caption: 'The local loop this app runs — sender and receiver are two routes on one server; curl plays either side',
          code: `# boot the guide (server listens on :4000), then:

# 1. the sender delivers a REAL signed event to our own receiver over HTTP:
curl -s -X POST localhost:4000/api/demo/webhooks/send | jq
# → { event: {…}, signature: "be686a…", wouldDeliver: { url, headers, body },
#     delivered: true, outcome: { status: 202, body: "…" } }

# 2. the tampered twin — same event, WRONG secret; watch the 401:
curl -s -X POST 'localhost:4000/api/demo/webhooks/send?tamper=1' | jq '.outcome.status'
# → 401

# 3. play receiver yourself — this is what the sender computes, byte for byte:
BODY='{"id":"evt_manual","type":"post.created","created":"2026-09-28T12:00:00Z","data":{}}'
SIG=$(node -e "const{createHmac}=require('node:crypto');
  console.log(createHmac('sha256','whsec_teaching_demo').update(process.argv[1]).digest('hex'))" "$BODY")
curl -si -X POST localhost:4000/api/demo/webhooks/receive \\
  -H 'content-type: application/json' \\
  -H "x-webhook-signature: $SIG" \\
  -H "x-webhook-timestamp: $(date +%s)" \\
  -d "$BODY"          # → HTTP/1.1 202 Accepted

# 4. and the inbox the receiver kept (newest first, tampered flights absent):
curl -s localhost:4000/api/demo/webhooks/deliveries | jq '.deliveries[0]'

# for real third-party senders, the same loop runs through a tunnel instead:
#   stripe listen --forward-to localhost:4000/api/webhooks/stripe
#   npx localtunnel --port 4000        # or webhook.site as the echo receiver`,
        },
      ],
    },
    {
      id: 'webhooks-live',
      title: 'See it live',
      lead: 'The flight simulator: one app playing sender and receiver — build an event, sign it, deliver it, verify it, store it. Both sides of one webhook, in two panels.',
      blocks: [
        {
          kind: 'text',
          id: 'webhooks-live:intro',
          body: `The simulator is both roles of this topic on one screen. The SENDER panel (left) builds a real event — pick post.created or post.updated, flip the tamper switch, and SEND: the POST /api/demo/webhooks/send route serializes the event once, computes the HMAC-SHA256 over those exact bytes with node:crypto, and — when the guide's server is really listening — self-calls the receiver route over genuine HTTP. The flight renders in full: the event envelope, the hex signature, and the exact HTTP request (URL, headers, body) that flew — the per-delivery observability the sender-obligations section demanded, in miniature. The RECEIVER panel (right) is the inbox: every verified delivery the receiver accepted and stored (type, arrival time, a signature-verified badge, the payload), refreshed after each send. Flip the tamper switch to watch the dark path: the sender signs with the WRONG secret, the receiver's constant-time comparison fails, the flight comes back 401 with reason invalid_signature — and the inbox does NOT grow, because verification happens before storage, exactly as the receiver rules require. The curl block above replays every path from a terminal, including playing the sender by hand: compute the HMAC yourself, deliver it yourself, and watch the receiver accept exactly what you signed.`,
        },
        {
          kind: 'demo',
          id: 'webhooks-live:simulator-demo',
          demoId: 'api:webhook-simulator',
          title: 'The webhook flight simulator',
          description:
            'Sender and receiver on one screen: send post.created / post.updated events (or a tampered, wrongly-signed one), watch the exact flight — event, HMAC signature, headers, body — and the receiver\'s inbox grow with verified deliveries; tampered attempts come back 401 and never reach the inbox.',
        },
      ],
    },
  ],
};
