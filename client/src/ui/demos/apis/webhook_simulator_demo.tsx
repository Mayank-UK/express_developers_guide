import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `api:webhook-simulator` — the Webhooks topic's flight
 * simulator. One app plays both roles:
 *
 * - LEFT, the SENDER: pick an event type, flip the tamper switch, SEND →
 *   POST /api/demo/webhooks/send. The route builds a real event, signs the
 *   exact body bytes with HMAC-SHA256 (node:crypto), and self-calls the
 *   receiver when a server is listening. The flight renders in full — event,
 *   signature, HTTP request, and the receiver's outcome — the per-delivery
 *   observability a production sender owes.
 * - RIGHT, the RECEIVER's inbox: GET /api/demo/webhooks/deliveries, refreshed
 *   after every send. Verified deliveries land as cards with a
 *   signature-verified badge; tampered flights come back 401 and never reach
 *   the inbox — verification happens before storage, by design.
 */

const SEND_URL = '/api/demo/webhooks/send';
const DELIVERIES_URL = '/api/demo/webhooks/deliveries';

type EventType = 'post.created' | 'post.updated';

interface SendOutcome {
  status: number;
  body: string;
}

interface SendResponse {
  event: { id: string; type: string };
  signature: string;
  tampered: boolean;
  delivered: boolean;
  outcome?: SendOutcome;
  note?: string;
  tamperNote?: string;
  wouldDeliver: { url: string; headers: Record<string, string>; body: string };
}

interface Delivery {
  id: string;
  receivedAt: string;
  type: string;
  signatureVerified: boolean;
  payload: unknown;
}

type InboxState =
  | { kind: 'loading' }
  | { kind: 'ready'; deliveries: Delivery[] }
  | { kind: 'failed'; problem: string };

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; response: SendResponse }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const SELECT =
  'rounded-md border border-outline bg-surface px-xs py-xs font-mono text-body-sm text-on-surface focus:outline-none';
const PRE =
  'max-h-60 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-caption whitespace-pre-wrap break-all';
const BADGE_VERIFIED =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const BADGE_REJECTED =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';

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

/** Defensive parsing of the send endpoint's payload — validate before use. */
function parseSendResponse(value: unknown): SendResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const event = record.event as Record<string, unknown> | undefined;
  const wouldDeliver = record.wouldDeliver as Record<string, unknown> | undefined;
  if (
    typeof event !== 'object' ||
    event === null ||
    typeof event.id !== 'string' ||
    typeof event.type !== 'string' ||
    typeof record.signature !== 'string' ||
    typeof record.delivered !== 'boolean' ||
    typeof record.tampered !== 'boolean' ||
    typeof wouldDeliver !== 'object' ||
    wouldDeliver === null ||
    typeof wouldDeliver.url !== 'string' ||
    typeof wouldDeliver.body !== 'string'
  ) {
    return null;
  }
  const outcome = record.outcome as Record<string, unknown> | undefined;
  return {
    event: { id: event.id, type: event.type },
    signature: record.signature,
    tampered: record.tampered,
    delivered: record.delivered,
    ...(typeof outcome === 'object' &&
      outcome !== null &&
      typeof outcome.status === 'number' &&
      typeof outcome.body === 'string' && { outcome: { status: outcome.status, body: outcome.body } }),
    ...(typeof record.note === 'string' && { note: record.note }),
    ...(typeof record.tamperNote === 'string' && { tamperNote: record.tamperNote }),
    wouldDeliver: {
      url: wouldDeliver.url,
      headers:
        typeof wouldDeliver.headers === 'object' && wouldDeliver.headers !== null
          ? (Object.fromEntries(
              Object.entries(wouldDeliver.headers as Record<string, unknown>).filter(
                ([, headerValue]) => typeof headerValue === 'string',
              ),
            ) as Record<string, string>)
          : {},
      body: wouldDeliver.body,
    },
  };
}

function parseDeliveries(value: unknown): Delivery[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as { deliveries?: unknown }).deliveries;
  if (!Array.isArray(raw)) return null;
  const out: Delivery[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const delivery = entry as Record<string, unknown>;
    if (
      typeof delivery.id !== 'string' ||
      typeof delivery.receivedAt !== 'string' ||
      typeof delivery.type !== 'string' ||
      typeof delivery.signatureVerified !== 'boolean'
    ) {
      return null;
    }
    out.push({
      id: delivery.id,
      receivedAt: delivery.receivedAt,
      type: delivery.type,
      signatureVerified: delivery.signatureVerified,
      payload: delivery.payload,
    });
  }
  return out;
}

