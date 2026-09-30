import type { Duplex } from 'node:stream';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from '../../core/logging/logger.js';

/**
 * The realtime topic's chat hub — the WebSocket half of the guide's push
 * story, running for real under /api/demo/realtime/chat.
 *
 * THE MESSAGE PROTOCOL, the discipline this app uses everywhere (the JSON
 * error envelope, the gRPC service, the webhook payloads): every frame is a
 * {type, payload} envelope, and `type` decides the payload's shape:
 *
 *   client → server   {type: 'chat', text: 'hello'}
 *   server → client   {type: 'chat',    payload: {id, from, text, at}}
 *                     {type: 'system',  payload: {kind: 'join'|'leave', text, at}}
 *                     {type: 'history', payload: {messages: [chat payloads]}}
 *                     {type: 'error',   payload: {message}}
 *
 * A GARBAGE FRAME (not JSON, not an object, wrong type, over-long or empty
 * text) must never kill the hub: the sender gets an {type:'error'} envelope
 * back and everyone else keeps chatting — one bad client is one bad client.
 *
 * SCALE CEILING, stated honestly in the room: the registry and the history
 * ring live IN THIS PROCESS's memory. One node, one hub — fine for a guide
 * and for most apps' first years. The moment a second node appears behind a
 * load balancer, client A on node 1 and client B on node 2 share NOTHING:
 * broadcasts do not cross the gap. The multi-node answer is a pub/sub bus
 * (this repo already runs one — the Redis topic's dedicated subscriber
 * connection in data/redis/redis_client.ts is exactly the plumbing a hub
 * would replicate on): publish to a channel, every node's hub subscribes and
 * fans out to its OWN sockets. That is the pointer, not this file's job.
 */

/** The one upgrade path this hub owns. Everything else 404s at the socket. */
export const CHAT_WS_PATH = '/api/demo/realtime/chat';

const HISTORY_LIMIT = 20;
const MAX_TEXT_LENGTH = 500;
const MAX_USERNAME_LENGTH = 32;
/** ws heartbeat: ping every 30s, terminate anyone who missed the last one. */
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface ChatMessagePayload {
  id: string;
  from: string;
  text: string;
  at: string;
}

export interface SystemPayload {
  kind: 'join' | 'leave';
  text: string;
  at: string;
}

export type HubEnvelope =
  | { type: 'chat'; payload: ChatMessagePayload }
  | { type: 'system'; payload: SystemPayload }
  | { type: 'history'; payload: { messages: ChatMessagePayload[] } }
  | { type: 'error'; payload: { message: string } };

export interface ChatHubStats {
  attached: boolean;
  connections: number;
  messagesSent: number;
  historySize: number;
  historyLimit: number;
}

interface ClientEntry {
  id: number;
  username: string;
  /** Set false on every heartbeat; the pong handler sets it true again. */
  alive: boolean;
}

/**
 * Username rules, enforced at the door: strip control characters, collapse to
 * a single line, cap the length, and fall back to a generated guest name.
 * The username rides the URL query (?username=…) because WebSocket browsers
 * offer no headers — URL query is the ONLY client-controlled channel a
 * browser EventSource/WebSocket has, which is why it must be sanitized like
 * any other input.
 */
export function sanitizeUsername(raw: unknown): string {
  const cleaned =
    typeof raw === 'string'
      ? raw
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_USERNAME_LENGTH)
      : '';
  if (cleaned !== '') return cleaned;
  return `guest-${Math.random().toString(36).slice(2, 6)}`;
}

