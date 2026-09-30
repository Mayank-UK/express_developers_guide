import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `validation:arena` — the validation topic's
 * three-validator arena. GET /api/demo/validation/schema serves the canonical
 * rule table (this component renders its form FROM that spec, so the UI and
 * the server cannot disagree about the rules); submitting POSTs the SAME
 * payload to the chosen validator endpoints — all three in parallel by
 * default — and renders one card per library:
 *
 * - the VERDICT (all three always agree on pass/fail for the canonical rules),
 * - the NORMALIZED error list ({ field, message } — identical field names
 *   across the three, including 'tags.0' for array items),
 * - a collapsible RAW response showing what each library natively said
 *   (ZodError.issues, validationResult().array(), Joi error.details).
 *
 * The disagreements are the lesson: prefill the invalid sample to watch all
 * three fail the same four fields, then hand-edit age to the STRING "42" —
 * zod fails it, Joi converts it, express-validator passes it through.
 */

const DEMO_BASE = '/api/demo/validation';

interface FieldSpec {
  field: string;
  type: string;
  required: boolean;
  rule: string;
}

interface EndpointSpec {
  validator: string;
  method: string;
  path: string;
}

interface ArenaSpec {
  mountPath: string;
  objectRule: string;
  fields: readonly FieldSpec[];
  endpoints: readonly EndpointSpec[];
  sampleValid: Record<string, unknown>;
  sampleInvalid: Record<string, unknown>;
}

type ValidatorChoice = 'all' | 'zod' | 'express-validator' | 'joi';

const VALIDATOR_CHOICES: readonly { id: ValidatorChoice; label: string }[] = [
  { id: 'all', label: 'all three (parallel)' },
  { id: 'zod', label: 'zod' },
  { id: 'express-validator', label: 'express-validator' },
  { id: 'joi', label: 'joi' },
];

interface FormState {
  title: string;
  email: string;
  age: string;
  website: string;
  tags: string;
}

const EMPTY_FORM: FormState = { title: '', email: '', age: '', website: '', tags: '' };

interface NormalizedError {
  field: string;
  message: string;
}

interface CardOutcome {
  validator: string;
  url: string;
  state: 'pass' | 'fail' | 'error';
  status: number | null;
  errors: readonly NormalizedError[];
  raw: string;
}

type SpecState =
  | { kind: 'loading' }
  | { kind: 'ready'; spec: ArenaSpec }
  | { kind: 'error' };

type FireState =
  | { kind: 'idle' }
  | { kind: 'running'; count: number }
  | { kind: 'done'; outcomes: readonly CardOutcome[] };

/** Client-side payload validation before use (the API layer's house rule). */
function parseSpec(value: unknown): ArenaSpec | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.fields) ||
    candidate.fields.length === 0 ||
    !Array.isArray(candidate.endpoints) ||
    candidate.endpoints.length === 0
  ) {
    return null;
  }
  const fields: FieldSpec[] = [];
  for (const raw of candidate.fields) {
    if (typeof raw !== 'object' || raw === null) return null;
    const field = raw as Record<string, unknown>;
    if (
      typeof field.field !== 'string' ||
      typeof field.type !== 'string' ||
      typeof field.required !== 'boolean' ||
      typeof field.rule !== 'string'
    ) {
      return null;
    }
    fields.push({ field: field.field, type: field.type, required: field.required, rule: field.rule });
  }
  const endpoints: EndpointSpec[] = [];
  for (const raw of candidate.endpoints) {
    if (typeof raw !== 'object' || raw === null) return null;
    const endpoint = raw as Record<string, unknown>;
    if (typeof endpoint.validator !== 'string' || typeof endpoint.path !== 'string') return null;
    endpoints.push({
      validator: endpoint.validator,
      method: typeof endpoint.method === 'string' ? endpoint.method : 'POST',
      path: endpoint.path,
    });
  }
  const samples: Array<Record<string, unknown>> = [];
  for (const key of ['sampleValid', 'sampleInvalid'] as const) {
    const sample = candidate[key];
    if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) return null;
    samples.push(sample as Record<string, unknown>);
  }
  const [sampleValid, sampleInvalid] = samples;
  if (sampleValid === undefined || sampleInvalid === undefined) return null;
  return {
    mountPath: typeof candidate.mountPath === 'string' ? candidate.mountPath : DEMO_BASE,
    objectRule: typeof candidate.objectRule === 'string' ? candidate.objectRule : '',
    fields,
    endpoints,
    sampleValid,
    sampleInvalid,
  };
}

