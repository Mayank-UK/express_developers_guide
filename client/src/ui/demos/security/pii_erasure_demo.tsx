import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `security:pii` — the Security topic's GDPR-style erasure
 * lab over the real endpoints (security_pii_demo_routes.ts):
 *
 * 1. THE CUSTOMER LIST — the fixture population; anonymize one and watch its
 *    ROW stay while its PII goes.
 * 2. RIGHT OF ACCESS — EXPORT renders everything the store can produce about
 *    one person in one machine-readable document: the subject, the linked
 *    orders, and any erasure record. An export that forgets the orders table
 *    fails the audit.
 * 3. RIGHT OF ERASURE — ANONYMIZE with a two-step confirmation: crypto-shred
 *    every PII field (anon_<hash> placeholders), KEEP the row and its order
 *    links — deleting the row would orphan order history. The read-after
 *    proves the honest post-state: the account exists, the identity does not.
 * 4. THE ERASURE LOG — the accounting record regulators ask for: who was
 *    erased, when, what scope, and how many order links survived.
 */

const CUSTOMERS_URL = '/api/demo/security/pii/customers';
const ERASURE_LOG_URL = '/api/demo/security/pii/erasure-log';

const customerUrl = (id: string): string => `/api/demo/security/pii/customers/${id}`;
const exportUrl = (id: string): string => `/api/demo/security/pii/export/${id}`;
const anonymizeUrl = (id: string): string => `/api/demo/security/pii/anonymize/${id}`;

interface CustomerRow {
  id: string;
  name: string;
  email: string;
  anonymized: boolean;
}

/** The anonymize response's customer — placeholders in place of PII. */
interface AnonymizedCustomer {
  id: string;
  name: string;
  email: string;
  anonymizedAt: string | null;
}

interface ErasureEntry {
  customerId: string;
  anonymizedAt: string;
  performedBy: string;
  scope: string[];
  method: string;
  linkedOrdersKept: number;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; customers: CustomerRow[]; erasureCount: number }
  | { kind: 'failed'; problem: string };

type ExportState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; customerId: string; json: string }
  | { kind: 'failed'; problem: string };

type AnonymizeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; alreadyAnonymized: boolean; customer: AnonymizedCustomer | null; linkedOrdersKept: number | null; note: string }
  | { kind: 'failed'; problem: string };

type ReadAfterState =
  | { kind: 'idle' }
  | { kind: 'ready'; customerId: string; orderCount: number; note: string }
  | { kind: 'failed'; problem: string };

type LogState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: ErasureEntry[] }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_DANGER =
  'w-fit rounded-md border border-outline bg-error px-sm py-xs text-body-sm font-semibold text-on-error hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_ERROR =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Pretty-prints JSON bodies for display; passes plain text through. */
function prettyJsonOrText(text: string): string {
  const parsed = tryParseJson(text);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;
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

function errorEnvelopeFromText(text: string): string {
  const parsed = tryParseJson(text);
  if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) {
    const error = (parsed.value as Record<string, unknown>).error;
    const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    if (typeof record.code === 'string' && typeof record.message === 'string') {
      return `${record.code}: ${record.message}`;
    }
  }
  return text;
}

/** One fetch, one body read — { status, bodyText }. */
async function fetchOnce(url: string, init?: RequestInit): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(url, init);
  return { status: response.status, bodyText: await readBodyText(response) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCustomerRows(value: unknown): { customers: CustomerRow[]; erasureCount: number } | null {
  if (!isRecord(value) || !Array.isArray(value.customers)) return null;
  const customers = value.customers.filter(
    (raw): raw is CustomerRow =>
      isRecord(raw) &&
      typeof raw.id === 'string' &&
      typeof raw.name === 'string' &&
      typeof raw.email === 'string' &&
      typeof raw.anonymized === 'boolean',
  );
  if (customers.length === 0) return null;
  return {
    customers,
    erasureCount: typeof value.erasureCount === 'number' ? value.erasureCount : 0,
  };
}

function parseErasureLog(value: unknown): ErasureEntry[] | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) return null;
  return value.entries.filter(
    (raw): raw is ErasureEntry =>
      isRecord(raw) &&
      typeof raw.customerId === 'string' &&
      typeof raw.anonymizedAt === 'string' &&
      typeof raw.performedBy === 'string' &&
      typeof raw.method === 'string' &&
      typeof raw.linkedOrdersKept === 'number' &&
      Array.isArray(raw.scope),
  );
}