export class ChatHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientEntry>();
  private readonly history: ChatMessagePayload[] = [];
  private nextClientId = 0;
  private nextMessageId = 0;
  private messagesSent = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(wss: WebSocketServer) {
    this.wss = wss;
    // The classic ws heartbeat: flag everyone down, ping, and let the pong
    // handlers flag them back up. The next sweep TERMINATES anyone still
    // down — a TCP peer that vanished without a FIN would otherwise sit in
    // the registry forever (half-open connections are the silent killer of
    // in-memory registries).
    this.heartbeat = setInterval(() => this.sweepConnections(), HEARTBEAT_INTERVAL_MS);
  }

  /**
   * A newly upgraded socket joins the room: replayed history FIRST (so the
   * client renders context before anyone speaks), then a join notice to
   * everyone else.
   */
  register(ws: WebSocket, username: string): void {
    const entry: ClientEntry = { id: this.nextClientId++, username, alive: true };
    this.clients.set(ws, entry);

    this.sendTo(ws, { type: 'history', payload: { messages: [...this.history] } });
    this.broadcast(
      { type: 'system', payload: { kind: 'join', text: `${username} joined`, at: new Date().toISOString() } },
      { except: ws },
    );
    logger.info({ chatConnections: this.clients.size }, 'chat client connected');

    ws.on('pong', () => {
      const client = this.clients.get(ws);
      if (client !== undefined) client.alive = true;
    });

    ws.on('message', (raw: unknown) => {
      this.handleClientMessage(ws, entry, raw);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.broadcast(
        {
          type: 'system',
          payload: { kind: 'leave', text: `${entry.username} left`, at: new Date().toISOString() },
        },
        {},
      );
      logger.info({ chatConnections: this.clients.size }, 'chat client disconnected');
    });

    // A socket error must not take the process down: ws surfaces it here, we
    // drop the client and let 'close' fire its leave notice.
    ws.on('error', (err: Error) => {
      logger.warn({ err }, 'chat socket error');
      ws.close();
    });
  }

  /**
   * One client frame in: parse guarded, validate, broadcast. EVERY failure is
   * an {type:'error'} envelope to the sender only — the hub keeps running.
   */
  private handleClientMessage(ws: WebSocket, entry: ClientEntry, raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      this.sendTo(ws, { type: 'error', payload: { message: 'frames must be JSON: {"type":"chat","text":"…"}' } });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.sendTo(ws, { type: 'error', payload: { message: 'frames must be JSON objects' } });
      return;
    }
    const envelope = parsed as { type?: unknown; text?: unknown };
    if (envelope.type !== 'chat') {
      this.sendTo(ws, {
        type: 'error',
        payload: { message: `unknown type ${JSON.stringify(envelope.type) ?? 'undefined'} — this hub speaks {"type":"chat"}` },
      });
      return;
    }
    if (typeof envelope.text !== 'string' || envelope.text.trim() === '') {
      this.sendTo(ws, { type: 'error', payload: { message: '"text" must be a non-empty string' } });
      return;
    }
    const text = envelope.text.trim().slice(0, MAX_TEXT_LENGTH);
    const message: ChatMessagePayload = {
      id: `msg-${this.nextMessageId++}`,
      from: entry.username,
      text,
      at: new Date().toISOString(),
    };

    this.history.push(message);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.broadcast({ type: 'chat', payload: message }, {});
  }

  /** Fanout to every OPEN socket — broadcast is O(clients), the honest ceiling. */
  private broadcast(envelope: HubEnvelope, options: { except?: WebSocket }): void {
    if (envelope.type === 'chat') this.messagesSent += 1;
    for (const [client] of this.clients) {
      if (client === options.except) continue;
      this.sendTo(client, envelope);
    }
  }

  private sendTo(ws: WebSocket, envelope: HubEnvelope): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(envelope));
  }

  private sweepConnections(): void {
    for (const [ws, entry] of this.clients) {
      if (entry.alive) {
        entry.alive = false;
        ws.ping();
        continue;
      }
      // Missed a full heartbeat cycle without a pong: half-open, terminate.
      ws.terminate();
      this.clients.delete(ws);
    }
  }

  stats(): ChatHubStats {
    return {
      attached: true,
      connections: this.clients.size,
      messagesSent: this.messagesSent,
      historySize: this.history.length,
      historyLimit: HISTORY_LIMIT,
    };
  }

  /**
   * Graceful shutdown: stop the heartbeat, close every client with a code,
   * and resolve when the server itself is done. A 500ms force-terminate
   * backstop keeps the promise settling even if a client never answers the
   * close handshake (server.ts's own exit timer is the outer net).
   */
  close(): Promise<void> {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const [ws] of this.clients) ws.close(1001, 'server shutting down');
    this.clients.clear();
    return new Promise((resolve) => {
      const force = setTimeout(() => {
        this.wss.clients.forEach((client) => client.terminate());
        resolve();
      }, 500);
      this.wss.close(() => {
        clearTimeout(force);
        resolve();
      });
    });
  }
}

/**
 * The hub wiring used by BOTH production (server.ts) and the specs: a
 * noServer WebSocketServer plus a MANUAL 'upgrade' router on the http
 * server. Why noServer: with a path/port server, ws owns every upgrade that
 * arrives; noServer hands US the routing — which matters the moment a second
 * WebSocket endpoint (or a second library) shares the port. Only
 * /api/demo/realtime/chat upgrades; every other path gets a plain HTTP 404
 * at the socket level and the connection is destroyed, so a stray upgrade
 * can never be silently absorbed.
 *
 * The most recently attached hub is remembered so the HTTP sidecar route
 * (GET /api/demo/realtime/chat-status) can report its stats — production
 * attaches exactly one, on the real server.
 */
let activeHub: ChatHub | undefined;

export function getActiveChatHub(): ChatHub | undefined {
  return activeHub;
}

export function attachChatHub(server: HttpServer): ChatHub {
  const wss = new WebSocketServer({ noServer: true });
  const hub = new ChatHub(wss);

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== CHAT_WS_PATH) {
      // A declined upgrade must answer HTTP, not hang: one 404 line, then
      // destroy — leaving the socket open would leak it against the server.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const username = sanitizeUsername(url.searchParams.get('username'));
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.register(ws, username);
    });
  });

  activeHub = hub;
  return hub;
}
