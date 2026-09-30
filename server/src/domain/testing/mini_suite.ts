import { signJwt, verifyJwt } from '../auth/jwt_service.js';
import { negotiateLocale, parseAcceptLanguage } from '../i18n/negotiate.js';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../i18n/locales.js';
import { JobQueue } from '../jobs/job_queue.js';
import { parseRangeHeader } from '../../core/http/range_header.js';

/**
 * A test harness that runs INSIDE the running server — the testing topic's
 * live demo. `runMiniSuite()` imports the app's PURE modules and executes a
 * curated twelve-case suite on every request: the range parser's three-way
 * verdicts, the locale negotiator's match ladder, the JWT service's
 * sign/verify security properties, and the job queue's backoff-bounds math
 * (driven through injectable fake timers, exactly like job_queue.spec.ts).
 *
 * These cases are not fixtures — they call the REAL functions, so the demo is
 * a canary: if a refactor breaks one of these behaviors, this endpoint (and
 * its spec) flips red instantly.
 *
 * LAYERING NOTE: every module this suite exercises is imported honestly —
 * the range parser lives in core/ (the shared kernel both domain and
 * presentation may import), so no layer is crossed sideways. The runtime
 * dependency rule (presentation → domain ← data) is untouched: no
 * production code imports this file except its own demo route.
 */

export interface MiniCase {
  /** Stable slug (URL-safe) — the injectFailureFor key and the UI select value. */
  id: string;
  /** The behavior statement — a sentence about the contract, not the call. */
  name: string;
  /** The source file of the module under test (module-of-origin note). */
  module: string;
  passed: boolean;
  /** What the contract says, in prose. */
  expected: string;
  /** What actually happened this run. */
  actual: string;
  /** Wall time of this case, milliseconds. */
  ms: number;
}

export interface MiniSuiteResult {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  cases: MiniCase[];
  injectFailureFor: string | null;
  note: string;
}

// --- the tiny harness ----------------------------------------------------------

/** What one case returns when it runs: its verdict, expressed as strings. */
interface CaseOutcome {
  passed: boolean;
  expected: string;
  actual: string;
}

type CaseFn = () => CaseOutcome | Promise<CaseOutcome>;