function parseNormalizedErrors(value: unknown): NormalizedError[] {
  if (!Array.isArray(value)) return [];
  const errors: NormalizedError[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.field === 'string' && typeof candidate.message === 'string') {
      errors.push({ field: candidate.field, message: candidate.message });
    }
  }
  return errors;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads the body as text when the environment provides text() (real fetch),
 * falling back to json() (minimal test doubles) — same contract the other
 * demos use for their defensive response readers.
 */
async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') {
    const text = await response.text();
    return text;
  }
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

/** Comma-separated input → tag array; empty entries are dropped. */
function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Builds the wire payload from the form. age goes out as a JSON NUMBER when
 * it parses as one and as whatever was typed otherwise (so "42" as text —
 * paste it deliberately — lets you watch the coercion divergence); an empty
 * website is OMITTED (optional honored), while every other field is sent
 * exactly as typed, empty strings included — the validators get the truth.
 */
function buildPayload(form: FormState): Record<string, unknown> {
  const ageTrimmed = form.age.trim();
  const age: number | string =
    ageTrimmed !== '' && Number.isFinite(Number(ageTrimmed)) ? Number(ageTrimmed) : ageTrimmed;

  const payload: Record<string, unknown> = {
    title: form.title,
    email: form.email,
    age,
    tags: parseTags(form.tags),
  };
  if (form.website.trim() !== '') {
    payload.website = form.website.trim();
  }
  return payload;
}

function applySample(sample: Record<string, unknown>): FormState {
  const asString = (value: unknown): string => (typeof value === 'string' ? value : String(value));
  const tags = Array.isArray(sample.tags) ? sample.tags.map((tag) => String(tag)).join(', ') : '';
  return {
    title: asString(sample.title ?? ''),
    email: asString(sample.email ?? ''),
    age: sample.age === undefined ? '' : asString(sample.age),
    website: asString(sample.website ?? ''),
    tags,
  };
}

