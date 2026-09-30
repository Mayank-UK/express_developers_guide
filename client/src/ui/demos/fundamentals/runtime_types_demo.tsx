import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';

/**
 * Demo for DemoBlock `ts:runtime-types` — two panels over two real endpoints:
 * - POST /api/demo/ts/echo — send ANY JSON and get back a runtime type report
 *   of what the server received (the erasure proof: no compile-time type
 *   survives to the handler)
 * - GET  /api/demo/ts/types — a serialized Result value plus a narrowing trace
 *   produced by real runtime checks on the server
 */

const PREFILLED_BODY = '{"title": 42, "tags": ["a", null]}';

interface NarrowingStep {
  value: string;
  check: string;
  narrowedTo: string;
}

interface TypesShowcase {
  language: string;
  compiledTo: string;
  checkedBy: string;
  runtimeKnows: string;
}

interface TsTypesResponse {
  result: { ok: boolean; value: TypesShowcase };
  narrowing: NarrowingStep[];
}

interface ValueType {
  typeof: string;
  isArray: boolean;
  isNull: boolean;
}

interface ElementReport extends ValueType {
  index: number;
}

interface EntryReport extends ValueType {
  key: string;
  elements?: ElementReport[];
}

interface TypeReport extends ValueType {
  entries: EntryReport[];
  nullsPresent: boolean;
}

interface EchoResponse {
  received: unknown;
  typeReport: TypeReport;
}

type ShowcaseState =
  | { kind: 'loading' }
  | { kind: 'ready'; payload: TsTypesResponse }
  | { kind: 'error'; message: string };

type EchoState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; payload: EchoResponse }
  | { kind: 'error'; message: string };

/** Pull the server's message out of the `{ error: { message } }` envelope. */
function envelopeMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
    }
  }
  return `Request failed with status ${status}.`;
}