function parseReadAfter(value: unknown): { orderCount: number; note: string } | null {
  if (!isRecord(value) || !isRecord(value.customer) || !Array.isArray(value.orders)) return null;
  if (typeof value.note !== 'string') return null;
  return { orderCount: value.orders.length, note: value.note };
}

export default function PiiErasureDemo(): ReactNode {
  const [listState, setListState] = useState<ListState>({ kind: 'loading' });
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [anonymizeState, setAnonymizeState] = useState<AnonymizeState>({ kind: 'idle' });
  const [readAfterState, setReadAfterState] = useState<ReadAfterState>({ kind: 'idle' });
  const [logState, setLogState] = useState<LogState>({ kind: 'loading' });

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reloadList = (): void => {
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(CUSTOMERS_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setListState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const payload = parsed.ok ? parseCustomerRows(parsed.value) : null;
        if (payload === null) {
          setListState({ kind: 'failed', problem: 'unexpected customers payload' });
          return;
        }
        setListState({ kind: 'ready', ...payload });
      } catch {
        if (aliveRef.current) setListState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const reloadLog = (): void => {
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(ERASURE_LOG_URL);
        if (!aliveRef.current) return;
        if (status >= 400) {
          setLogState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const entries = parsed.ok ? parseErasureLog(parsed.value) : null;
        if (entries === null) {
          setLogState({ kind: 'failed', problem: 'unexpected erasure-log payload' });
          return;
        }
        setLogState({ kind: 'ready', entries });
      } catch {
        if (aliveRef.current) setLogState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  useEffect(() => {
    reloadList();
    reloadLog();
  }, []);

  const exportCustomer = (id: string): void => {
    setExportState({ kind: 'loading' });
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(exportUrl(id));
        if (!aliveRef.current) return;
        if (status >= 400) {
          setExportState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        setExportState({ kind: 'ready', customerId: id, json: prettyJsonOrText(bodyText) });
      } catch {
        if (aliveRef.current) setExportState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const anonymize = (id: string): void => {
    setAnonymizeState({ kind: 'loading' });
    setConfirmingId(null);
    void (async () => {
      try {
        const { status, bodyText } = await fetchOnce(anonymizeUrl(id), { method: 'POST' });
        if (!aliveRef.current) return;
        if (status >= 400) {
          setAnonymizeState({ kind: 'failed', problem: errorEnvelopeFromText(bodyText) });
          return;
        }
        const parsed = tryParseJson(bodyText);
        const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
        if (
          record === null ||
          (record.anonymized !== true && record.alreadyAnonymized !== true) ||
          typeof record.note !== 'string'
        ) {
          setAnonymizeState({ kind: 'failed', problem: 'unexpected anonymize payload' });
          return;
        }
        const customer =
          isRecord(record.customer) &&
          typeof record.customer.id === 'string' &&
          typeof record.customer.name === 'string' &&
          typeof record.customer.email === 'string'
            ? {
                id: record.customer.id,
                name: record.customer.name,
                email: record.customer.email,
                anonymizedAt:
                  typeof record.customer.anonymizedAt === 'string' ? record.customer.anonymizedAt : null,
              }
            : null;
        setAnonymizeState({
          kind: 'done',
          alreadyAnonymized: record.alreadyAnonymized === true,
          customer,
          linkedOrdersKept:
            typeof record.linkedOrdersKept === 'number' ? record.linkedOrdersKept : null,
          note: record.note,
        });
        // The evidence trail: list (row survived, PII gone), log (the
        // accounting entry), and the read-after (order links still resolve).
        reloadList();
        reloadLog();
        void (async () => {
          try {
            const { status: readStatus, bodyText: readText } = await fetchOnce(customerUrl(id));
            if (!aliveRef.current) return;
            if (readStatus >= 400) {
              setReadAfterState({ kind: 'failed', problem: errorEnvelopeFromText(readText) });
              return;
            }
            const readParsed = tryParseJson(readText);
            const readAfter = readParsed.ok ? parseReadAfter(readParsed.value) : null;
            if (readAfter === null) {
              setReadAfterState({ kind: 'failed', problem: 'unexpected read-after payload' });
              return;
            }
            setReadAfterState({ kind: 'ready', customerId: id, ...readAfter });
          } catch {
            if (aliveRef.current) setReadAfterState({ kind: 'failed', problem: UNREACHABLE });
          }
        })();
      } catch {
        if (aliveRef.current) setAnonymizeState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="pii-summary" className="text-body-sm text-on-surface">
        The four GDPR-style rights, live: list the fixture customers, export one person&apos;s
        everything (right of access), anonymize with a confirmation (right of erasure — the ROW and
        its order links survive; the identity does not), and read the erasure log regulators ask
        for.
      </p>

      {/* 1 — the customer list */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">
            1 · The customer list
          </h3>
          {listState.kind === 'ready' && (
            <span data-testid="pii-erasure-count" className={CHIP}>
              erasures logged: {String(listState.erasureCount)}
            </span>
          )}
        </div>

        {listState.kind === 'loading' && (
          <p data-testid="pii-customers-loading" className="text-caption text-on-surface-variant">
            loading the fixture population…
          </p>
        )}
        {listState.kind === 'failed' && (
          <pre data-testid="pii-customers-failed" className={PRE}>
            {listState.problem}
          </pre>
        )}

        {listState.kind === 'ready' && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-caption">
              <thead>
                <tr className="text-left text-on-surface-variant">
                  <th className="border-b border-outline px-xs py-xxs">id</th>
                  <th className="border-b border-outline px-xs py-xxs">name</th>
                  <th className="border-b border-outline px-xs py-xxs">email</th>
                  <th className="border-b border-outline px-xs py-xxs">state</th>
                  <th className="border-b border-outline px-xs py-xxs">rights</th>
                </tr>
              </thead>
              <tbody>
                {listState.customers.map((customer) => (
                  <tr key={customer.id} data-testid="pii-customer-row">
                    <td className="border-b border-outline px-xs py-xxs">{customer.id}</td>
                    <td className="border-b border-outline px-xs py-xxs">{customer.name}</td>
                    <td className="border-b border-outline px-xs py-xxs break-all">{customer.email}</td>
                    <td className="border-b border-outline px-xs py-xxs">
                      {customer.anonymized ? (
                        <span data-testid={`pii-anonymized-chip-${customer.id}`} className={CHIP_ERROR}>
                          anonymized
                        </span>
                      ) : (
                        <span className={CHIP_OK}>pii present</span>
                      )}
                    </td>
                    <td className="border-b border-outline px-xs py-xxs">
                      <span className="flex flex-wrap items-center gap-xxs">
                        <button
                          type="button"
                          data-testid={`pii-export-${customer.id}`}
                          onClick={() => exportCustomer(customer.id)}
                          className={BUTTON}
                        >
                          export
                        </button>
                        {customer.anonymized ? (
                          <span className="text-caption text-on-surface-variant">
                            already shredded (idempotent)
                          </span>
                        ) : confirmingId === customer.id ? (
                          <>
                            <button
                              type="button"
                              data-testid={`pii-confirm-${customer.id}`}
                              onClick={() => anonymize(customer.id)}
                              className={BUTTON_DANGER}
                            >
                              CONFIRM ERASURE
                            </button>
                            <button
                              type="button"
                              data-testid={`pii-cancel-${customer.id}`}
                              onClick={() => setConfirmingId(null)}
                              className={BUTTON}
                            >
                              cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            data-testid={`pii-anonymize-${customer.id}`}
                            onClick={() => setConfirmingId(customer.id)}
                            className={BUTTON_DANGER}
                          >
                            anonymize…
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 2 — right of access */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          2 · Right of access — the export
        </h3>
        {exportState.kind === 'idle' && (
          <p data-testid="pii-export-idle" className="text-caption text-on-surface-variant">
            press EXPORT on a row — everything the store can produce about that one person, in one
            machine-readable document
          </p>
        )}
        {exportState.kind === 'loading' && (
          <p data-testid="pii-export-loading" className="text-caption text-on-surface-variant">
            assembling the export…
          </p>
        )}
        {exportState.kind === 'failed' && (
          <pre data-testid="pii-export-failed" className={PRE}>
            {exportState.problem}
          </pre>
        )}
        {exportState.kind === 'ready' && (
          <div data-testid="pii-export-result" className="flex flex-col gap-xxs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_OK}>{exportState.customerId}</span>
              <span className="text-on-surface-variant">
                subject + linked orders + erasure record, one document
              </span>
            </p>
            <pre className={PRE}>{exportState.json}</pre>
          </div>
        )}
      </section>

      {/* 3 — right of erasure + the read-after */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          3 · Right of erasure — anonymize (crypto-shred)
        </h3>

        {anonymizeState.kind === 'idle' && (
          <p data-testid="pii-anonymize-idle" className="text-caption text-on-surface-variant">
            ANONYMIZE asks for a confirmation — irreversibility deserves a second look, even in a demo
          </p>
        )}
        {anonymizeState.kind === 'loading' && (
          <p data-testid="pii-anonymize-loading" className="text-caption text-on-surface-variant">
            overwriting every PII field…
          </p>
        )}
        {anonymizeState.kind === 'failed' && (
          <pre data-testid="pii-anonymize-failed" className={PRE}>
            {anonymizeState.problem}
          </pre>
        )}

        {anonymizeState.kind === 'done' && (
          <div data-testid="pii-anonymize-result" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              {anonymizeState.alreadyAnonymized ? (
                <span className={CHIP}>ALREADY SHREDDED — idempotent</span>
              ) : (
                <span className={CHIP_ERROR}>ANONYMIZED</span>
              )}
              {anonymizeState.linkedOrdersKept !== null && (
                <span data-testid="pii-orders-kept" className={CHIP_OK}>
                  {String(anonymizeState.linkedOrdersKept)} order links kept
                </span>
              )}
            </p>
            {anonymizeState.customer !== null && (
              <div className="flex flex-col gap-xxs font-mono text-caption">
                <p data-testid="pii-anon-name" className="break-all text-on-surface">
                  name → {anonymizeState.customer.name}
                </p>
                <p data-testid="pii-anon-email" className="break-all text-on-surface">
                  email → {anonymizeState.customer.email}
                </p>
              </div>
            )}
            <p className="text-caption text-on-surface-variant">{anonymizeState.note}</p>

            {readAfterState.kind === 'ready' && (
              <p data-testid="pii-read-after" className="flex flex-wrap items-center gap-xs font-mono text-caption">
                <span className={CHIP}>{readAfterState.customerId}</span>
                <span data-testid="pii-read-after-orders" className={CHIP_OK}>
                  {String(readAfterState.orderCount)} orders still resolve
                </span>
                <span className="text-on-surface-variant">{readAfterState.note}</span>
              </p>
            )}
            {readAfterState.kind === 'failed' && (
              <pre data-testid="pii-read-after-failed" className={PRE}>
                {readAfterState.problem}
              </pre>
            )}
          </div>
        )}
      </section>

      {/* 4 — the erasure log */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          4 · The erasure log — the accounting record
        </h3>

        {logState.kind === 'loading' && (
          <p data-testid="pii-log-loading" className="text-caption text-on-surface-variant">
            loading the log…
          </p>
        )}
        {logState.kind === 'failed' && (
          <pre data-testid="pii-log-failed" className={PRE}>
            {logState.problem}
          </pre>
        )}

        {logState.kind === 'ready' && (
          <div data-testid="pii-erasure-log" className="flex flex-col gap-xs">
            {logState.entries.length === 0 ? (
              <p data-testid="pii-log-empty" className="text-caption text-on-surface-variant">
                no erasures yet — anonymize a customer and the entry lands here (who, when, what
                scope, how many order links survived)
              </p>
            ) : (
              logState.entries.map((entry) => (
                <div
                  key={`${entry.customerId}-${entry.anonymizedAt}`}
                  data-testid="pii-erasure-entry"
                  className="flex flex-col gap-xxs rounded-md border border-outline p-xs"
                >
                  <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
                    <span className={CHIP_ERROR}>{entry.customerId}</span>
                    <span className="text-on-surface-variant">{entry.anonymizedAt}</span>
                    <span className={CHIP}>by {entry.performedBy}</span>
                    <span data-testid="pii-entry-orders" className={CHIP_OK}>
                      {String(entry.linkedOrdersKept)} links kept
                    </span>
                  </p>
                  <p className="font-mono text-caption break-all text-on-surface-variant">
                    scope ({String(entry.scope.length)} fields): {entry.scope.join(', ')}
                  </p>
                  <p className="font-mono text-caption break-all text-on-surface-variant">
                    method: {entry.method}
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
}
