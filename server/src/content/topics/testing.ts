import type { Topic } from '../types.js';

/**
 * The Testing topic — taught from this app's OWN suite. Every quoted spec is
 * a real file in this repo; the proportions, the fakes, the env-gated live
 * specs, and the client fetch stub are all things this codebase actually
 * does. The demo at the end runs a curated twelve-case suite against this
 * app's pure modules on every request — a real runner, in the running app.
 */
export const topicTesting: Topic = {
  id: 'testing',
  title: 'Testing',
  subtitle: 'Vitest and Supertest patterns, proven against this very codebase.',
  group: 'platform',
  order: 5,
  sections: [
    {
      id: 'testing-pyramid',
      title: 'The testing pyramid, honestly',
      lead:
        'The pyramid is a cost model, not a law. This app has ~500 server tests whose actual shape is worth more than any diagram.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-pyramid:layers',
          body: `THE MODEL. UNIT tests exercise one pure function or class in isolation — milliseconds each, no I/O, failures point at a line. INTEGRATION tests exercise a slice of the real stack mounted in-process — for an Express app that means the router plus middleware plus error handler, driven by Supertest without a network. E2E tests drive the deployed thing from outside — a browser against a real server, a real database, real everything. The pyramid says: MANY unit (cheap, precise), FEWER integration (middle cost, middle precision), FEWEST e2e (expensive, flaky, failures could be anywhere). WHY THE SHAPE IS A COST MODEL: an e2e failure gives you a symptom ("checkout returned 500") but not a location; a unit failure gives you the location but only if the bug lives where units can see it. The pyramid is really saying SPEND YOUR DEBUGGING BUDGET where each test type buys the most information per millisecond of runtime. THIS APP'S ACTUAL MIX (no idealization — go count): PURE UNIT SPECS sit beside their modules — result/guards/exceptions in core, negotiate in domain/i18n, job_queue's fake-clock suite, jwt_service's token cases (they live in the auth spec's unit block), the fake post repository, the chat hub. HTTP INTEGRATION SPECS drive every demo route through createApp() with Supertest — status, body, headers, envelope shape. LIVE-SERVICE SPECS are the third layer this app actually has: the mongo and redis suites run in TWO worlds, gated by describe.skipIf on MONGO_TEST_URI / REDIS_TEST_URI — without the env var they assert the graceful-degradation path; with it (and a compose service up) they exercise a REAL mongo/redis over the wire. And CLIENT SPECS run the React components in jsdom against a URL-dispatching fetch stub. E2E, in the browser-automation sense, went longest without a home here — the section at the bottom of this topic now closes that gap with a small, host-run Playwright suite: with a presentation-only client and a Supertest-covered API, what it buys is narrow but real — the rendered page and the proxy hop, the two things no in-process test can see; the day the client grows logic of its own, that calculus changes.`,
        },
        {
          kind: 'code',
          id: 'testing-pyramid:live-gating',
          language: 'ts',
          caption:
            'Verbatim — the two-world pattern: the same file proves the OFF path by default and the LIVE path when you opt in (presentation/routes/mongo_demo_routes.spec.ts)',
          source: 'server/src/presentation/routes/mongo_demo_routes.spec.ts',
          code: `describe.skipIf(process.env.MONGO_TEST_URI !== undefined)(
  'mongo demo with the feature OFF (the default suite world)',
  () => {
    it('status answers instantly: configured false, feature off, no attempt burned', async () => {
      const started = Date.now();
      const res = await request(createApp()).get(\`\${MOUNT}/status\`);

      expect(res.status).toBe(200);
      // The off path answers without touching mongoose: anything close to the
      // 1.5s server-selection timeout would prove a connection was attempted.
      expect(Date.now() - started).toBeLessThan(1000);
      // …and the mirrored describe.skipIf(!MONGO_TEST_URI) block runs the same
      // file's cases against a REAL compose mongo when you opt in.`,
        },
        {
          kind: 'text',
          id: 'testing-pyramid:cost-benefit',
          body: `COST/BENEFIT PER LAYER, as this repo experiences it. A unit spec costs ~1–5ms and pinpoints a broken contract; its blind spot is WIRING — the function can be perfect while the route that calls it is mounted at the wrong path. A Supertest integration spec costs ~2–20ms (still no socket — Supertest calls the app's handler directly), and its superpower here is proving the ERROR ENVELOPE: that a validation failure in a controller arrives at the client as exactly { code: 'validation_failed', parameter: 'limit' } with a matching x-request-id header. That assertion spans middleware, the failure taxonomy, and the serializer — no unit test could buy it. The live-service specs cost seconds and REQUIRE docker compose up — which is exactly why they are opt-in: the suite a refactor loop runs stays fast and hermetic, and the CI job (or the motivated human) that sets the env var gets the real-wire proof. THE LESSON TO KEEP: choose the layer that can SEE the behavior you are pinning. A JSON response shape is an integration fact. A backoff formula is a unit fact. "mongo actually deleted the document" is a live-service fact — and only that third suite can prove it, so it lives behind the env flag, not in a mock that would just echo your assumptions back at you.`,
        },
      ],
    },
    {
      id: 'testing-unit',
      title: 'Unit tests: arrange, act, assert',
      lead:
        'Pure functions are the sweet spot, and this codebase is built to have many of them — Result types and injected clocks exist partly to make testing trivial.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-unit:aaa',
          body: `ARRANGE–ACT–ASSERT. Every unit test is three beats: build the inputs (arrange), call the thing (act), check the ONE behavior (assert). The discipline that matters most is the last one: ONE ASSERTION CONCEPT PER TEST. Not literally one expect() call — a case may pin several FIELDS of one outcome (the locale AND the matchedVia below are one concept: "how it matched") — but never two CONCEPTS ("it matches AND it never throws" is two tests). Why: when a many-concept test fails, the name tells you nothing; when a one-concept test fails, the name IS the diagnosis. TEST NAMES AS BEHAVIOR STATEMENTS — read this repo's spec files as a list and you get a requirements document: "exact: a supported tag matches itself, case-insensitively"; "a tampered payload (signature untouched) → signature_mismatch"; "the wildcard serves the default only after every named range". If your test names read like "test 3 works" or "negotiate test 2", you have thrown away the cheapest documentation you will ever write. THE SWEET SPOT IS A PURE FUNCTION: same input, same output, no clock, no network, no global. This app leans on TWO architectural habits that manufacture sweet spots on purpose — (1) RESULT TYPES instead of exceptions for expected failures (verifyJwt RETURNS { ok: false, error }, so a test asserts on a value; nothing to catch, no control-flow surprise), and (2) INJECTED DEPENDENCIES (the JobQueue takes its clock and timers as constructor options — the awkward-bits section below shows what that buys).`,
        },
        {
          kind: 'code',
          id: 'testing-unit:verbatim-negotiate',
          language: 'ts',
          caption:
            'Verbatim — one concept per test, names as behavior statements (domain/i18n/negotiate.spec.ts)',
          source: 'server/src/domain/i18n/negotiate.spec.ts',
          code: `it('exact: a supported tag matches itself, case-insensitively', () => {
  const result = negotiateLocale('JA', SUPPORTED, DEFAULT_LOCALE);
  expect(result.locale).toBe('ja');
  expect(result.matchedVia).toBe('exact');
});

it('wildcard: matches the default locale — but only after every named range', () => {
  // Named preference outranks a higher-q wildcard (the classic bug):
  const shadowed = negotiateLocale('*;q=1,de;q=0.5', SUPPORTED, DEFAULT_LOCALE);
  expect(shadowed.locale).toBe('de');
  expect(shadowed.matchedVia).toBe('exact');
  // …`,
        },
        {
          kind: 'text',
          id: 'testing-unit:fakes-mocks-stubs',
          body: `FAKES vs MOCKS vs STUBS — the vocabulary, because interviewers ask and because using the right one makes tests better. A STUB answers calls with canned values ("return false once" — the files topic's backpressure sink) and its assertion is on the CODE UNDER TEST. A FAKE is a working lightweight implementation (an in-memory Map where production uses redis; this repo's fake_post_repository with the shared seed) — you can assert on its STATE afterwards, which is why fakes dominate this codebase: they exercise real logic instead of recorded scripts. A MOCK is an EXPECTATION with teeth — "this function must be called exactly twice with these args" — and it is the one to use sparingly, because every mock COUPLES the test to the call shape rather than the outcome: refactor the internals and the mock fails even when behavior is intact. THIS REPO'S ACTUAL TOOLING IS DELIBERATELY MINIMAL: no sinon, no jest-mock machinery in the server — hand-built fakes (the timer host below, the fake repositories, the throwaway :memory: sqlite handle) plus vitest's vi.stubGlobal for exactly one border: the NETWORK (the webhooks spec stubs global fetch to simulate an unreachable target — you cannot hermetically test a real ECONNREFUSED). The client's fetch_stub.ts (next sections) is the same decision on the other side of the wire. When a fake grows behavior of its own (the FakeTimerHost's advance loop), that logic deserves the same care as production code — it is quoted in the awkward-bits section because it IS the test's engine.`,
        },
        {
          kind: 'code',
          id: 'testing-unit:verbatim-jwt',
          language: 'ts',
          caption:
            'Verbatim — a Result type makes the failure a VALUE you assert on (the jwt unit block in presentation/routes/auth_demo_routes.spec.ts)',
          source: 'server/src/presentation/routes/auth_demo_routes.spec.ts',
          code: `it('sign/verify roundtrip: three base64url segments, HS256 header, claims intact', () => {
  const signed = signJwt('alice', ['admin'], 300);

  expect(signed.token.split('.')).toHaveLength(3);
  expect(signed.header).toEqual({ alg: 'HS256', typ: 'JWT' });
  expect(signed.payload).toMatchObject({ sub: 'alice', roles: ['admin'] });
  expect(signed.payload.exp - signed.payload.iat).toBe(300);
  expect(signed.payload.jti).toMatch(/^[0-9a-f]{32}$/);

  const verified = verifyJwt(signed.token);
  expect(verified.ok).toBe(true);
  if (verified.ok) {
    expect(verified.value.payload.sub).toBe('alice');
    expect(verified.value.payload.roles).toEqual(['admin']);
  }
});`,
        },
      ],
    },
    {
      id: 'testing-http-integration',
      title: 'HTTP integration tests with Supertest',
      lead:
        'The pattern that makes every route spec in this repo possible: an app that has never bound a port.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-http-integration:createapp',
          body: `THE PATTERN: createApp(), NOT A LISTENER. This app's src/app.ts builds the entire Express instance — middleware chain, routers, error handler — and binds NOTHING. src/server.ts owns the listening socket and the process lifecycle (signals, drains, the gRPC start). That split is what makes Supertest specs possible and fast: request(createApp()).get(path) hands the request DIRECTLY to the app's handler — no port, no socket, no network stack — yet it traverses the real request-id middleware, the real logger, helmet, the body parser, the router, and the error handler. ONE DEGREE OF DISHONESTY to know about: the request never touches TCP, so anything that lives at the socket layer (actual chunked write timing, aborted-connection edge cases) is invisible to Supertest — which is exactly why the SSE spec (below) boots a REAL http.Server on an ephemeral port for its streaming cases, and why the webhooks sender stubs fetch instead of self-calling. ASSERT EVERYTHING THE CONTRACT HAS: status, body, and HEADERS — this repo's route specs routinely pin x-request-id, Set-Cookie attributes, Content-Range, and Vary, because those ARE the HTTP contract, not decoration. The envelope specs go one step further and pin the ERROR SHAPE — a validation failure must arrive as the canonical envelope with a requestId that matches the response header, an assertion that keeps the whole error taxonomy from drifting.`,
        },
        {
          kind: 'code',
          id: 'testing-http-integration:verbatim-app-comment',
          language: 'ts',
          caption: 'Verbatim — the load-bearing comment (src/app.ts)',
          source: 'server/src/app.ts',
          code: `/**
 * Builds the Express app without binding a port, so Supertest can exercise it
 * and server.ts owns the listening socket / lifecycle.
 */`,
        },
        {
          kind: 'code',
          id: 'testing-http-integration:verbatim-envelope',
          language: 'ts',
          caption:
            'Verbatim — the envelope-shape spec: status + body + header agreement in one integration fact (presentation/routes/posts_routes.spec.ts)',
          source: 'server/src/presentation/routes/posts_routes.spec.ts',
          code: `it('maps failure injection onto the 503 error envelope', async () => {
  const toggle = await request(createApp())
    .patch('/api/demo/scenario')
    .send({ injectFailure: true });

  expect(toggle.status).toBe(200);
  expect(toggle.body).toEqual({ dataMode: 'fake', injectFailure: true });

  const res = await request(createApp()).get('/api/posts');

  expect(res.status).toBe(503);
  expect(res.body.error).toEqual({
    code: 'service_unavailable',
    message: 'Failure injection is ON — this is the demo 503',
    requestId: expect.stringMatching(UUID_RE),
  });
  expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
});`,
        },
        {
          kind: 'text',
          id: 'testing-http-integration:cookies-and-streams',
          body: `COOKIE REPLAY — the auth spec's parse-then-replay helper. Cookie-based auth needs the test to do what the BROWSER does: capture the Set-Cookie from login, then present the cookie pair on the next request. Superagent (Supertest's engine) reports one Set-Cookie as a string and several as an ARRAY, attributes may appear in any order, and the value is URI-encoded — so the spec has a helper that normalizes all of that, and every session test replays its token through it. THE QUOTE below is the whole helper; note the expect() calls inside it — a helper that validates its own inputs turns a silent mis-parse into a loud test failure. STREAMING RESPONSES need a different engine: SSE never ends, so await-ing the response is impossible — the realtime spec boots a REAL http.Server on port 0 and consumes the stream with fetch + a ReadableStream reader, aborting via AbortController once enough frames arrived. That is the honest boundary from the section above, crossed deliberately: Supertest for everything bounded, a real socket when the CONTRACT is the stream itself.`,
        },
        {
          kind: 'code',
          id: 'testing-http-integration:verbatim-cookie-helper',
          language: 'ts',
          caption:
            'Verbatim — the Set-Cookie parse helper every session spec replays through (presentation/routes/auth_demo_routes.spec.ts)',
          source: 'server/src/presentation/routes/auth_demo_routes.spec.ts',
          code: `/**
 * Robust Set-Cookie extraction: superagent reports one Set-Cookie as a string
 * and several as an array, attributes may appear in any order after the ';'
 * separators, and the value itself is URI-encoded — so parse the FIRST pair
 * before the first ';' and split on the FIRST '=' only.
 */
function sessionTokenFromResponse(res: request.Response): string {
  const raw: string | string[] | undefined = res.headers['set-cookie'];
  expect(raw).toBeDefined();
  const header = (Array.isArray(raw) ? raw[0] : raw) as string;
  expect(header).toContain('guide_session=');
  const pair = header.split(';')[0].trim();
  const equalsAt = pair.indexOf('=');
  return decodeURIComponent(pair.slice(equalsAt + 1));
}`,
        },
        {
          kind: 'code',
          id: 'testing-http-integration:verbatim-sse-server',
          language: 'ts',
          caption:
            'Verbatim — when the contract is the stream, boot a real socket (presentation/routes/sse_demo_routes.spec.ts)',
          source: 'server/src/presentation/routes/sse_demo_routes.spec.ts',
          code: `/**
 * SSE is a never-ending response, which supertest cannot await — so the
 * streaming cases boot a REAL http server on an ephemeral port and consume
 * the stream with fetch + a ReadableStream reader, aborting via
 * AbortController once enough frames arrived. The bounded endpoints
 * (ticker-status, chat-status, validation failures) ride plain supertest.
 */
beforeAll(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // …ephemeral port, real socket — then fetch + reader against \`\${baseUrl}\`…`,
        },
        {
          kind: 'demo',
          id: 'testing-http-integration:demo',
          demoId: 'testing:runner',
          title: 'The in-app test runner',
          description:
            'A real twelve-case suite executed against this app\u2019s own pure modules on every request — pass/fail chips, expected vs actual, module of origin, and an inject-a-failure knob proving the harness reports failures honestly.',
        },
      ],
    },
    {
      id: 'testing-awkward-bits',
      title: 'Testing the awkward bits',
      lead:
        'Time, randomness, the network, and native modules — the four things that make suites flaky, and the four patterns this repo uses to tame them.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-awkward-bits:time',
          body: `TIME — INJECT THE CLOCK. A test that sleeps is a test that is slow AND lying (real timers drift under load). The job queue's constructor takes now, setTimeoutFn, and clearTimeoutFn — so its spec drives a FAKE CLOCK: advance(ms) fires every due timer in scheduled order, deterministically, in microseconds. You can then assert "the retry fired at ~300ms" without ever waiting 300ms, and — the part real timers can never give you — assert that NO timer leaked (pendingCount === 0 proves the loop ran out of work). THE MICROTASK SUBTLETY in advance(): an async handler chain registers its NEXT timer synchronously at each await, so after firing a timer the host awaits setImmediate — draining the microtask queue — before selecting the next deadline. Without that line, the chain's follow-up timer registers AFTER the selection pass and the sequence stalls; with it, a 60-line host replaces a timing-sensitive integration test with an exact one. RANDOMNESS — ASSERT THE BOUNDS. The queue's backoff is base × 2^(n-1) ± 20% jitter, and the jitter is REAL (Math.random every run) — so the spec does not fight it, it PINS THE ENVELOPE: delayMs between 240 and 360 for attempt one, 480–720 for attempt two. That is the general answer for any randomized behavior: assert the INVARIANT (the bounds, the distribution's shape, the seed-independent property), never one sampled value. THE LIVE DEMO in the Supertest section above runs exactly this case against the real queue on every request — its delay number is different every time you click, and its verdict is always pass.`,
        },
        {
          kind: 'code',
          id: 'testing-awkward-bits:verbatim-fake-clock',
          language: 'ts',
          caption:
            'Verbatim — injectable timers + a fake clock (test_support/index.ts, the shared spec-support module every fake-clock spec imports)',
          source: 'server/src/test_support/index.ts',
          code: `export class FakeTimerHost {
  nowMs = 1_700_000_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly setTimeoutFn = (fn: () => void, ms: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn });
    return id;
  };
  // ... clearTimeoutFn deletes; advance(ms) fires due timers in deadline
  // order, awaiting setImmediate between firings so the async continuation
  // can register its follow-up timer before the next selection pass.
}`,
        },
        {
          kind: 'code',
          id: 'testing-awkward-bits:verbatim-jitter-bounds',
          language: 'ts',
          caption:
            'Verbatim — and the jitter-bounds assertion that rides the fake clock: randomness pinned by its envelope (domain/jobs/job_queue.spec.ts)',
          source: 'server/src/domain/jobs/job_queue.spec.ts',
          code: `// ...the bounds assertion — randomness pinned by its envelope:
// base 300: attempt 1 backs off ~300ms, attempt 2 ~600ms — both ± 20%.
expect(retries[0]?.delayMs).toBeGreaterThanOrEqual(240);
expect(retries[0]?.delayMs).toBeLessThanOrEqual(360);`,
        },
        {
          kind: 'text',
          id: 'testing-awkward-bits:network-native-isolation',
          body: `THE NETWORK — STUB AT THE BOUNDARY, GATE THE REAL THING. You cannot make a real ECONNREFUSED hermetic, so the webhooks sender spec stubs global fetch (vi.stubGlobal) to throw — and proves the graceful-unreachable path — while the receiver side (HMAC over the raw body) is tested with REAL crypto over plain Supertest, no network needed. When the actual wire behavior matters, this repo does not mock: it GATES. The mongo/redis suites run their live world only when MONGO_TEST_URI / REDIS_TEST_URI is set (the pyramid section's quote) — opt-in reality, default hermeticity. NATIVE MODULES — RUN THEM. better-sqlite3 is a compiled addon, and this repo's answer is not to abstract it behind an interface with a fake: the specs run the REAL native module against a :memory: database (test NODE_ENV forces :memory: — the config topic's rule), because a faked driver would just restate what you already believe about SQL. The lesson generalizes: natives are only "awkward" if your test environment can't build them — fix THAT (Docker, node-gyp, lock the engine) rather than mocking the database out of the database tests. ISOLATION — THE RESET CONVENTION. Singletons (the session store, the document store, the oauth store, the log ring, request metrics, the demo job queue) each export a reset…ForTests() helper, and specs call it in beforeEach so every case starts from the same world; route specs additionally reset the scenario store (dataMode: 'fake', injectFailure: false) for hermetic defaults regardless of ambient env. beforeEach DISCIPLINE is cheaper than debugging order dependence: a suite whose tests pass individually but fail together has a shared-state leak, and the fix is always the same — reset in beforeEach, not "order the tests carefully" (ordering is not a test strategy; it is a flake factory).`,
        },
        {
          kind: 'code',
          id: 'testing-awkward-bits:verbatim-fetch-stub',
          language: 'ts',
          caption:
            'Verbatim — the network stubbed at its one boundary (presentation/routes/webhooks_demo_routes.spec.ts)',
          source: 'server/src/presentation/routes/webhooks_demo_routes.spec.ts',
          code: `// The self-call targets the REAL configured port, which a dev server may or
// may not be occupying while tests run — so the flight itself is stubbed per
// test (unreachable / answered), keeping the specs hermetic either way.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed (ECONNREFUSED)'); // no listener
    }),
  );
});`,
        },
      ],
    },
    {
      id: 'testing-client',
      title: 'Client testing: jsdom, testing-library, and a fetch stub',
      lead:
        'The client\u2019s specs test what the USER experiences — roles and text, not internals — against a fetch stub that dispatches on URL.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-client:philosophy',
          body: `QUERY BY WHAT THE USER SEES. This repo's client specs follow testing-library's core rule: find elements the way a USER finds them — by role, by visible text, by testid for things with no accessible name (a status chip's data-testid) — and assert on rendered OUTPUT, never on component state or props. A spec that grabs internal state breaks on every refactor that preserves behavior; a spec that reads the rendered chip survives any refactor that keeps the user informed. THE TWO WAITING FAMILIES and their budgets: findBy… is "await until it appears" (the default for the first paint of async data — await screen.findByTestId('files-library')), and waitFor is "await until a CONDITION holds" (after an interaction: waitFor(() => expect(queryByText('…')).toBeNull())). Both have a default 1s budget, and that budget is a REAL lesson this repo hit: under heavy system load (the machine at loadavg ~22 during one session), a chained sequence of finds missed the default budget intermittently — NOT a code bug — and the fix was to raise the budget where the sequence is genuinely long, with the reason stated in the spec. A test that flakes under load and passes at rest is telling you about TIMING BUDGETS; a test that fails deterministically is telling you about code. Learn to tell them apart before "fixing" either. Routed components render inside MemoryRouter (no real URL, no navigation side effects), and the setup file's afterEach cleanup keeps every case isolated.`,
        },
        {
          kind: 'code',
          id: 'testing-client:verbatim-budget',
          language: 'tsx',
          caption:
            'Verbatim — the load-sensitivity lesson, stated where it bit (client/src/ui/demos/media/files_workbench_demo.spec.tsx)',
          source: 'client/src/ui/demos/media/files_workbench_demo.spec.tsx',
          code: `// still missed even a 4s budget under heavy ambient load (loadavg 20+).
// Test-level timeout raised to 15s to match — the default 5s cap killed
// the test before its own find budgets could elapse.
await screen.findByTestId('files-library', {}, { timeout: 14000 });`,
        },
        {
          kind: 'text',
          id: 'testing-client:fetch-stub-design',
          body: `THE URL-DISPATCHING FETCH STUB — the client's mirror of the server's hermeticity decision. jsdom has no network worth using, and the components only own fetch() — so the spec replaces it: client/src/test/fetch_stub.ts registers a list of { url, method?, status?, body?, text?, headers? } routes; every call finds its route by exact URL (and method, when pinned — the mongo demo's GET/POST share a URL) and answers with a minimal Response stand-in exposing exactly what the components read: ok, status, json(), and — for the streaming-style demos — text() plus a case-insensitive headers.get(). TWO DESIGN CHOICES worth stealing: (1) an UNSTUBBED URL answers a loud 404 envelope ("no fetch stub for /api/…") instead of hanging, so a missing mock fails the test in milliseconds rather than timing out mysteriously; (2) when the ORDER of calls matters (poll loops, "fire then refresh"), specs graduate from the route list to a hand-rolled sequence stub — a vi.fn whose body flips state ("the ring flips to the noisy set only AFTER the burst endpoint fired") — because a static route map cannot express "same URL, different answer the second time". The observability demo's spec does exactly this for its make-noise → refresh sequence.`,
        },
        {
          kind: 'code',
          id: 'testing-client:verbatim-stub',
          language: 'ts',
          caption:
            'Verbatim — the stub\u2019s contract, in its own words (client/src/test/fetch_stub.ts)',
          source: 'client/src/test/fetch_stub.ts',
          code: `/**
 * URL-dispatching fetch stub for jsdom specs: each route matches an exact
 * request URL and answers either as JSON (body) or as raw text with headers
 * (text + headers — for components that read response.text() and headers).
 * Any unstubbed URL answers with a 404 error envelope so a missing mock fails
 * loudly instead of hanging. Callers must \`vi.unstubAllGlobals()\` in
 * afterEach — this file deliberately does not own test lifecycle hooks.
 */`,
        },
      ],
    },
    {
      id: 'testing-coverage',
      title: 'Coverage as a map, not a score',
      lead:
        'A coverage number tells you what was EXECUTED, never what was ASSERTED. This app measures nothing — and says so.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-coverage:what-it-can-tell-you',
          body: `WHAT COVERAGE MEASURES: which lines, branches, and functions your suite EXECUTED. That is genuinely useful — as a MAP. The uncovered-lines report is a flashlight on code you forgot to exercise: the error branch in a parser, the clamp paths, the abort handling. Reading the uncovered list and asking "should a test pin this?" is the single highest-value fifteen minutes coverage offers. WHAT IT CANNOT TELL YOU: whether the executed code was ASSERTED ON. A suite of smoke tests that calls every endpoint and checks nothing but "no throw" can report 100% coverage while proving zero behavior; coverage counts EXECUTION, and an expect-free test executes code just as thoroughly as a rigorous one. The score is gameable precisely because it measures effort's shadow, not effort. MUTATION TESTING is the honest upgrade, in one paragraph: a tool (StrykerJS is the JS ecosystem's standard) flips your code one small mutation at a time — an inverted comparison, a changed constant — and re-runs the suite; a mutant that SURVIVES marks a test gap, because your assertions were too weak to notice the behavior change. Coverage asks "was this line run?"; mutation testing asks "if this line were WRONG, would you know?" — the question you actually care about. It is expensive (a full run is suite-time × mutants), so teams tend to apply it to critical modules, not everything. THIS APP'S HONEST STANCE: coverage is measured NOWHERE in this repo — no --coverage flag in any script, and the vitest coverage dependency (@vitest/coverage-v8) is NOT installed, so the command below would fail today. That is a deliberate starting point, stated here rather than hidden: the suite was written for BEHAVIOR, and the DoD discipline (green tests + green build in both packages) does not include a number. The day a number is wanted, the catalog mention is \`npm run test -- --coverage\` after adding @vitest/coverage-v8 — read the map it prints, and resist putting the score on a dashboard.`,
        },
        {
          kind: 'code',
          id: 'testing-coverage:command',
          language: 'bash',
          caption:
            'Sketch — the command that WOULD measure coverage (needs @vitest/coverage-v8 — deliberately not installed in this repo)',
          code: `# in server/ or client/ — currently fails: @vitest/coverage-v8 is not a dependency
npm test -- --coverage

# what to read when it works: not the headline percentage, the FILE-BY-FILE
# uncovered-lines report — every % Stmts < 100 entry is a question:
# "is this branch worth pinning, or is it unreachable scaffolding?"`,
        },
      ],
    },
    {
      id: 'testing-ci',
      title: 'CI and the suite contract',
      lead:
        'The definition of done this repo actually enforces: both packages, tests AND build, green — and a determinism culture that treats flakes as bugs.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-ci:suite-contract',
          body: `THE CONTRACT, AS THIS REPO LIVES IT. The definition of done for every task in this project's own development log is executable and boring by design: from server/ — \`npm test\` AND \`npm run build\` green; from client/ — \`npm test\` AND \`npm run build\` green. Tests alone are not enough (a type error the tests never trip still ships to the build); the build alone is not enough (it proves compilation, not behavior); the PAIR is the smallest contract that says "the code does what it says and compiles doing it". THE SUITE'S OWN INVARIANTS that make the contract trustworthy: hermetic by default (no docker, no env vars needed — the live-service worlds are skipIf-gated opt-ins), deterministic by construction (fake clocks, bounded jitter, sequence stubs, fixed seeds — the i18n topic even freezes its Intl instant so date formatting asserts EXACT strings), and isolated (reset helpers in beforeEach, cleanup in afterEach, no test knows another exists). DETERMINISM HUNTING — the repo's own case study, worth retelling: a full-suite run was once reported as ~1-in-10 flaky; investigation found the "failures" were the EXPECTED pino warn lines from the webhooks specs ("request failed" grep hits), not failures at all — OBSERVATIONAL ERROR, not a flake. Eight consecutive clean full-suite runs confirmed it. The lessons: (1) grep your test output with a query that can't match your own expected logs, and (2) before hunting a flake, REPRODUCE it — a flake you cannot reproduce on demand is usually a misread, and the flake you CAN reproduce is usually a shared-state leak or a timing budget (the client section's load story). WHERE CI LIVES: this topic deliberately stops at the contract — the pipelines that run it on every push (GitHub Actions and friends, matrix builds, the cache/restored-node_modules dance, when to run the docker-dependent suites) belong to the deployment section, which owns CI/CD as a delivery concern rather than a testing one.`,
        },
        {
          kind: 'code',
          id: 'testing-ci:dod',
          language: 'bash',
          caption:
            'The suite contract — the exact commands this repo\u2019s definition of done names (both packages, tests AND build)',
          code: `# server/
npm test && npm run build

# client/
npm test && npm run build

# the optional third world (requires docker compose services up):
MONGO_TEST_URI=mongodb://localhost:27017/express_guide_test npm test   # server, live mongo suite
REDIS_TEST_URI=redis://localhost:6379 npm test                        # server, live redis suite`,
        },
      ],
    },
    {
      id: 'testing-e2e',
      title: 'Browser E2E, for real',
      lead:
        'The layer this topic once called its honest gap — now three Playwright specs, run from the host because the devcontainer cannot install Chromium.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-e2e:what-only-the-browser-sees',
          body: `WHAT ONLY THE BROWSER CAN SEE. Every layer above is in-process: Supertest hands requests straight to the app's handler with no socket, and the client's jsdom specs render against a fetch stub. Two wiring facts live in neither world: does the VITE PROXY actually forward /api to the server over real HTTP, and does the served content actually RENDER — the real bundle, the real components, the real DOM a user's browser gets. A browser e2e spec crosses every boundary at once (browser → dev server → proxy → API → back) and asserts on what the user SEES; that reach is also its cost, the pyramid's original trade — a red e2e test is a symptom with a blast radius, not a diagnosis. So this repo keeps the suite at THREE SPECS, each pinning one wiring fact and nothing more: the home map renders from the content API (all ten groups, all forty topic links), a topic page renders (sections, collapsed-by-default code blocks, mounted demo panels), and ONE full interactive round-trip through a real demo endpoint — the quote below. The suite is a smoke signal for the wiring, not a second copy of the unit suite; the pyramid's proportions still hold. WHERE IT RUNS — AN HONEST CONSTRAINT, not a virtue: the devcontainer's tooling container runs as node with no sudo, so Chromium's system libraries (the deb tree that a playwright --with-deps install apt-installs) cannot be added there. The suite therefore runs on the HOST, against the devcontainer's published ports — client :5173, /api proxied to :4000 — the exact pages a host browser opens anyway. That makes it the one documented exception to this repo's "host npm doesn't work" rule: @playwright/test is pure JS with no native modules, so a host install is safe, and the Chromium binary is the only thing it downloads. The cost of that honesty is stated plainly in e2e/README.md: the suite is NOT part of the devcontainer's definition of done — it needs the stack up and a host Node 20+, so it runs when a human (or a host CI job) runs it, not on every save. One last note on SELECTORS, because e2e specs rot by brittleness: these specs locate elements the way a USER does — by role, by label, by visible text — never by CSS class or DOM index, the same rule the client section taught, applied one layer up.`,
        },
        {
          kind: 'code',
          id: 'testing-e2e:verbatim-round-trip',
          language: 'ts',
          caption:
            'Verbatim — the round-trip spec: every assertion below can only pass if the browser reached the real server through the proxy (e2e/demo.spec.ts)',
          source: 'e2e/demo.spec.ts',
          code: `test('the uuid strategy demo answers from the real server', async ({ page }) => {
  await page.goto('/topics/sql-schema');
  // Scoped to the article: the sticky header renders the topic title as an
  // h1 too (banner), so assert on the content h1.
  await expect(
    page
      .getByRole('article')
      .getByRole('heading', { level: 1, name: 'SQL and Schema Design' }),
  ).toBeVisible();

  // The live panel for demoId db:uuid — demos are lazy-loaded chunks, so
  // waiting for its heading also waits for the chunk to mount.
  await expect(
    page.getByRole('heading', { level: 3, name: 'v4 vs v7: watch the sort decide' }),
  ).toBeVisible();

  // A non-default batch size, so the echoed count proves the query param
  // actually traveled to the server and came back.
  await page.getByLabel('batch size').selectOption('24');
  await page.getByRole('button', { name: 'generate both batches' }).click();

  // Server-backed outcomes: the count echo and both sort verdicts are fields
  // of the server's response body, rendered by the demo only after the
  // round-trip completes.
  await expect(page.getByText('24 ids per side', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'UUID v4 — random' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'UUID v7 — time-ordered' })).toBeVisible();
  await expect(page.getByText('sorted ≠ generated', { exact: true })).toBeVisible();
  await expect(page.getByText('sorted === generated', { exact: true })).toBeVisible();
});`,
        },
      ],
    },
    {
      id: 'testing-see-it-live',
      title: 'The in-app runner from a terminal',
      lead:
        'A real test runner, inside the running server — twelve curated cases against this app\u2019s own modules, executed on every request.',
      blocks: [
        {
          kind: 'text',
          id: 'testing-see-it-live:what-you-see',
          body: `THE RUNNER is not a mock-up of one — it IS one (the interactive panel with the RUN button lives in the Supertest section above). Calling GET /api/demo/testing/run makes the server execute a curated twelve-case suite against its OWN pure modules right then: the Range parser's three-way verdict matrix (suffix form, unsatisfiable-past-end, ignored non-bytes unit — the same behaviors files_demo_routes.spec pins), the locale negotiator's match ladder (exact case-insensitive, primary-subtag fallback, wildcard-ranked-last — negotiate.spec's classic cases), the JWT service's security properties (roundtrip, tampered-payload, expired — the auth spec's unit block), the job queue's backoff-bounds case driven through a FAKE CLOCK exactly like job_queue.spec (its delay number is different every run — jitter — and its verdict is always pass), and two Accept-Language parser edges (q clamping, malformed-segments-never-throw). Each case reports its module of origin, its expected vs actual strings, and its wall time; the backoff case's actual will show a DIFFERENT delayMs on every call — live randomness, pinned by bounds, exactly as the section above teaches. THE HONESTY KNOB: pass injectFailureFor=<case> and the runner flips exactly that case to red — with its real expected/actual still shown — proving the harness reports failures rather than always painting green (and an unknown case id is a 400 envelope listing the valid ids). A failure appearing on a plain run would mean the app drifted from the behaviors this page teaches — the endpoint doubles as a canary. Drive it from a terminal:`,
        },
        {
          kind: 'code',
          id: 'testing-see-it-live:curl',
          language: 'bash',
          caption: 'The same runner over curl (server running on :4000)',
          code: `curl -s localhost:4000/api/demo/testing/run | head -c 600
# the honesty knob — flip one case red:
curl -s 'localhost:4000/api/demo/testing/run?injectFailureFor=jwt-tampered-payload' | head -c 600
# and the guard — an unknown case id is a 400 envelope:
curl -s 'localhost:4000/api/demo/testing/run?injectFailureFor=bogus' | head -c 300`,
        },
      ],
    },
  ],
};