async function fetchShowcase(): Promise<ShowcaseState> {
  try {
    const response = await fetch('/api/demo/ts/types', { headers: { accept: 'application/json' } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { kind: 'error', message: envelopeMessage(body, response.status) };
    if (typeof body !== 'object' || body === null) {
      return { kind: 'error', message: envelopeMessage(null, response.status) };
    }
    return { kind: 'ready', payload: body as TsTypesResponse };
  } catch {
    return { kind: 'error', message: 'Could not reach the server.' };
  }
}

async function postEcho(parsedBody: unknown): Promise<EchoState> {
  try {
    const response = await fetch('/api/demo/ts/echo', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(parsedBody),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { kind: 'error', message: envelopeMessage(body, response.status) };
    if (typeof body !== 'object' || body === null) {
      return { kind: 'error', message: envelopeMessage(null, response.status) };
    }
    return { kind: 'done', payload: body as EchoResponse };
  } catch {
    return { kind: 'error', message: 'Could not reach the server.' };
  }
}

function showcaseRows(showcase: TypesShowcase): { label: string; value: string }[] {
  return [
    { label: 'language', value: showcase.language },
    { label: 'compiled to', value: showcase.compiledTo },
    { label: 'checked by', value: showcase.checkedBy },
    { label: 'runtime knows', value: showcase.runtimeKnows },
  ];
}

function yesNo(flag: boolean): string {
  return flag ? 'yes' : 'no';
}

const CELL = 'border-b border-outline px-xs py-xs';
const OVERLINE = 'text-overline font-semibold uppercase tracking-[0.08em] text-on-surface-variant';

/** One report row per entry, plus one indented row per array element. */
function ReportRows({ entry }: { entry: EntryReport }) {
  return (
    <>
      <tr>
        <td className={`${CELL} font-mono`}>{entry.key}</td>
        <td className={`${CELL} font-mono`}>{entry.typeof}</td>
        <td className={CELL}>{yesNo(entry.isArray)}</td>
        <td className={CELL}>{yesNo(entry.isNull)}</td>
      </tr>
      {(entry.elements ?? []).map((element) => (
        <tr key={`${entry.key}[${element.index}]`}>
          <td className={`${CELL} pl-md font-mono text-on-surface-variant`}>
            {entry.key}[{element.index}]
          </td>
          <td className={`${CELL} font-mono text-on-surface-variant`}>{element.typeof}</td>
          <td className={`${CELL} text-on-surface-variant`}>{yesNo(element.isArray)}</td>
          <td className={`${CELL} text-on-surface-variant`}>{yesNo(element.isNull)}</td>
        </tr>
      ))}
    </>
  );
}

export default function RuntimeTypesDemo() {
  const [showcase, setShowcase] = useState<ShowcaseState>({ kind: 'loading' });
  const [body, setBody] = useState<string>(PREFILLED_BODY);
  const [echo, setEcho] = useState<EchoState>({ kind: 'idle' });

  const refreshShowcase = useCallback(() => {
    setShowcase({ kind: 'loading' });
    void fetchShowcase().then(setShowcase);
  }, []);

  useEffect(() => {
    void fetchShowcase().then(setShowcase);
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      setEcho({ kind: 'error', message: 'That text is not valid JSON — nothing was sent.' });
      return;
    }
    setEcho({ kind: 'busy' });
    void postEcho(parsed).then(setEcho);
  };

  const onBodyChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setBody(event.target.value);
  };

  return (
    <div className="flex flex-col gap-md">
      {/* Panel (a): POST any JSON, inspect what the runtime received. */}
      <section className="flex flex-col gap-sm">
        <p className={OVERLINE}>POST any JSON — what does the runtime actually receive?</p>
        <form onSubmit={onSubmit} className="flex flex-col gap-xs">
          <label htmlFor="ts-echo-body" className="text-body-sm text-on-surface">
            JSON body
          </label>
          <textarea
            id="ts-echo-body"
            data-testid="ts-echo-input"
            value={body}
            onChange={onBodyChange}
            rows={3}
            spellCheck={false}
            className="rounded-md border border-outline bg-surface px-sm py-xs font-mono text-body-sm text-on-surface"
          />
          <button
            type="submit"
            data-testid="ts-echo-submit"
            disabled={echo.kind === 'busy'}
            className="w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
          >
            {echo.kind === 'busy' ? 'posting…' : 'POST it'}
          </button>
          <p className="text-body-sm text-on-surface-variant">
            express.json() strict mode accepts objects and arrays only — a bare scalar like 42 is
            rejected with a 400 before the handler runs.
          </p>
        </form>

        {echo.kind === 'error' && (
          <p data-testid="ts-echo-error" role="alert" className="text-body-sm text-error">
            fail — {echo.message}
          </p>
        )}

        {echo.kind === 'done' && (
          <div data-testid="ts-echo-report" className="flex flex-col gap-xs">
            <div className="rounded-md border border-outline bg-surface px-sm py-xs">
              <p className={OVERLINE}>the server received</p>
              <pre className="overflow-x-auto font-mono text-body-sm text-on-surface">
                {JSON.stringify(echo.payload.received, null, 2)}
              </pre>
            </div>
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="border-b border-outline px-xs py-xs font-semibold">value</th>
                  <th className="border-b border-outline px-xs py-xs font-semibold">typeof</th>
                  <th className="border-b border-outline px-xs py-xs font-semibold">array?</th>
                  <th className="border-b border-outline px-xs py-xs font-semibold">null?</th>
                </tr>
              </thead>
              <tbody className="text-on-surface">
                <tr>
                  <td className={`${CELL} font-mono`}>(body)</td>
                  <td className={`${CELL} font-mono`}>{echo.payload.typeReport.typeof}</td>
                  <td className={CELL}>{yesNo(echo.payload.typeReport.isArray)}</td>
                  <td className={CELL}>{yesNo(echo.payload.typeReport.isNull)}</td>
                </tr>
                {echo.payload.typeReport.entries.map((entry) => (
                  <ReportRows key={entry.key} entry={entry} />
                ))}
              </tbody>
            </table>
            <p data-testid="ts-echo-nulls" className="text-body-sm text-on-surface-variant">
              nulls present: {yesNo(echo.payload.typeReport.nullsPresent)}
              {echo.payload.typeReport.nullsPresent
                ? ' — typeof null is "object"; only === null catches it'
                : ''}
            </p>
          </div>
        )}
      </section>

      {/* Panel (b): the GET showcase — a serialized Result + narrowing trace. */}
      <section className="flex flex-col gap-sm">
        <p className={OVERLINE}>GET /api/demo/ts/types — a live Result and a narrowing trace</p>

        {showcase.kind === 'loading' && (
          <p data-testid="ts-types-loading" className="text-body-sm text-on-surface-variant">
            asking the server…
          </p>
        )}

        {showcase.kind === 'error' && (
          <p data-testid="ts-types-error" role="alert" className="text-body-sm text-error">
            fail — {showcase.message}
          </p>
        )}

        {showcase.kind === 'ready' && (
          <>
            <p className="text-body-sm text-on-surface-variant">
              result.ok = {String(showcase.payload.result.ok)} — the value it carries:
            </p>
            <dl
              data-testid="ts-types-fields"
              className="grid grid-cols-1 gap-xs sm:grid-cols-2"
            >
              {showcaseRows(showcase.payload.result.value).map((row) => (
                <div
                  key={row.label}
                  className="flex flex-col rounded-md border border-outline bg-surface px-sm py-xs"
                >
                  <dt className={OVERLINE}>{row.label}</dt>
                  <dd className="font-mono text-body-sm text-on-surface">{row.value}</dd>
                </div>
              ))}
            </dl>
            <table data-testid="ts-types-narrowing" className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="border-b border-outline px-xs py-xs font-semibold">value</th>
                  <th className="border-b border-outline px-xs py-xs font-semibold">
                    runtime check
                  </th>
                  <th className="border-b border-outline px-xs py-xs font-semibold">narrows to</th>
                </tr>
              </thead>
              <tbody className="text-on-surface">
                {showcase.payload.narrowing.map((step) => (
                  <tr key={`${step.check}:${step.value}`}>
                    <td className={`${CELL} font-mono`}>{step.value}</td>
                    <td className={`${CELL} font-mono`}>{step.check}</td>
                    <td className={`${CELL} font-mono`}>{step.narrowedTo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <button
                type="button"
                onClick={refreshShowcase}
                className="rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
              >
                refresh showcase
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
