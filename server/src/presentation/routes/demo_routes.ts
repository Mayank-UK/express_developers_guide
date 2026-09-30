import { createRequire } from 'node:module';
import { Router, type Request, type Response } from 'express';
import { getContainer } from '../../di/container.js';
import { appConfig } from '../../core/config/app_config.js';
import {
  FAILURE_ERROR_CODE,
  FAILURE_HTTP_STATUS,
  FAILURE_KINDS,
  failure,
  type FailureKind,
} from '../../core/error_handling/failures.js';
import { failureToException, ValidationException } from '../../core/error_handling/exceptions.js';
import { ok } from '../../core/result/result.js';
import type { ScenarioState } from '../../core/scenario/scenario.js';

/**
 * Demo endpoints that prove the architecture end-to-end:
 * - GET   /api/demo/scenario — current runtime scenario state (through the container)
 * - PATCH /api/demo/scenario — runtime fake/live + failure-injection toggle
 * - GET   /api/demo/status   — domain Result mapped onto HTTP, both ok and
 *                              injected-failure branches
 * - GET   /api/demo/app-info — the app object observed from outside: runtime
 *                              facts + config + scenario for the client demo
 * - GET   /api/demo/error    - throws the AppException matching ?failure=<kind>
 * - GET   /api/demo/errors/taxonomy — the 8 failure kinds with their HTTP
 *                              statuses and machine codes, served FROM the
 *                              real maps so the client demo cannot drift
 * - GET   /api/demo/ts/types — typed showcase for the ts:runtime-types demo:
 *                              a serialized Result + a runtime narrowing trace
 * - POST  /api/demo/ts/echo  — runtime type report for ANY JSON body (the
 *                              erasure proof: no compile-time type survives)
 */

/**
 * Express's own version, read once per process. createRequire is the ESM-safe
 * way to load a CommonJS dependency manifest (no JSON import attributes, no
 * tsconfig changes); the value can never change while the process lives.
 */
const expressVersion: string = (() => {
  const nodeRequire = createRequire(import.meta.url);
  return nodeRequire('express/package.json').version as string;
})();

function parseFailureKind(raw: unknown): FailureKind {
  if (typeof raw === 'string' && (FAILURE_KINDS as readonly string[]).includes(raw)) {
    return raw as FailureKind;
  }
  throw new ValidationException('unknown or missing "failure" query parameter', {
    parameter: 'failure',
    validValues: [...FAILURE_KINDS],
  });
}

function parseScenarioPatch(raw: unknown): Partial<ScenarioState> {
  const fields: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationException('scenario patch body must be a JSON object', {
      parameter: 'body',
      fields: { body: 'must be a JSON object' },
    });
  }

  const record = raw as Record<string, unknown>;
  const known = ['dataMode', 'injectFailure'] as const;
  for (const key of Object.keys(record)) {
    if (!(known as readonly string[]).includes(key)) {
      fields[key] = 'unknown field — only dataMode and injectFailure are accepted';
    }
  }
  if (record.dataMode !== undefined && record.dataMode !== 'fake' && record.dataMode !== 'live') {
    fields.dataMode = 'must be "fake" or "live"';
  }
  if (record.injectFailure !== undefined && typeof record.injectFailure !== 'boolean') {
    fields.injectFailure = 'must be a boolean';
  }
  if (Object.keys(fields).length > 0) {
    throw new ValidationException('scenario patch body is invalid', { parameter: 'body', fields });
  }

  // Mutable mirror of Partial<ScenarioState> — the interface's readonly
  // modifiers apply to consumers, not to the code assembling the patch. The
  // value checks double as narrowing: anything else already failed validation
  // (including JSON null, which survives a !== undefined check).
  const patch: { -readonly [K in keyof ScenarioState]?: ScenarioState[K] } = {};
  if (record.dataMode === 'fake' || record.dataMode === 'live') patch.dataMode = record.dataMode;
  if (typeof record.injectFailure === 'boolean') patch.injectFailure = record.injectFailure;
  return patch;
}

function scenarioController(_req: Request, res: Response): void {
  res.json(getContainer().scenarioStore.get());
}

function patchScenarioController(req: Request, res: Response): void {
  const patch = parseScenarioPatch(req.body);
  let state: ScenarioState;
  try {
    state = getContainer().scenarioStore.set(patch);
  } catch (err) {
    // The store defends its own invariants too; if its rules ever diverge from
    // parseScenarioPatch, that must still surface as a 400, never a 500.
    throw new ValidationException('scenario patch body is invalid', { parameter: 'body' }, err);
  }
  res.json(state);
}

async function statusController(_req: Request, res: Response): Promise<void> {
  const result = await getContainer().demoService.status();
  if (!result.ok) throw failureToException(result.error);
  res.json(result.value);
}

/**
 * Thin controller: assembles runtime facts (process), config (appConfig), and
 * wiring state (scenarioStore through the container) — no business logic, and
 * every value is read per request so the response always reflects "now".
 */
function appInfoController(_req: Request, res: Response): void {
  res.json({
    app: 'express_developers_guide',
    nodeVersion: process.version,
    expressVersion,
    env: appConfig.nodeEnv,
    uptimeSeconds: Math.floor(process.uptime()),
    pid: process.pid,
    scenario: getContainer().scenarioStore.get(),
  });
}

