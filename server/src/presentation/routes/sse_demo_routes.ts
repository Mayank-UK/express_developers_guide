import { Router, type Request, type Response } from 'express';
import { ValidationException } from '../../core/error_handling/exceptions.js';
import { logger } from '../../core/logging/logger.js';
// Deliberate teaching exception (the dependency rule is presentation → domain
// ← data; same note as db_demo_routes.ts): the chat hub is the realtime
// artifact being taught; this router only reads its sidecar counters.
import { getActiveChatHub } from '../../data/realtime/chat_hub.js';

/**
 * Realtime demo endpoints (the `realtime` topic's live surface):
 *
 * - GET /api/demo/realtime/ticker — the Server-Sent Events price feed. One
 *   shared feed (ONE interval, ONE seq space, ONE random-walk value) with N
 *   subscribers; the interval runs only while someone listens — first
 *   connection starts it, last disconnect stops it, so an idle server owns
 *   zero timers. ?intervalMs= (clamped 100–5000) makes the feed faster for
 *   demos; the feed runs at its fastest listener's pace. Reconnects sending
 *   Last-Event-ID get the retained events they missed replayed first.
 * - GET /api/demo/realtime/ticker-status — feed counters (live connections,
 *   total events sent, ring occupancy, current interval) so the no-timer-leak
 *   claim is observable, not a promise.
 * - GET /api/demo/realtime/chat-status — the WebSocket chat hub's sidecar
 *   counters (the hub itself lives at ws://…/api/demo/realtime/chat, wired
 *   by attachChatHub in server.ts; upgrades bypass Express entirely, so the
 *   browser cannot fetch it — this HTTP twin is the honest status window).
 */

export const REALTIME_DEMO_MOUNT_PATH = '/api/demo/realtime';

const TICK_INTERVAL_MS_DEFAULT = 1000;
const TICK_INTERVAL_MS_MIN = 100;
const TICK_INTERVAL_MS_MAX = 5000;
/** Comment-line heartbeat period: keeps proxies from idling the stream out. */
const HEARTBEAT_MS = 15_000;
/** How many retained events a Last-Event-ID reconnect replays at most. */
const REPLAY_LIMIT = 10;
/** Retained events, period — the replay window's hard ceiling. */
const RING_LIMIT = 50;

export interface TickEvent {
  seq: number;
  time: string;
  value: number;
  change: number;
}

interface TickerConnection {
  requestedIntervalMs: number;
  heartbeat: ReturnType<typeof setInterval>;
}

/** Round to 2 decimals — display data, not scientific instruments. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * THE FEED STATE — module-level because it is genuinely process-global: one
 * price, one sequence, one history, however many subscribers are attached.
 */
const feed = {
  seq: 0,
  value: 100,
  totalEventsSent: 0,
  ring: [] as TickEvent[],
  connections: new Map<Response, TickerConnection>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  intervalMs: TICK_INTERVAL_MS_DEFAULT,
};

/** Random walk with a floor at 1 — a price that can hit 0 stops teaching. */
function nextTick(): TickEvent {
  feed.seq += 1;
  const previous = feed.value;
  const step = round2((Math.random() - 0.5) * 2);
  feed.value = Math.max(1, round2(previous + step));
  const event: TickEvent = {
    seq: feed.seq,
    time: new Date().toISOString(),
    value: feed.value,
    // The realized change — equals `step` except when the floor clamped it.
    change: round2(feed.value - previous),
  };
  feed.ring.push(event);
  if (feed.ring.length > RING_LIMIT) feed.ring.shift();
  feed.totalEventsSent += 1;
  return event;
}