async function fireOne(endpoint: EndpointSpec, payload: Record<string, unknown>): Promise<CardOutcome> {
  const base = { validator: endpoint.validator, url: endpoint.path };
  try {
    const response = await fetch(endpoint.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await readBodyText(response);
    const parsed = tryParseJson(text);
    const raw = parsed.ok ? JSON.stringify(parsed.value, null, 2) : text === '' ? '(empty body)' : text;

    if (response.ok) {
      return { ...base, state: 'pass', status: response.status, errors: [], raw };
    }
    const errorObj =
      parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
        ? (parsed.value as { error?: { errors?: unknown } }).error
        : undefined;
    return {
      ...base,
      state: 'fail',
      status: response.status,
      errors: parseNormalizedErrors(errorObj?.errors),
      raw,
    };
  } catch {
    return { ...base, state: 'error', status: null, errors: [], raw: 'could not reach the server' };
  }
}

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const INPUT =
  'rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none disabled:opacity-50';
const LABEL = 'block font-mono text-caption text-on-surface-variant';
const ERROR = 'text-body-sm text-error';

const PRE =
  'max-h-60 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

function verdictLine(outcome: CardOutcome): string {
  if (outcome.state === 'error') {
    return `error — could not reach the server (POST ${outcome.url})`;
  }
  if (outcome.state === 'pass') {
    return `pass — ${String(outcome.status)} · payload accepted (see raw for the parsed value and this library's notes)`;
  }
  return `fail — ${String(outcome.status)} · ${String(outcome.errors.length)} normalized error(s)`;
}

function cardTone(outcome: CardOutcome): string {
  if (outcome.state === 'pass') {
    return 'rounded-md border border-outline bg-primary px-sm py-xs text-on-primary';
  }
  if (outcome.state === 'fail') {
    return 'rounded-md border border-outline bg-error px-sm py-xs text-on-error';
  }
  return 'rounded-md border border-outline bg-surface px-sm py-xs text-on-surface-variant';
}

/** One validator's result: verdict, normalized errors, collapsible raw body. */
function OutcomeCard({ outcome }: { outcome: CardOutcome }): ReactNode {
  return (
    <div
      data-testid={`validation-arena-card-${outcome.validator}`}
      className="flex flex-col gap-xs rounded-md border border-outline p-sm"
    >
      <div className="flex flex-wrap items-center gap-xs">
        <span className={`${cardTone(outcome)} font-mono text-body-sm font-semibold`}>
          {outcome.validator}
        </span>
        <span data-testid={`validation-arena-verdict-${outcome.validator}`} className="text-body-sm text-on-surface">
          {verdictLine(outcome)}
        </span>
      </div>

      {outcome.state === 'fail' && outcome.errors.length > 0 && (
        <ul data-testid={`validation-arena-errors-${outcome.validator}`} className="flex flex-col gap-xxs">
          {outcome.errors.map((error, index) => (
            <li
              key={`${error.field}-${String(index)}`}
              data-testid={`validation-arena-error-${outcome.validator}-${String(index)}`}
              className="text-body-sm text-on-surface"
            >
              <span className="font-mono font-semibold">{error.field}</span> — {error.message}
            </li>
          ))}
        </ul>
      )}
      {outcome.state === 'fail' && outcome.errors.length === 0 && (
        <p className="text-body-sm text-on-surface-variant">
          no normalized errors in the response — see the raw envelope below
        </p>
      )}

      <details className="text-body-sm">
        <summary className="cursor-pointer text-on-surface-variant">
          raw library response — what {outcome.validator} natively said
        </summary>
        <pre data-testid={`validation-arena-raw-${outcome.validator}`} className={`${PRE} mt-xs`}>
          {outcome.raw}
        </pre>
      </details>
    </div>
  );
}

export default function ValidationArenaDemo() {
  const [specState, setSpecState] = useState<SpecState>({ kind: 'loading' });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [choice, setChoice] = useState<ValidatorChoice>('all');
  const [fireState, setFireState] = useState<FireState>({ kind: 'idle' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadSpec = (): void => {
    setSpecState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`${DEMO_BASE}/schema`, { headers: { accept: 'application/json' } });
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        const spec = parsed.ok ? parseSpec(parsed.value) : null;
        if (!aliveRef.current) return;
        if (response.ok && spec !== null) {
          setSpecState({ kind: 'ready', spec });
        } else {
          setSpecState({ kind: 'error' });
        }
      } catch {
        if (aliveRef.current) setSpecState({ kind: 'error' });
      }
    })();
  };

  // Fetch the rule table once on mount — the form renders FROM it.
  useEffect(() => {
    loadSpec();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (field: keyof FormState, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const prefill = (sample: Record<string, unknown>): void => {
    setForm(applySample(sample));
    setFireState({ kind: 'idle' });
  };

  const submit = (): void => {
    if (specState.kind !== 'ready') return;
    const targets =
      choice === 'all'
        ? specState.spec.endpoints
        : specState.spec.endpoints.filter((endpoint) => endpoint.validator === choice);
    if (targets.length === 0) return;

    const payload = buildPayload(form);
    setFireState({ kind: 'running', count: targets.length });
    void Promise.all(targets.map((endpoint) => fireOne(endpoint, payload))).then((outcomes) => {
      if (!aliveRef.current) return;
      setFireState({ kind: 'done', outcomes });
    });
  };

  const specReady = specState.kind === 'ready';

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="validation-arena-summary" className="text-body-sm text-on-surface">
        One form, one rule table, three validators. The rules below are fetched from{' '}
        <span className="font-mono">GET {DEMO_BASE}/schema</span> — the server owns them, this form
        just renders them. Submit fires the SAME payload at each validator endpoint (in parallel
        when &quot;all three&quot; is selected); every card shows the verdict, the normalized{' '}
        <span className="font-mono">field — message</span> errors, and the library&rsquo;s raw
        response so the idiom differences are visible side by side.
      </p>

      {specState.kind === 'loading' && (
        <p data-testid="validation-arena-spec-loading" className="text-body-sm text-on-surface-variant">
          fetching the canonical rule table…
        </p>
      )}
      {specState.kind === 'error' && (
        <div data-testid="validation-arena-spec-error" className="flex flex-col gap-xs">
          <p role="alert" className={ERROR}>
            could not load the rule table from the server — the arena needs it to render the form.
          </p>
          <button type="button" onClick={loadSpec} className={BUTTON}>
            retry
          </button>
        </div>
      )}

      {specReady && specState.kind === 'ready' && (
        <div data-testid="validation-arena-form" className="flex flex-col gap-sm">
          <p className="text-body-sm text-on-surface-variant">
            {specState.spec.objectRule}. Age goes to the wire as a JSON number when it parses as one
            (paste something else and it travels as typed — the string{' '}
            <span className="font-mono">&quot;42&quot;</span> is the classic experiment); tags are
            comma-separated and empty entries are dropped; an empty website is omitted, not sent.
          </p>

          <div className="grid gap-sm sm:grid-cols-2 lg:grid-cols-3">
            {specState.spec.fields.map((field) => (
              <label key={field.field} className="flex flex-col gap-xxs">
                <span className={LABEL}>
                  {field.field} · {field.type}
                  {field.required ? ' · required' : ' · optional'} — {field.rule}
                </span>
                <input
                  data-testid={`validation-arena-field-${field.field}`}
                  value={form[field.field as keyof FormState] ?? ''}
                  onChange={(event) => update(field.field as keyof FormState, event.target.value)}
                  className={INPUT}
                />
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-sm">
            <label className="flex flex-col gap-xxs">
              <span className={LABEL}>validators to fire</span>
              <select
                data-testid="validation-arena-selector"
                value={choice}
                onChange={(event) => setChoice(event.target.value as ValidatorChoice)}
                className={INPUT}
              >
                {VALIDATOR_CHOICES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              data-testid="validation-arena-prefill-valid"
              onClick={() => prefill(specState.spec.sampleValid)}
              className={BUTTON}
            >
              prefill the valid sample
            </button>
            <button
              type="button"
              data-testid="validation-arena-prefill-invalid"
              onClick={() => prefill(specState.spec.sampleInvalid)}
              className={BUTTON}
            >
              prefill the known-invalid sample
            </button>
            <button
              type="button"
              data-testid="validation-arena-submit"
              onClick={submit}
              disabled={fireState.kind === 'running'}
              className={BUTTON}
            >
              {fireState.kind === 'running' ? 'firing…' : 'submit to the validators'}
            </button>
          </div>
        </div>
      )}

      {fireState.kind === 'running' && (
        <p data-testid="validation-arena-firing" className="text-body-sm text-on-surface-variant">
          firing {String(fireState.count)} validator endpoint{fireState.count === 1 ? '' : 's'}…
        </p>
      )}
      {fireState.kind === 'idle' && (
        <p data-testid="validation-arena-idle" className="text-body-sm text-on-surface-variant">
          No results yet — prefill a sample (or hand-craft a payload) and submit; the known-invalid
          sample fails the same four fields in all three, which is the point.
        </p>
      )}
      {fireState.kind === 'done' && (
        <div className="flex flex-col gap-sm">
          {fireState.outcomes.map((outcome) => (
            <OutcomeCard key={outcome.validator} outcome={outcome} />
          ))}
        </div>
      )}
    </div>
  );
}
