/**
 * A bounded in-memory ring of the app's own log lines — the observability
 * topic's teaching artifact and the backing store for GET /api/demo/obs/logs.
 *
 * The ring is a pino DESTINATION (anything pino emits lands here, alongside
 * the console/stdout destination logger.ts also wires), so the log viewer
 * renders exactly what the process logged — not a parallel logger. It is a
 * DEV TOOL, not retention: capacity 200, newest last, gone on restart, never
 * flushed to disk. Production retention is stdout + a collector (the 12-factor
 * way — see the topic's "Log retention and viewers" section).
 */

/** pino's numeric levels, trace(10) … fatal(60). */
export type LevelLabel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LEVEL_LABELS: readonly LevelLabel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

/** Label → pino numeric level (the filter compares numbers, not strings). */
export const LEVEL_ORDER: Readonly<Record<LevelLabel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const LABEL_BY_NUMBER: Readonly<Record<number, LevelLabel>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/** How many lines the ring keeps — a window on recent history, not a ledger. */
export const LOG_RING_CAPACITY = 200;

/** One normalized log line, as the demo endpoints and client render it. */
export interface RingLogEntry {
  /** Epoch milliseconds (pino's default timestamp). */
  time: number;
  /** pino numeric level — machine-comparable. */
  level: number;
  /** Human label for the same level — chip text in the viewer. */
  levelLabel: LevelLabel;
  /** The log call's message string. */
  msg: string;
  /** Correlation id, when the line came from the request logger (reqId field). */
  reqId?: string;
  /** Correlation id, when the line came from the error middleware (requestId field). */
  requestId?: string;
  /** Every other structured field the call carried (err, status, durationMs…). */
  fields: Record<string, unknown>;
}

const ring: RingLogEntry[] = [];

/** Narrow a parsed JSON value into a plain record without ever throwing. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The pino destination: receives one JSON line per write. Parsing is guarded
 * on EVERY field — a weird line (empty, non-JSON, non-object) degrades to an
 * entry of its own instead of throwing inside pino's write path.
 */
export const ringDestination = {
  write(line: string): void {
    const trimmed = typeof line === 'string' ? line.trim() : '';
    if (trimmed === '') return;

    let parsed = asRecord(safeJsonParse(trimmed));
    if (parsed === null) {
      // Valid JSON that isn't an object, or not JSON at all: keep the raw text.
      parsed = { msg: trimmed.slice(0, 500), unparseable: true };
    }

    const level = typeof parsed.level === 'number' ? parsed.level : 30;
    const time = typeof parsed.time === 'number' ? parsed.time : Date.now();
    const msg = typeof parsed.msg === 'string' ? parsed.msg : String(parsed.msg ?? '');

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'time' || key === 'level' || key === 'msg' || key === 'pid' || key === 'hostname') {
        continue;
      }
      if (key === 'reqId' || key === 'requestId') continue; // promoted to the entry
      fields[key] = value;
    }

    ring.push({
      time,
      level,
      levelLabel: LABEL_BY_NUMBER[level] ?? 'info',
      msg,
      reqId: typeof parsed.reqId === 'string' ? parsed.reqId : undefined,
      requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
      fields,
    });
    while (ring.length > LOG_RING_CAPACITY) ring.shift();
  },
};

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface RecentLogsQuery {
  /** How many entries to return (newest last). Default: the full ring. */
  limit?: number;
  /** Only entries AT OR ABOVE this level. Default: no filter. */
  minLevel?: LevelLabel;
}

/**
 * The read side: filtered, capped, OLDEST → NEWEST (the ring's own order, so
 * the viewer appends at the bottom the way a terminal does).
 */
export function getRecentLogs(query: RecentLogsQuery = {}): RingLogEntry[] {
  const limit = Math.max(1, Math.min(query.limit ?? LOG_RING_CAPACITY, LOG_RING_CAPACITY));
  const threshold = query.minLevel === undefined ? undefined : LEVEL_ORDER[query.minLevel];
  const filtered =
    threshold === undefined ? ring : ring.filter((entry) => entry.level >= threshold);
  return filtered.slice(-limit);
}

/** Specs reset the ring so assertions see only the requests they fired. */
export function resetLogRingForTests(): void {
  ring.length = 0;
}
