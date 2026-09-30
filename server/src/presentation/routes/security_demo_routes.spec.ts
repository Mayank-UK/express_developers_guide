import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  HANDMADE_PING_LIMIT,
  SECURITY_CORS_ALLOWLIST,
  SECURITY_PING_LIMIT,
  SSRF_ALLOWLIST,
  checkSsrfUrl,
  resetSecurityDemoLimiters,
} from './security_demo_routes.js';
import { evaluateCorsOrigin } from '../middleware/cors_middleware.js';
import { normalizeClientIp } from '../middleware/handmade_rate_limiter.js';

const MOUNT = '/api/demo/security';

beforeEach(() => {
  // Both limiters start every case from clean windows — suite order cannot
  // leak a 429 from a previous test into this one.
  resetSecurityDemoLimiters();
});

// --- helmet: real headers on real responses --------------------------------------

describe('helmet — security headers on every response', () => {
  it('sets the header suite on a normal /api route', async () => {
    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-permitted-cross-domain-policies']).toBe('none');
    expect(res.headers['origin-agent-cluster']).toBe('?1');
    expect(res.headers['strict-transport-security']).toMatch(/^max-age=\d+/);
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    // CSP is pinned in app.ts — the exact policy, not just "some CSP":
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    // The app also disabled its framework billboard itself:
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('does NOT break Swagger UI at /docs (the helmet integration lesson)', async () => {
    const app = createApp();
    // The page still renders AND still carries the security headers:
    const page = await request(app).get('/docs/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('swagger');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");

    // The UI's assets serve, same-origin — allowed by script-src 'self':
    const init = await request(app).get('/docs/swagger-ui-init.js');
    expect(init.status).toBe(200);
    expect(init.text).toContain('/api/posts');
    const css = await request(app).get('/docs/swagger-ui.css');
    expect(css.status).toBe(200);
    const bundle = await request(app).get('/docs/swagger-ui-bundle.js');
    expect(bundle.status).toBe(200);
  });

  it('GET /headers echoes the security headers THIS response carries', async () => {
    const res = await request(createApp()).get(`${MOUNT}/headers`);

    expect(res.status).toBe(200);
    expect(res.body.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body.headers['content-security-policy']).toContain('default-src');
    expect(String(res.body.headers['x-request-id'])).toMatch(/.+/); // the request-id middleware rode along
    expect(res.body.note).toContain('helmet');
  });
});

// --- rate limiting: the production pick -------------------------------------------

describe('GET /ping — express-rate-limit (5 per 60s per ip)', () => {
  it('answers 200 five times, then the 6th gets the canonical 429 envelope + Retry-After', async () => {
    const app = createApp();
    const statuses: number[] = [];
    for (let i = 0; i < SECURITY_PING_LIMIT; i += 1) {
      const res = await request(app).get(`${MOUNT}/ping`);
      statuses.push(res.status);
      expect(res.body.ok).toBe(true);
      expect(res.body.remaining).toBe(SECURITY_PING_LIMIT - 1 - i);
      expect(res.headers['ratelimit-limit']).toBe(String(SECURITY_PING_LIMIT));
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200]);

    const blocked = await request(app).get(`${MOUNT}/ping`);
    expect(blocked.status).toBe(429);
    // The canonical envelope (one error taxonomy — the limiter throws
    // RateLimitException; the failure's details merge in flat):
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.requestId).toMatch(/.+/);
    expect(blocked.body.error.limiter).toContain('express-rate-limit');
    expect(blocked.body.error.limit).toBe(SECURITY_PING_LIMIT);
    expect(blocked.body.error.windowSeconds).toBe(60);
    expect(blocked.body.error.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    // Retry-After: string seconds; the RateLimit-* suite stays informative:
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.headers['ratelimit-limit']).toBe(String(SECURITY_PING_LIMIT));
    // standardHeaders on, legacyHeaders off — the library emits no X-RateLimit-*:
    expect(blocked.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('the limiter is DEDICATED to /ping — other routes are untouched while /ping is blocked', async () => {
    const app = createApp();
    for (let i = 0; i < SECURITY_PING_LIMIT; i += 1) {
      await request(app).get(`${MOUNT}/ping`);
    }
    expect((await request(app).get(`${MOUNT}/ping`)).status).toBe(429);

    // The handmade twin has its OWN window (and its own algorithm):
    expect((await request(app).get(`${MOUNT}/handmade-ping`)).status).toBe(200);
    // And the rest of the API never heard about it:
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});

// --- rate limiting: the handmade fixed-window twin ---------------------------------

describe('GET /handmade-ping — the hand-rolled fixed window (3 per 30s)', () => {
  it('counts 1..3 then 429s with x-ratelimit headers and the envelope', async () => {
    const app = createApp();
    const counts: number[] = [];
    for (let i = 0; i < HANDMADE_PING_LIMIT; i += 1) {
      const res = await request(app).get(`${MOUNT}/handmade-ping`);
      counts.push(res.body.count);
      expect(res.status).toBe(200);
      expect(res.body.limiter).toContain('handmade');
      expect(res.headers['x-ratelimit-limit']).toBe(String(HANDMADE_PING_LIMIT));
      expect(res.headers['x-ratelimit-remaining']).toBe(String(HANDMADE_PING_LIMIT - 1 - i));
    }
    expect(counts).toEqual([1, 2, 3]);

    const blocked = await request(app).get(`${MOUNT}/handmade-ping`);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.limiter).toContain('handmade-ping');
    expect(blocked.body.error.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    // The /ping limiter was NOT consumed by the handmade demo:
    expect((await request(app).get(`${MOUNT}/ping`)).status).toBe(200);
  });

  it('normalizes IPv4-mapped loopback so one client holds ONE window', () => {
    expect(normalizeClientIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('::1')).toBe('::1'); // true IPv6 is not rewritten
    expect(normalizeClientIp(undefined)).toBe('unknown');
  });
});

// --- CORS: the hand-rolled factory, mounted ----------------------------------------

describe('CORS — preflights, echoes, and the browser-enforced lesson', () => {
  it('an allowed-origin preflight gets 204 + the full Access-Control suite', async () => {
    const res = await request(createApp())
      .options(`${MOUNT}/cors-probe`)
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-max-age']).toBe('600');
    expect(res.headers.vary).toBe('Origin');
  });

  it('a disallowed-origin preflight gets NO CORS headers (the browser is the blocker)', async () => {
    const res = await request(createApp())
      .options(`${MOUNT}/cors-probe`)
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');

    // No Access-Control-Allow-Origin anywhere — whatever status the app answers
    // with, the calling page's browser refuses to expose the response.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('actual GET from an allowed origin carries the echo; the request ALWAYS runs', async () => {
    const app = createApp();

    const allowed = await request(app).get(`${MOUNT}/cors-probe`).set('Origin', 'https://example.com');
    expect(allowed.status).toBe(200);
    expect(allowed.body.ok).toBe(true);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://example.com');

    // Disallowed origin: no CORS headers — but the request still executed
    // (200 + body). The server never blocked anything; the browser will.
    const denied = await request(app).get(`${MOUNT}/cors-probe`).set('Origin', 'https://evil.example');
    expect(denied.status).toBe(200);
    expect(denied.body.ok).toBe(true);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    // No Origin at all (same-origin / curl): CORS has nothing to say.
    const bare = await request(app).get(`${MOUNT}/cors-probe`);
    expect(bare.status).toBe(200);
    expect(bare.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GET /cors-check answers verdicts from the SAME decision the middleware enforces', async () => {
    const app = createApp();

    const allowed = await request(app).get(`${MOUNT}/cors-check?origin=https%3A%2F%2Fexample.com`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({
      origin: 'https://example.com',
      allowed: true,
      accessControlAllowOrigin: 'https://example.com',
      credentials: true,
    });
    expect(allowed.body.allowlist).toEqual([...SECURITY_CORS_ALLOWLIST]);

    const denied = await request(app).get(
      `${MOUNT}/cors-check?origin=${encodeURIComponent('https://evil.example')}`,
    );
    expect(denied.status).toBe(200); // a VERDICT, not an error — the question was valid
    expect(denied.body.allowed).toBe(false);
    expect(denied.body.accessControlAllowOrigin).toBeNull();
    expect(denied.body.note).toMatch(/browser/i);
  });

  it('rejects malformed origin parameters at the boundary (400 envelope)', async () => {
    const missing = await request(createApp()).get(`${MOUNT}/cors-check`);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('validation_failed');

    const withPath = await request(createApp()).get(
      `${MOUNT}/cors-check?origin=${encodeURIComponent('https://example.com/page')}`,
    );
    expect(withPath.status).toBe(400);
    expect(withPath.body.error.message).toContain('scheme://host');
  });

  it('evaluateCorsOrigin never reflects an arbitrary origin (the credentials rule)', () => {
    const verdict = evaluateCorsOrigin(
      { origins: ['https://good.example'], credentials: true },
      'https://evil.example',
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowOrigin).toBeNull(); // no echo, no '*', no reflection
  });
});

// --- the SSRF guard -----------------------------------------------------------------

describe('GET /ssrf-guard — allowlist verdicts, never a fetch', () => {
  it('allows allowlisted hosts (canonical spellings)', async () => {
    for (const url of ['http://httpbin.org/get', 'https://example.com/anything', 'http://localhost:4000/api/health']) {
      const res = await request(createApp()).get(`${MOUNT}/ssrf-guard?url=${encodeURIComponent(url)}`);
      expect(res.status, url).toBe(200);
      expect(res.body.allowed, url).toBe(true);
      expect(res.body.kind, url).toBe('allowed');
      expect(res.body.fetched).toBe(false); // it NEVER fetches
    }
  });

  it('DENIES the cloud metadata IP — the classic SSRF target', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/ssrf-guard?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`,
    );
    expect(res.body.allowed).toBe(false);
    expect(res.body.kind).toBe('private_or_loopback_ip');
    expect(res.body.reason).toContain('169.254.169.254');
    expect(res.body.reason).toContain('metadata');
  });

  it('denies private ranges and the userinfo disguise', () => {
    const ten = checkSsrfUrl('http://10.0.0.5/internal');
    expect(ten.allowed).toBe(false);
    expect(ten.kind).toBe('private_or_loopback_ip');

    const rfc1918 = checkSsrfUrl('http://172.31.255.1/');
    expect(rfc1918.kind).toBe('private_or_loopback_ip');

    // http://httpbin.org@169.254.169.254/ — the allowlisted NAME is bait;
    // URL.hostname unmasks the real host:
    const disguised = checkSsrfUrl('http://httpbin.org@169.254.169.254/latest');
    expect(disguised.allowed).toBe(false);
    expect(disguised.host).toBe('169.254.169.254');
    expect(disguised.kind).toBe('private_or_loopback_ip');
  });

  it('denies the obfuscated IP spellings even though URL parsing canonicalizes them', () => {
    // WHATWG URL turns all of these into hostname 127.0.0.1 — which IS in the
    // dev allowlist. The guard compares the RAW spelling too, so a disguise is
    // an evasion, not an allowlist hit:
    const hex = checkSsrfUrl('http://0x7f000001/');
    expect(hex.allowed).toBe(false);
    expect(hex.kind).toBe('ip_literal_evasion');
    expect(hex.reason).toContain('0x7f000001');

    const decimal = checkSsrfUrl('http://2130706433/');
    expect(decimal.allowed).toBe(false);
    expect(decimal.kind).toBe('ip_literal_evasion');
    expect(decimal.reason).toContain('2130706433');

    const octal = checkSsrfUrl('http://0177.0.0.1/');
    expect(octal.allowed).toBe(false);
    expect(octal.kind).toBe('ip_literal_evasion');

    const shorthand = checkSsrfUrl('http://127.1/');
    expect(shorthand.allowed).toBe(false);
    expect(shorthand.kind).toBe('ip_literal_evasion');
  });

  it('denies IPv6/v4-mapped and punycode forms, and everything unlisted', () => {
    const v4mapped = checkSsrfUrl('http://[::ffff:127.0.0.1]/');
    expect(v4mapped.allowed).toBe(false);
    expect(v4mapped.kind).toBe('ipv6_literal');

    const plainV6 = checkSsrfUrl('http://[2001:db8::1]/');
    expect(plainV6.kind).toBe('ipv6_literal');

    // the allowlisted ::1 dev entry still passes, canonical spelling:
    expect(checkSsrfUrl('http://[::1]:4000/health').allowed).toBe(true);

    const punycode = checkSsrfUrl('http://xn--e1afmkfd.xn--p1ai/');
    expect(punycode.kind).toBe('punycode');

    const unlisted = checkSsrfUrl('https://api.stripe.com/v1/charges');
    expect(unlisted.kind).toBe('not_allowlisted');

    const publicIp = checkSsrfUrl('http://8.8.8.8/dns');
    expect(publicIp.kind).toBe('not_allowlisted');
    expect(publicIp.reason).toContain('default deny');

    const badScheme = checkSsrfUrl('file:///etc/passwd');
    expect(badScheme.kind).toBe('bad_scheme');

    expect(checkSsrfUrl('not a url at all').kind).toBe('unparseable');
  });

  it('requires the url parameter (400 envelope)', async () => {
    const res = await request(createApp()).get(`${MOUNT}/ssrf-guard`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.parameter).toBe('url');
  });

  it('serves the allowlist so clients can show what "allowed" means', async () => {
    const res = await request(createApp()).get(
      `${MOUNT}/ssrf-guard?url=${encodeURIComponent('http://localhost:4000/api/health')}`,
    );
    expect(res.body.allowlist).toEqual([...SSRF_ALLOWLIST]);
    expect(res.body.note).toContain('NEVER fetches');
  });
});

// --- the injection catalog ------------------------------------------------------------

describe('GET /injection-samples — safe/unsafe pairs + the repo\'s own status', () => {
  it('serves the five families with both code halves and a why', async () => {
    const res = await request(createApp()).get(`${MOUNT}/injection-samples`);

    expect(res.status).toBe(200);
    expect(res.body.samples.map((sample: { family: string }) => sample.family)).toEqual([
      'sql',
      'command',
      'xss',
      'path',
      'ssrf',
    ]);
    for (const sample of res.body.samples as { unsafeCode: string; safeCode: string; why: string; language: string }[]) {
      expect(sample.unsafeCode.length).toBeGreaterThan(10);
      expect(sample.safeCode.length).toBeGreaterThan(10);
      expect(sample.why.length).toBeGreaterThan(10);
      expect(sample.language).toMatch(/^(ts|tsx)$/);
    }
    // The sql pair must teach the app's actual defense (parameter binding):
    const sql = (res.body.samples as { family: string; safeCode: string }[]).find(
      (sample) => sample.family === 'sql',
    );
    expect(sql?.safeCode).toContain('prepare');
  });

  it('reports the repo\'s enforced controls honestly (incl. what is only planned)', async () => {
    const res = await request(createApp()).get(`${MOUNT}/injection-samples`);

    const statuses = (res.body.enforced as { status: string }[]).map((entry) => entry.status);
    expect(statuses).toContain('enforced');
    expect(statuses).toContain('planned'); // path traversal waits for Files & Media
    const detail = (res.body.enforced as { control: string; detail: string }[])
      .map((entry) => `${entry.control}: ${entry.detail}`)
      .join(' ');
    expect(detail).toContain('post_dao'); // parameterized SQL citation
    expect(detail).toContain('timingSafeEqual'); // constant-time citation
    expect(detail).toContain('redirect_uri'); // open-redirect allowlist citation
  });
});