async function failureDemoController(req: Request, _res: Response): Promise<void> {
  const kind = parseFailureKind(req.query.failure);
  throw failureToException(failure(kind, `injected demo failure of kind "${kind}"`));
}

/**
 * GET /api/demo/errors/taxonomy — the exception-handling topic's error
 * explorer renders this table. It is assembled FROM the real maps in
 * failures.ts (not restated here), so the UI the student sees can never
 * drift from the code that actually enforces the mapping.
 */
function errorTaxonomyController(_req: Request, res: Response): void {
  res.json({
    source: 'core/error_handling/failures.ts (FAILURE_KINDS + FAILURE_HTTP_STATUS + FAILURE_ERROR_CODE)',
    kinds: FAILURE_KINDS.map((kind) => ({
      kind,
      httpStatus: FAILURE_HTTP_STATUS[kind],
      errorCode: FAILURE_ERROR_CODE[kind],
    })),
  });
}

// --- TypeScript-demo endpoints (ts:runtime-types) ---------------------------

/** One step of the runtime narrowing trace served by /api/demo/ts/types. */
interface NarrowingStep {
  /** JSON representation of the probed value. */
  value: string;
  /** The runtime check that ran. */
  check: string;
  /** The type the value narrows to once that check passes. */
  narrowedTo: string;
}

/** Runtime type facts about one value: typeof plus the two null/array gotchas. */
interface ValueType {
  typeof: string;
  isArray: boolean;
  isNull: boolean;
}

/** A ValueType tagged with its key — a top-level object field or array element. */
interface ValueTypeEntry extends ValueType {
  key: string;
  /** Present when the value is an array: one level of element reports. */
  elements?: ({ index: number } & ValueType)[];
}

function describeValue(value: unknown): ValueType {
  return { typeof: typeof value, isArray: Array.isArray(value), isNull: value === null };
}

/**
 * Thin controller: assembles the showcase for the ts:runtime-types client demo
 * — a Result produced by the real ok() (serialized the way every use case
 * reports success) plus a narrowing trace that runs real runtime checks over
 * sample values. The checks are exactly the ones TypeScript trusts when
 * narrowing `unknown` — here observed live instead of at compile time.
 */
function tsTypesController(_req: Request, res: Response): void {
  const showcase = {
    language: 'TypeScript',
    compiledTo: 'plain JavaScript — every type erased before Node runs a line',
    checkedBy: 'tsc with strict mode, at compile time only',
    runtimeKnows: 'typeof strings, Array.isArray, and === null — nothing else',
  };

  const probes: readonly unknown[] = ['authentication', 42, ['read', 'write'], { ok: true }, null];
  const narrow = (probe: unknown): NarrowingStep => {
    const json = JSON.stringify(probe);
    if (probe === null) return { value: json, check: 'value === null', narrowedTo: 'null' };
    if (Array.isArray(probe)) {
      return { value: json, check: 'Array.isArray(value)', narrowedTo: 'unknown[]' };
    }
    const probedType = typeof probe;
    if (probedType === 'string' || probedType === 'number' || probedType === 'boolean') {
      return { value: json, check: `typeof value === '${probedType}'`, narrowedTo: probedType };
    }
    return { value: json, check: 'typeof value === object && value !== null', narrowedTo: 'object' };
  };

  res.json({ result: ok(showcase), narrowing: probes.map(narrow) });
}

/**
 * Thin controller: the erasure proof. Accepts ANY JSON body and reports what
 * the runtime actually received — TypeScript's types were erased long before
 * this handler ran, so only runtime inspection can describe the value.
 * express.json() runs in strict mode: bare scalars (42, "hi", null) are
 * rejected with a 400 before reaching here, so objects and arrays are this
 * demo's input space.
 */
function tsEchoController(req: Request, res: Response): void {
  const received: unknown = req.body;

  const entryFor = (key: string, value: unknown): ValueTypeEntry => {
    const base = describeValue(value);
    if (!base.isArray) return { key, ...base };
    const elements = (value as readonly unknown[]).map((element, index) => ({
      index,
      ...describeValue(element),
    }));
    return { key, ...base, elements };
  };

  const report = describeValue(received);
  const entries: ValueTypeEntry[] = Array.isArray(received)
    ? received.map((value, index) => entryFor(String(index), value))
    : typeof received === 'object' && received !== null
      ? Object.entries(received as Record<string, unknown>).map(([key, value]) =>
          entryFor(key, value),
        )
      : [];

  const nullsPresent =
    report.isNull ||
    entries.some(
      (entry) => entry.isNull || (entry.elements ?? []).some((element) => element.isNull),
    );

  res.json({ received, typeReport: { ...report, entries, nullsPresent } });
}

export const demoRouter = Router();
demoRouter.get('/demo/scenario', scenarioController);
demoRouter.patch('/demo/scenario', patchScenarioController);
demoRouter.get('/demo/status', statusController);
demoRouter.get('/demo/app-info', appInfoController);
demoRouter.get('/demo/error', failureDemoController);
demoRouter.get('/demo/errors/taxonomy', errorTaxonomyController);
demoRouter.get('/demo/ts/types', tsTypesController);
demoRouter.post('/demo/ts/echo', tsEchoController);