export default function WebhookSimulatorDemo(): ReactNode {
  const [eventType, setEventType] = useState<EventType>('post.created');
  const [tamper, setTamper] = useState(false);
  const [sendState, setSendState] = useState<SendState>({ kind: 'idle' });
  const [inboxState, setInboxState] = useState<InboxState>({ kind: 'loading' });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshInbox = useCallback((): void => {
    setInboxState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    void (async () => {
      try {
        const response = await fetch(DELIVERIES_URL);
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const deliveries = parsed.ok ? parseDeliveries(parsed.value) : null;
        if (response.ok && deliveries !== null) {
          setInboxState({ kind: 'ready', deliveries });
          return;
        }
        setInboxState({ kind: 'failed', problem: `status ${String(response.status)} — could not read the inbox` });
      } catch {
        if (aliveRef.current) {
          setInboxState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  }, []);

  useEffect(() => {
    refreshInbox();
  }, [refreshInbox]);

  const send = (): void => {
    setSendState({ kind: 'sending' });
    const params = new URLSearchParams();
    if (eventType !== 'post.created') params.set('type', eventType);
    if (tamper) params.set('tamper', '1');
    const url = params.size > 0 ? `${SEND_URL}?${params.toString()}` : SEND_URL;
    void (async () => {
      try {
        const response = await fetch(url, { method: 'POST' });
        const text = await readBodyText(response);
        if (!aliveRef.current) return;
        const parsed = tryParseJson(text);
        const shaped = parsed.ok ? parseSendResponse(parsed.value) : null;
        if (response.ok && shaped !== null) {
          setSendState({ kind: 'sent', response: shaped });
          refreshInbox(); // the delivery (or its rejection) just happened
          return;
        }
        setSendState({ kind: 'failed', problem: `status ${String(response.status)} — unexpected answer:\n${text}` });
      } catch {
        if (aliveRef.current) {
          setSendState({ kind: 'failed', problem: 'could not reach the server — is the guide running on :4000?' });
        }
      }
    })();
  };

  const rejected = sendState.kind === 'sent' && sendState.response.outcome !== undefined && sendState.response.outcome.status === 401;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="webhook-simulator-summary" className="text-body-sm text-on-surface">
        Both sides of one webhook, in one app. The sender (left) builds a real event, serializes it once, and signs
        those exact bytes — HMAC-SHA256 with <span className="font-mono">node:crypto</span> — before delivering them to
        our own receiver. The inbox (right) shows what the receiver accepted: only signature-verified, fresh
        deliveries. Flip the tamper switch to sign with the wrong secret and watch the flight come back 401 — and the
        inbox stay still.
      </p>

      <div className="grid gap-md lg:grid-cols-2">
        {/* sender panel */}
        <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">sender — POST /api/demo/webhooks/send</h3>

          <div className="flex flex-wrap items-center gap-sm">
            <label className="flex items-center gap-xs">
              <span className="font-mono text-caption text-on-surface-variant">event</span>
              <select
                data-testid="webhook-simulator-type"
                value={eventType}
                onChange={(event_) => setEventType(event_.target.value as EventType)}
                className={SELECT}
              >
                <option value="post.created">post.created</option>
                <option value="post.updated">post.updated</option>
              </select>
            </label>
            <label className="flex items-center gap-xs text-body-sm text-on-surface">
              <input
                data-testid="webhook-simulator-tamper"
                type="checkbox"
                checked={tamper}
                onChange={(event_) => setTamper(event_.target.checked)}
              />
              tamper (sign with the wrong secret)
            </label>
            <button
              type="button"
              data-testid="webhook-simulator-send"
              onClick={send}
              disabled={sendState.kind === 'sending'}
              className={BUTTON_PRIMARY}
            >
              {sendState.kind === 'sending' ? 'delivering…' : 'send event'}
            </button>
          </div>

          {sendState.kind === 'idle' && (
            <p data-testid="webhook-simulator-idle" className="text-body-sm text-on-surface-variant">
              no flight yet — send an event and watch the whole delivery render here.
            </p>
          )}
          {sendState.kind === 'sending' && (
            <p data-testid="webhook-simulator-sending" className="text-body-sm text-on-surface-variant">
              signing and delivering…
            </p>
          )}
          {sendState.kind === 'failed' && (
            <pre data-testid="webhook-simulator-send-failed" className={PRE}>
              {sendState.problem}
            </pre>
          )}

          {sendState.kind === 'sent' && (
            <div data-testid="webhook-simulator-flight" className="flex flex-col gap-xs">
              <p className="flex flex-wrap items-center gap-xs text-body-sm text-on-surface">
                <span className="font-mono font-semibold">{sendState.response.event.type}</span>
                {rejected ? (
                  <span className={BADGE_REJECTED}>rejected 401</span>
                ) : sendState.response.delivered ? (
                  <span className={BADGE_VERIFIED}>delivered</span>
                ) : (
                  <span className="rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface-variant">
                    not delivered
                  </span>
                )}
                {sendState.response.outcome !== undefined && (
                  <span data-testid="webhook-simulator-outcome-status" className="font-mono text-caption text-on-surface-variant">
                    receiver answered {String(sendState.response.outcome.status)}
                  </span>
                )}
              </p>
              {sendState.response.tamperNote !== undefined && (
                <p data-testid="webhook-simulator-tamper-note" className="text-body-sm text-error">
                  {sendState.response.tamperNote}
                </p>
              )}
              {sendState.response.note !== undefined && (
                <p className="text-caption text-on-surface-variant">{sendState.response.note}</p>
              )}
              <p className="font-mono text-caption text-on-surface-variant">
                x-webhook-signature:
                <span data-testid="webhook-simulator-signature" className="break-all text-on-surface">
                  {' '}
                  {sendState.response.signature}
                </span>
              </p>
              <p className="font-mono text-caption text-on-surface-variant">
                event id <span className="text-on-surface">{sendState.response.event.id}</span> — the receiver's
                idempotency key
              </p>
              <details>
                <summary className="cursor-pointer font-mono text-caption text-on-surface-variant">
                  the exact HTTP flight
                </summary>
                <pre className={PRE}>
                  {`POST ${sendState.response.wouldDeliver.url}\n${Object.entries(sendState.response.wouldDeliver.headers)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\n')}\n\n${sendState.response.wouldDeliver.body}`}
                </pre>
              </details>
            </div>
          )}
        </div>

        {/* receiver panel */}
        <div className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex items-center justify-between gap-sm">
            <h3 className="font-mono text-body-sm font-semibold text-on-surface">
              receiver inbox — GET /api/demo/webhooks/deliveries
            </h3>
            <button type="button" data-testid="webhook-simulator-refresh" onClick={refreshInbox} className={BUTTON}>
              refresh
            </button>
          </div>

          {inboxState.kind === 'loading' && (
            <p data-testid="webhook-simulator-loading" className="text-body-sm text-on-surface-variant">
              reading the inbox…
            </p>
          )}
          {inboxState.kind === 'failed' && (
            <pre data-testid="webhook-simulator-inbox-failed" className={PRE}>
              {inboxState.problem}
            </pre>
          )}

          {inboxState.kind === 'ready' && inboxState.deliveries.length === 0 && (
            <p data-testid="webhook-simulator-empty" className="text-body-sm text-on-surface-variant">
              the inbox is empty — nothing has passed verification yet.
            </p>
          )}

          {inboxState.kind === 'ready' &&
            inboxState.deliveries.map((delivery) => (
              <div
                key={delivery.id}
                data-testid="webhook-simulator-delivery"
                className="flex flex-col gap-xxs rounded-md border border-outline p-xs"
              >
                <p className="flex flex-wrap items-center gap-xs">
                  <span className="font-mono text-body-sm font-semibold text-on-surface">{delivery.type}</span>
                  <span data-testid="webhook-simulator-verified-badge" className={BADGE_VERIFIED}>
                    signature verified
                  </span>
                  <span className="font-mono text-caption text-on-surface-variant">
                    {delivery.receivedAt.replace('T', ' ').slice(0, 19)}
                  </span>
                </p>
                <pre className={PRE}>{JSON.stringify(delivery.payload, null, 2)}</pre>
              </div>
            ))}

          {inboxState.kind === 'ready' && (
            <p className="text-caption text-on-surface-variant">
              newest first, capped at 50 — a rejected flight never appears here: verification runs before storage.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
