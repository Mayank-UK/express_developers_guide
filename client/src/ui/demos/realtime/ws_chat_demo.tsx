import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `realtime:chat` — the WebSocket half of the realtime
 * topic, talking to the REAL chat hub (ws upgrade of /api/demo/realtime/chat,
 * data/realtime/chat_hub.ts). The hub speaks {type, payload} envelopes:
 * 'history' (the ring replayed on join), 'system' (join/leave notices),
 * 'chat' (broadcasts), 'error' (this client's garbage frames answered).
 *
 * The WS URL must point at the API ORIGIN — on the Vite dev server (5173)
 * that is ws://localhost:4000, exactly the docs-link/oauth approach (the
 * /api fetches below ride the Vite proxy; a WebSocket cannot, because the
 * URL scheme itself changes).
 */

const STATUS_URL = '/api/demo/realtime/chat-status';
/** Messages kept in the UI — the server's ring keeps 20; the view keeps a window. */
const VIEW_LIMIT = 100;

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_WARN =
  'rounded-md border border-outline bg-warning px-xs py-xxs font-mono text-caption font-semibold text-on-surface';
const INPUT =
  'w-full max-w-xs rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface';

type Tone = 'chat' | 'history' | 'system' | 'error' | 'note';

interface ChatRow {
  key: number;
  tone: Tone;
  from?: string;
  text: string;
}

interface HubStats {
  attached: boolean;
  connections: number;
  messagesSent: number;
  historySize: number;
}

/** ws:// (or wss://) form of the API origin — port 5173 means the Express :4000. */
function chatSocketUrl(username: string): string {
  if (typeof window === 'undefined') return '';
  const { origin, port } = window.location;
  const apiOrigin = port === '5173' ? 'http://localhost:4000' : origin;
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');
  return `${wsOrigin}/api/demo/realtime/chat?username=${encodeURIComponent(username)}`;
}

function defaultUsername(): string {
  return `guest-${Math.random().toString(36).slice(2, 6)}`;
}

/** Envelope parse — guarded, like every wire read in this app. */
function parseEnvelope(raw: unknown): { type: string; payload: Record<string, unknown> } | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.type !== 'string') return null;
    const payload =
      typeof record.payload === 'object' && record.payload !== null && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : {};
    return { type: record.type, payload };
  } catch {
    return null;
  }
}

/** readyState 0–3 plus 'idle' (never connected) → the status chip. */
function readyStateChip(
  phase: 'idle' | 'live' | 'closed',
  readyState: number,
): { label: string; className: string } {
  if (phase === 'closed') return { label: 'closed · readyState 3', className: CHIP_WARN };
  if (phase === 'idle') return { label: 'not connected', className: CHIP };
  if (readyState === 1) return { label: 'open · readyState 1', className: CHIP_OK };
  if (readyState === 2) return { label: 'closing · readyState 2', className: CHIP_WARN };
  return { label: 'connecting · readyState 0', className: CHIP };
}