/** Runs one case honestly: an exception is a FAILED case, never a crash. */
async function timeCase(entry: { id: string; name: string; module: string; fn: CaseFn }): Promise<MiniCase> {
  const startedAt = performance.now();
  let outcome: CaseOutcome;
  try {
    outcome = await entry.fn();
  } catch (error) {
    outcome = {
      passed: false,
      expected: 'the case completes without throwing',
      actual: `threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    id: entry.id,
    name: entry.name,
    module: entry.module,
    passed: outcome.passed,
    expected: outcome.expected,
    actual: outcome.actual,
    ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
  };
}

// --- the fake timer host (the job-queue case's clock) ---------------------------

/**
 * The same injectable-timer trick job_queue.spec.ts uses, minimal: timers in
 * a Map, advance(ms) fires every due deadline in order and lets the async
 * continuation register its follow-up timer between firings (setImmediate
 * drains the microtask queue).
 */
class FakeTimerHost {
  nowMs = 1_700_000_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly setTimeoutFn = (fn: () => void, ms: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), fn });
    return id;
  };

  readonly clearTimeoutFn = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      let earliest: { id: number; at: number; fn: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (earliest === undefined || timer.at < earliest.at) earliest = { id, ...timer };
      }
      if (earliest === undefined) break;
      this.timers.delete(earliest.id);
      this.nowMs = Math.max(this.nowMs, earliest.at);
      earliest.fn();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.nowMs = target;
  }
}

const RANGE_MODULE = 'src/core/http/range_header.ts';
const NEGOTIATE_MODULE = 'src/domain/i18n/negotiate.ts';
const JWT_MODULE = 'src/domain/auth/jwt_service.ts';
const JOBS_MODULE = 'src/domain/jobs/job_queue.ts';

// --- the curated suite ----------------------------------------------------------

const suite: ReadonlyArray<{ id: string; name: string; module: string; fn: CaseFn }> = [
  {
    id: 'range-suffix-form',
    name: 'the suffix form bytes=-10 serves exactly the LAST 10 bytes',
    module: RANGE_MODULE,
    fn: () => {
      const parsed = parseRangeHeader('bytes=-10', 100);
      return {
        passed:
          parsed.kind === 'satisfiable' && parsed.start === 90 && parsed.end === 99,
        expected: "parseRangeHeader('bytes=-10', 100) → satisfiable 90–99 (a 10-byte slice)",
        actual: `parseRangeHeader('bytes=-10', 100) → ${JSON.stringify(parsed)}`,
      };
    },
  },
  {
    id: 'range-unsatisfiable-past-end',
    name: 'a first byte past the end of the file is UNSATISFIABLE (416), not ignored',
    module: RANGE_MODULE,
    fn: () => {
      const parsed = parseRangeHeader('bytes=150-', 100);
      return {
        passed: parsed.kind === 'unsatisfiable',
        expected:
          "parseRangeHeader('bytes=150-', 100) → unsatisfiable (valid syntax, outside the file)",
        actual: `parseRangeHeader('bytes=150-', 100) → ${JSON.stringify(parsed)}`,
      };
    },
  },
  {
    id: 'range-non-bytes-unit-ignored',
    name: 'a non-bytes range unit is IGNORED per spec — the full body is served',
    module: RANGE_MODULE,
    fn: () => {
      const parsed = parseRangeHeader('chunks=0-10', 100);
      return {
        passed: parsed.kind === 'ignored',
        expected:
          "parseRangeHeader('chunks=0-10', 100) → ignored (a recipient MUST disregard an invalid unit)",
        actual: `parseRangeHeader('chunks=0-10', 100) → ${JSON.stringify(parsed)}`,
      };
    },
  },
  {
    id: 'i18n-exact-case-insensitive',
    name: 'exact match is case-insensitive: "JA" resolves to supported ja',
    module: NEGOTIATE_MODULE,
    fn: () => {
      const result = negotiateLocale('JA', [...SUPPORTED_LOCALES], DEFAULT_LOCALE);
      const passed = result.locale === 'ja' && result.matchedVia === 'exact';
      return {
        passed,
        expected: `negotiateLocale('JA', ${JSON.stringify([...SUPPORTED_LOCALES])}, '${DEFAULT_LOCALE}') → { locale: 'ja', matchedVia: 'exact' }`,
        actual: `negotiateLocale('JA', …) → { locale: '${result.locale}', matchedVia: '${result.matchedVia}' }`,
      };
    },
  },
  {
    id: 'i18n-primary-subtag',
    name: 'de-AT falls to supported de through the primary subtag',
    module: NEGOTIATE_MODULE,
    fn: () => {
      const result = negotiateLocale('de-AT,ja;q=0.8,en;q=0.5', [...SUPPORTED_LOCALES], DEFAULT_LOCALE);
      const passed = result.locale === 'de' && result.matchedVia === 'primary';
      return {
        passed,
        expected: "negotiateLocale('de-AT,ja;q=0.8,en;q=0.5', …) → { locale: 'de', matchedVia: 'primary' }",
        actual: `negotiateLocale('de-AT,…', …) → { locale: '${result.locale}', matchedVia: '${result.matchedVia}' }`,
      };
    },
  },
  {
    id: 'i18n-wildcard-ranked-last',
    name: 'the wildcard serves the default locale only after every named range had its turn',
    module: NEGOTIATE_MODULE,
    fn: () => {
      const result = negotiateLocale('fr-CA,*;q=0.5', [...SUPPORTED_LOCALES], DEFAULT_LOCALE);
      const passed = result.locale === DEFAULT_LOCALE && result.matchedVia === 'wildcard';
      return {
        passed,
        expected:
          "negotiateLocale('fr-CA,*;q=0.5', …) → { locale: 'en', matchedVia: 'wildcard' } (nothing named matches, so * serves the default)",
        actual: `negotiateLocale('fr-CA,*;q=0.5', …) → { locale: '${result.locale}', matchedVia: '${result.matchedVia}' }`,
      };
    },
  },
  {
    id: 'jwt-sign-verify-roundtrip',
    name: 'sign then verify round-trips the subject and roles intact',
    module: JWT_MODULE,
    fn: () => {
      const signed = signJwt('alice', ['admin'], 300);
      const verified = verifyJwt(signed.token);
      const passed =
        verified.ok &&
        verified.value.payload.sub === 'alice' &&
        verified.value.payload.roles.length === 1 &&
        verified.value.payload.roles[0] === 'admin';
      return {
        passed,
        expected:
          "verifyJwt(signJwt('alice', ['admin'], 300).token) → ok, payload { sub: 'alice', roles: ['admin'] }",
        actual: verified.ok
          ? `verifyJwt(…) → ok, payload { sub: '${verified.value.payload.sub}', roles: ${JSON.stringify(verified.value.payload.roles)} }`
          : `verifyJwt(…) → error ${JSON.stringify(verified.error.reason)}`,
      };
    },
  },
  {
    id: 'jwt-tampered-payload',
    name: 'a tampered payload with the signature kept fails as signature_mismatch',
    module: JWT_MODULE,
    fn: () => {
      const signed = signJwt('alice', ['admin'], 300);
      const [header, payload, signature] = signed.token.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
      claims.sub = 'admin'; // the honest attack: edit the claims, keep the signature
      const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      const verified = verifyJwt(`${header}.${forged}.${signature}`);
      const passed = !verified.ok && verified.error.reason === 'signature_mismatch';
      return {
        passed,
        expected: "verifyJwt('<header>.<forged payload>.<original signature>') → error reason 'signature_mismatch'",
        actual: verified.ok
          ? 'verifyJwt(…) → ok — the forgery was ACCEPTED'
          : `verifyJwt(…) → error reason '${verified.error.reason}'`,
      };
    },
  },
  {
    id: 'jwt-expired-refused',
    name: 'a token whose exp is already past is refused as token_expired',
    module: JWT_MODULE,
    fn: () => {
      const signed = signJwt('carol', ['viewer'], -60); // exp 60s in the past
      const verified = verifyJwt(signed.token);
      const passed = !verified.ok && verified.error.reason === 'token_expired';
      return {
        passed,
        expected:
          "verifyJwt(signJwt('carol', ['viewer'], -60).token) → error reason 'token_expired' (exp <= now means refused)",
        actual: verified.ok
          ? 'verifyJwt(…) → ok — an expired token was ACCEPTED'
          : `verifyJwt(…) → error reason '${verified.error.reason}'`,
      };
    },
  },
  {
    id: 'jobs-backoff-within-jitter-bounds',
    name: 'retry #1 backs off ~300ms ± 20% jitter — never sync-locked, never unbounded',
    module: JOBS_MODULE,
    fn: async () => {
      const host = new FakeTimerHost();
      const queue = new JobQueue({
        baseDelayMs: 300,
        now: () => host.nowMs,
        setTimeoutFn: host.setTimeoutFn,
        clearTimeoutFn: host.clearTimeoutFn,
      });
      const enqueued = queue.enqueue('email', { forceFailures: 1, latencyMs: 10 });
      if (!enqueued.ok) {
        return { passed: false, expected: 'enqueue succeeds', actual: `enqueue failed: ${enqueued.error.kind}` };
      }
      await host.advance(5000); // fail once, sit out the backoff, succeed on retry
      const retries = (queue.get(enqueued.value.id)?.history ?? []).filter(
        (entry) => entry.event === 'retry_scheduled',
      );
      const delayMs = retries[0]?.delayMs;
      const passed =
        queue.get(enqueued.value.id)?.status === 'succeeded' &&
        retries.length === 1 &&
        delayMs !== undefined &&
        delayMs >= 240 &&
        delayMs <= 360;
      return {
        passed,
        expected:
          'after one injected failure (base 300ms): status succeeded, one retry_scheduled, delayMs in [240, 360]',
        actual:
          delayMs === undefined
            ? `no retry_scheduled entry; final status ${String(queue.get(enqueued.value.id)?.status)}`
            : `delayMs ${String(delayMs)} (base 300 ± 20%); final status ${String(queue.get(enqueued.value.id)?.status)}`,
      };
    },
  },
  {
    id: 'i18n-q-clamped',
    name: 'q values outside [0, 1] are clamped, not trusted',
    module: NEGOTIATE_MODULE,
    fn: () => {
      const high = parseAcceptLanguage('de;q=4');
      const low = parseAcceptLanguage('de;q=-2');
      const passed =
        high.length === 1 && high[0].q === 1 && low.length === 1 && low[0].q === 0;
      return {
        passed,
        expected: "parseAcceptLanguage('de;q=4') → q 1 (clamped down); parseAcceptLanguage('de;q=-2') → q 0 (clamped up)",
        actual: `q=4 → q ${String(high[0]?.q)}; q=-2 → q ${String(low[0]?.q)}`,
      };
    },
  },
  {
    id: 'i18n-malformed-never-throws',
    name: 'garbage segments and malformed q values are skipped — the parser never throws',
    module: NEGOTIATE_MODULE,
    fn: () => {
      const parsed = parseAcceptLanguage('!!,de;q=abc,ja;charset=utf8');
      const passed =
        parsed.length === 2 &&
        parsed[0].range === 'de' &&
        parsed[0].q === 1 &&
        parsed[1].range === 'ja' &&
        parsed[1].q === 1;
      return {
        passed,
        expected:
          "parseAcceptLanguage('!!,de;q=abc,ja;charset=utf8') → [{ range: 'de', q: 1 }, { range: 'ja', q: 1 }] — no throw",
        actual: `parseAcceptLanguage('!!,de;q=abc,ja;charset=utf8') → ${JSON.stringify(parsed)}`,
      };
    },
  },
];

export const MINI_SUITE_CASE_IDS: readonly string[] = suite.map((entry) => entry.id);

// --- the runner ------------------------------------------------------------------

/**
 * Executes the curated suite live. `injectFailureFor` deliberately FLIPS one
 * case to failed (by id) — the demo's proof that the harness reports failures
 * honestly instead of always painting green: the flipped case shows its real
 * expected/actual plus an injected marker.
 */
export async function runMiniSuite(options: { injectFailureFor?: string } = {}): Promise<MiniSuiteResult> {
  const startedAt = performance.now();
  const inject = options.injectFailureFor ?? null;

  const cases: MiniCase[] = [];
  for (const entry of suite) {
    const result = await timeCase(entry);
    if (inject !== null && result.id === inject) {
      cases.push({
        ...result,
        passed: false,
        actual: `${result.actual} [failure INJECTED via ?injectFailureFor — the assertion was flipped by request; the real verdict was ${result.passed ? 'PASS' : 'FAIL'}]`,
      });
    } else {
      cases.push(result);
    }
  }

  const passed = cases.filter((entry) => entry.passed).length;
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    cases,
    injectFailureFor: inject,
    note: 'these are not fixtures — every case calls the real modules in this running process on every request',
  };
}
