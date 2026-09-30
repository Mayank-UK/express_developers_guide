import { useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `db:uuid` — the ID strategy lesson, generated live: one
 * batch of v4 (122 random bits) and one of v7 (48-bit unix-ms prefix + a
 * monotonic counter, RFC 9562), each shown in GENERATION order and in SORTED
 * order. The v7 panel's two lists are identical every time — time-ordered ids
 * sort as they were made — while v4's scatter needs the sort to look sane.
 */

const UUID_URL = '/api/demo/db/uuid';

const COUNT_OPTIONS = [4, 8, 12, 24, 48, 64] as const;
const DEFAULT_COUNT = 12;

interface UuidSide {
  asGenerated: string[];
  sorted: string[];
  sortsAsGenerated: boolean;
}

interface UuidOutcome {
  count: number;
  v4: UuidSide;
  v7: UuidSide;
  explain: string;
}

type UuidState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'answered'; outcome: UuidOutcome }
  | { kind: 'failed'; problem: string };

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const PRE_SCROLL =
  'max-h-48 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-caption whitespace-pre break-all';
const INPUT =
  'w-full rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const LABEL = 'block font-mono text-caption text-on-surface-variant';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' ? value : fallback;

/** Defensive parsing: only trust the keys the endpoint contract promises. */
function parseUuidSide(value: unknown): UuidSide | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.asGenerated) || !Array.isArray(value.sorted)) return null;
  return {
    asGenerated: value.asGenerated.map((id) => String(id)),
    sorted: value.sorted.map((id) => String(id)),
    sortsAsGenerated: value.sortsAsGenerated === true,
  };
}

function parseUuidOutcome(value: unknown): UuidOutcome | null {
  if (!isRecord(value)) return null;
  const v4 = parseUuidSide(value.v4);
  const v7 = parseUuidSide(value.v7);
  if (v4 === null || v7 === null) return null;
  return {
    count: typeof value.count === 'number' && Number.isFinite(value.count) ? value.count : 0,
    v4,
    v7,
    explain: asString(value.explain, ''),
  };
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') return response.text();
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

/** One version panel: the generation-order list beside the sorted list. */
function UuidVersionPanel({
  testId,
  title,
  caption,
  side,
}: {
  testId: string;
  title: string;
  caption: string;
  side: UuidSide;
}): ReactNode {
  return (
    <section data-testid={testId} className="flex flex-col gap-sm rounded-md border border-outline p-sm">
      <div className="flex flex-wrap items-center gap-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">{title}</h3>
        <span data-testid={`${testId}-order-chip`} className={side.sortsAsGenerated ? CHIP_OK : CHIP}>
          {side.sortsAsGenerated ? 'sorted === generated' : 'sorted ≠ generated'}
        </span>
      </div>
      <p className="text-caption text-on-surface-variant">{caption}</p>
      <div className="grid gap-xs sm:grid-cols-2">
        <div className="flex flex-col gap-xxs">
          <p className={LABEL}>as generated</p>
          <pre data-testid={`${testId}-as-generated`} className={PRE_SCROLL}>
            {side.asGenerated.join('\n')}
          </pre>
        </div>
        <div className="flex flex-col gap-xxs">
          <p className={LABEL}>sorted</p>
          <pre data-testid={`${testId}-sorted`} className={PRE_SCROLL}>
            {side.sorted.join('\n')}
          </pre>
        </div>
      </div>
    </section>
  );
}

export default function UuidStrategyDemo(): ReactNode {
  const [count, setCount] = useState<string>(String(DEFAULT_COUNT));
  const [uuidState, setUuidState] = useState<UuidState>({ kind: 'idle' });

  const generate = (): void => {
    setUuidState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`${UUID_URL}?count=${count}`);
        const text = await readBodyText(response);
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseUuidOutcome(parsed.value) : null;
        if (shaped === null) {
          setUuidState({
            kind: 'failed',
            problem: `status ${String(response.status)} — the answer was not a uuid batch:\n${text}`,
          });
          return;
        }
        setUuidState({ kind: 'answered', outcome: shaped });
      } catch {
        setUuidState({
          kind: 'failed',
          problem: 'could not reach the server — is the guide running on :4000?',
        });
      }
    })();
  };

  const outcome = uuidState.kind === 'answered' ? uuidState.outcome : null;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="uuid-strategy-summary" className="text-body-sm text-on-surface">
        Two key strategies, one batch each: v4 is 122 random bits — same uniqueness, uniform
        scatter — while v7 leads with a 48-bit millisecond timestamp plus a monotonic counter, so
        ids compare in generation order. Read each panel's two lists against each other: v7's are
        identical, v4's are not.
      </p>

      <div className="flex flex-wrap items-end gap-sm rounded-md border border-outline p-sm">
        <label className="flex flex-col gap-xxs">
          <span className={LABEL}>batch size</span>
          <select
            data-testid="uuid-strategy-count"
            value={count}
            onChange={(event) => setCount(event.target.value)}
            className={INPUT}
          >
            {COUNT_OPTIONS.map((option) => (
              <option key={option} value={String(option)}>
                {String(option)} ids
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="uuid-strategy-generate"
          onClick={generate}
          disabled={uuidState.kind === 'loading'}
          className={BUTTON_PRIMARY}
        >
          {uuidState.kind === 'loading' ? 'generating…' : 'generate both batches'}
        </button>
        {outcome !== null && (
          <span data-testid="uuid-strategy-count-chip" className={CHIP}>
            {String(outcome.count)} ids per side
          </span>
        )}
      </div>

      {uuidState.kind === 'idle' && (
        <p data-testid="uuid-strategy-idle" className="text-body-sm text-on-surface-variant">
          no batch yet — generate one and compare the orders
        </p>
      )}
      {uuidState.kind === 'failed' && (
        <pre data-testid="uuid-strategy-failed" className={PRE_SCROLL}>
          {uuidState.problem}
        </pre>
      )}

      {outcome !== null && (
        <>
          <div className="grid gap-sm sm:grid-cols-2">
            <UuidVersionPanel
              testId="uuid-strategy-v4"
              title="UUID v4 — random"
              caption="uniform scatter: adjacent generations land anywhere in the keyspace — B-tree inserts too"
              side={outcome.v4}
            />
            <UuidVersionPanel
              testId="uuid-strategy-v7"
              title="UUID v7 — time-ordered"
              caption="timestamp first: newer sorts greater, so the sorted list equals the generated list"
              side={outcome.v7}
            />
          </div>
          <p data-testid="uuid-strategy-explain" className="text-body-sm text-on-surface">
            {outcome.explain}
          </p>
        </>
      )}
    </div>
  );
}