function encodeSse(event: TickEvent): string {
  // THE FRAMING RULES: one `id:` line, one `event:` line, one or more `data:`
  // lines, terminated by a BLANK line (\n\n). JSON.stringify never emits a
  // raw newline, so the payload cannot smuggle extra frames — that property
  // is why JSON is the standard SSE data encoding.
  return `id: ${event.seq}\nevent: tick\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * (Re)arm the one interval: the feed runs at its FASTEST listener's pace,
 * recomputed on every attach/detach. Started lazily on the first listener,
 * stopped on the last — an idle server holds no timers.
 */
function syncFeedTimer(): void {
  const wanted =
    feed.connections.size === 0
      ? TICK_INTERVAL_MS_DEFAULT
      : Math.min(...[...feed.connections.values()].map((connection) => connection.requestedIntervalMs));

  if (feed.connections.size === 0) {
    if (feed.timer !== undefined) {
      clearInterval(feed.timer);
      feed.timer = undefined;
    }
    feed.intervalMs = TICK_INTERVAL_MS_DEFAULT;
    return;
  }
  if (feed.timer !== undefined && wanted === feed.intervalMs) return;
  if (feed.timer !== undefined) clearInterval(feed.timer);
  feed.intervalMs = wanted;
  feed.timer = setInterval(() => {
    const event = nextTick();
    const frame = encodeSse(event);
    for (const [res] of feed.connections) res.write(frame);
  }, feed.intervalMs);
}

function parseIntervalMs(raw: unknown): number {
  if (raw === undefined || raw === '') return TICK_INTERVAL_MS_DEFAULT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new ValidationException(
      `"intervalMs" query parameter must be a whole number of milliseconds between ${TICK_INTERVAL_MS_MIN} and ${TICK_INTERVAL_MS_MAX}`,
      { parameter: 'intervalMs', defaultValue: TICK_INTERVAL_MS_DEFAULT, validRange: [TICK_INTERVAL_MS_MIN, TICK_INTERVAL_MS_MAX] },
    );
  }
  return Math.min(TICK_INTERVAL_MS_MAX, Math.max(TICK_INTERVAL_MS_MIN, Number(raw.trim())));
}

/**
 * Last-Event-ID, tolerant on purpose: browsers send it automatically on
 * auto-reconnect (it is THE reconnect contract); garbage here means a
 * hand-rolled client, and the honest answer is "no replay", not a crash.
 */
function parseLastEventId(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '' || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

function tickerController(req: Request, res: Response): void {
  const requestedIntervalMs = parseIntervalMs(req.query.intervalMs);

  // HEADERS ONCE, THEN HOLD THE RESPONSE OPEN: flushHeaders() puts them on
  // the wire immediately (EventSource fires 'open'), and nothing else is
  // sent until an event — this response never "ends" until the client does.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  // no-store, not no-cache: an event stream must not even be revalidated —
  // a cached "live" feed is a contradiction. keep-alive because the whole
  // point is one long connection. X-Accel-Buffering: no asks nginx (and any
  // proxy that honors the convention) not to sit on our bytes waiting for a
  // full buffer — the killer bug of SSE behind a default reverse proxy.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // A comment line (colon prefix) the client ignores — useful as a "you are
  // connected" marker and exactly the shape the heartbeat uses.
  res.write(`: stream open — ticks every ${String(requestedIntervalMs)}ms (feed currently ${String(feed.intervalMs)}ms)\n\n`);

  // REPLAY FIRST: everything retained after the client's last seen id. If
  // the id predates the ring's oldest event we serve what survived and say
  // so in a comment — an honest gap beats a silent one.
  const lastEventId = parseLastEventId(req.headers['last-event-id']);
  if (lastEventId !== undefined) {
    const missed = feed.ring.filter((event) => event.seq > lastEventId);
    if (missed.length > 0) {
      const replay = missed.slice(-REPLAY_LIMIT);
      if (replay.length < missed.length) {
        res.write(`: replay truncated — ${String(missed.length - replay.length)} missed events outside the retained window\n`);
      }
      for (const event of replay) res.write(encodeSse(event));
    }
  }

  // Heartbeat: a comment every 15s so proxies and load balancers with idle
  // timeouts see traffic and keep the stream alive. Comments are invisible
  // to EventSource — pure keep-alive.
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);

  feed.connections.set(res, { requestedIntervalMs, heartbeat });
  syncFeedTimer();
  logger.info({ tickerConnections: feed.connections.size }, 'ticker stream attached');

  // CLIENT ABORT DETECTION — the cleanup discipline: the interval, the
  // heartbeat, and the registry entry all die with the connection, or every
  // abandoned tab leaks a timer forever. req 'close' fires on disconnect.
  req.on('close', () => {
    const connection = feed.connections.get(res);
    if (connection !== undefined) clearInterval(connection.heartbeat);
    feed.connections.delete(res);
    syncFeedTimer();
    logger.info({ tickerConnections: feed.connections.size }, 'ticker stream detached');
  });
}

function tickerStatusController(_req: Request, res: Response): void {
  res.json({
    connections: feed.connections.size,
    totalEventsSent: feed.totalEventsSent,
    ringSize: feed.ring.length,
    ringLimit: RING_LIMIT,
    oldestRetainedSeq: feed.ring.length > 0 ? feed.ring[0].seq : null,
    latestSeq: feed.seq,
    intervalMs: feed.intervalMs,
    running: feed.timer !== undefined,
    heartbeatMs: HEARTBEAT_MS,
    replayLimit: REPLAY_LIMIT,
  });
}

/**
 * Live connection count for cross-topic introspection — the scaling topic's
 * state inventory reads THIS (the registry itself is deliberately private to
 * this module; a getter is the smallest honest surface to hand another route).
 */
export function getTickerConnectionCount(): number {
  return feed.connections.size;
}

function chatStatusController(_req: Request, res: Response): void {
  const hub = getActiveChatHub();
  if (hub === undefined) {
    res.json({
      attached: false,
      connections: 0,
      messagesSent: 0,
      historySize: 0,
      note: 'no chat hub attached to this process — upgrades are wired in server.ts (attachChatHub)',
    });
    return;
  }
  res.json(hub.stats());
}

export const realtimeDemoRouter = Router();
realtimeDemoRouter.get('/demo/realtime/ticker', tickerController);
realtimeDemoRouter.get('/demo/realtime/ticker-status', tickerStatusController);
realtimeDemoRouter.get('/demo/realtime/chat-status', chatStatusController);