export default function WsChatDemo(): ReactNode {
  const [username, setUsername] = useState<string>(() => defaultUsername());
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<'idle' | 'live' | 'closed'>('idle');
  const [readyState, setReadyState] = useState(3);
  const [stats, setStats] = useState<HubStats | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const rowKeyRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Hub stats sidecar — the upgrade bypasses Express, so this HTTP twin is
  // the status window (polled; SSE would be a fun dogfooding, and a needless
  // second stream for a demo).
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = (): void => {
      void fetch(STATUS_URL)
        .then(async (response) => {
          if (!aliveRef.current) return;
          if (!response.ok) return;
          const value = (await response.json()) as unknown;
          if (
            typeof value === 'object' &&
            value !== null &&
            typeof (value as Record<string, unknown>).connections === 'number' &&
            !Array.isArray(value)
          ) {
            const record = value as Record<string, unknown>;
            setStats({
              attached: record.attached === true,
              connections: record.connections as number,
              messagesSent: typeof record.messagesSent === 'number' ? record.messagesSent : 0,
              historySize: typeof record.historySize === 'number' ? record.historySize : 0,
            });
          }
        })
        .catch(() => undefined);
    };
    poll();
    timer = setInterval(poll, 2000);
    return () => {
      if (timer !== undefined) clearInterval(timer);
    };
  }, []);

  const appendRow = (row: Omit<ChatRow, 'key'>): void => {
    setRows((previous) => {
      const next = [...previous, { ...row, key: rowKeyRef.current++ }];
      return next.length > VIEW_LIMIT ? next.slice(next.length - VIEW_LIMIT) : next;
    });
  };

  const handleEnvelope = (envelope: { type: string; payload: Record<string, unknown> }): void => {
    if (envelope.type === 'history') {
      const messages = Array.isArray(envelope.payload.messages) ? envelope.payload.messages : [];
      for (const message of messages) {
        if (typeof message !== 'object' || message === null) continue;
        const record = message as Record<string, unknown>;
        appendRow({
          tone: 'history',
          from: typeof record.from === 'string' ? record.from : undefined,
          text: typeof record.text === 'string' ? record.text : '',
        });
      }
      appendRow({ tone: 'note', text: `— history replay: ${String(messages.length)} retained message(s) —` });
      return;
    }
    if (envelope.type === 'chat') {
      appendRow({
        tone: 'chat',
        from: typeof envelope.payload.from === 'string' ? envelope.payload.from : undefined,
        text: typeof envelope.payload.text === 'string' ? envelope.payload.text : '',
      });
      return;
    }
    if (envelope.type === 'system') {
      appendRow({ tone: 'system', text: typeof envelope.payload.text === 'string' ? envelope.payload.text : '' });
      return;
    }
    if (envelope.type === 'error') {
      appendRow({
        tone: 'error',
        text: typeof envelope.payload.message === 'string' ? envelope.payload.message : 'unknown error',
      });
      return;
    }
    appendRow({ tone: 'note', text: `unrecognized envelope type "${envelope.type}"` });
  };

  // The socket lifecycle: connect() builds it, close/unmount tears it down.
  // Everything is attached via properties so the fake-WebSocket spec sees the
  // same shape a real browser fires.
  const connect = (): void => {
    socketRef.current?.close();
    const socket = new WebSocket(chatSocketUrl(username.trim() === '' ? defaultUsername() : username.trim()));
    socketRef.current = socket;
    setPhase('live');
    setReadyState(socket.readyState);
    setRows([]);

    socket.onopen = (): void => {
      setReadyState(socket.readyState);
    };
    socket.onmessage = (event: MessageEvent): void => {
      const envelope = parseEnvelope(event.data);
      if (envelope !== null) handleEnvelope(envelope);
    };
    socket.onclose = (): void => {
      setReadyState(3);
      setPhase('closed');
      appendRow({ tone: 'note', text: '— connection closed —' });
    };
    socket.onerror = (): void => {
      setReadyState(socket.readyState);
      appendRow({ tone: 'note', text: '— websocket error (see the status chip) —' });
    };
  };

  const disconnect = (): void => {
    socketRef.current?.close();
  };

  const sendMessage = (): void => {
    const socket = socketRef.current;
    const text = draft.trim();
    if (socket === null || socket.readyState !== 1 || text === '') return;
    socket.send(JSON.stringify({ type: 'chat', text }));
    setDraft('');
  };

  // Unmount: close the socket (the hub broadcasts the leave notice) — and the
  // alive flag stops the stats poll from setState on a dead component.
  useEffect(() => {
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const chip = readyStateChip(phase, readyState);
  const open = phase === 'live' && readyState === 1;

  const rowClass: Record<Tone, string> = {
    chat: 'text-on-surface',
    history: 'text-on-surface-variant',
    system: 'italic text-on-surface-variant',
    error: 'text-error',
    note: 'text-on-surface-variant',
  };

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="chat-summary" className="text-body-sm text-on-surface">
        A real ws:// connection to the chat hub: pick a username, connect, and watch the{' '}
        <code className="font-mono">{'{type, payload}'}</code> envelopes render by kind — history
        muted (it is the past), system italic (the room talking), chats with names. Open this page
        in a second tab and the room is two-headed.
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex items-center gap-xxs text-caption text-on-surface-variant">
            username
            <input
              type="text"
              data-testid="chat-username"
              value={username}
              maxLength={32}
              onChange={(event) => setUsername(event.target.value)}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="chat-connect"
            onClick={connect}
            disabled={open}
            className={BUTTON_PRIMARY}
          >
            {open ? 'connected' : 'connect'}
          </button>
          <button
            type="button"
            data-testid="chat-disconnect"
            onClick={disconnect}
            disabled={socketRef.current === null || phase !== 'live'}
            className={BUTTON}
          >
            disconnect
          </button>
          <span data-testid="chat-status" className={chip.className}>
            {chip.label}
          </span>
        </div>

        <div
          data-testid="chat-log"
          className="flex h-64 flex-col gap-xxs overflow-y-auto rounded-md border border-outline bg-surface p-sm font-mono text-caption"
        >
          {rows.length === 0 && (
            <p className="text-on-surface-variant">
              not connected — press connect and the hub replays its history ring first.
            </p>
          )}
          {rows.map((row) => (
            <p key={row.key} data-testid={`chat-row-${row.tone}`} className={rowClass[row.tone]}>
              {row.tone === 'chat' || row.tone === 'history' ? (
                <>
                  <span className="font-semibold">{row.from ?? '?'}</span>
                  {row.tone === 'history' ? ' (history)' : ''}: {row.text}
                </>
              ) : (
                row.text
              )}
            </p>
          ))}
        </div>

        <form
          className="flex flex-wrap items-center gap-sm"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <input
            type="text"
            data-testid="chat-draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={open ? 'say something — {"type":"chat","text":…} on the wire' : 'connect first'}
            disabled={!open}
            className={`${INPUT} max-w-md flex-1`}
          />
          <button
            type="submit"
            data-testid="chat-send"
            disabled={!open || draft.trim() === ''}
            className={BUTTON_PRIMARY}
          >
            send
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-caption text-on-surface-variant">hub sidecar /chat-status:</span>
          <span data-testid="chat-stats" className={CHIP}>
            {stats === null
              ? '…'
              : `${stats.attached ? 'attached' : 'not attached'} · ${String(stats.connections)} connection(s) · ${String(stats.messagesSent)} broadcast · ring ${String(stats.historySize)}`}
          </span>
          {typeof window !== 'undefined' && window.location.port === '5173' && (
            <span className="text-caption text-on-surface-variant">
              ws://localhost:4000 — the dev-server origin swap (Vite&apos;s proxy cannot proxy a
              scheme change)
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
