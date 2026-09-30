import type { Topic } from '../types.js';

/**
 * The Real-Time Communication topic: the guide's push story in one place —
 * the polling-to-WebSockets spectrum, Server-Sent Events (the hand-rolled
 * ticker under /api/demo/realtime/ticker IS the lesson: no library, just
 * formatting rules), and WebSockets (the ws-backed chat hub under
 * /api/demo/realtime/chat). Every code block below is the real running
 * source, and the two live demos drive the real endpoints.
 */
export const topicRealtime: Topic = {
  id: 'realtime',
  title: 'Real-Time Communication',
  subtitle:
    'WebSockets and Server-Sent Events — pushing data to connected clients.',
  group: 'realtime-jobs',
  order: 1,
  sections: [
    {
      id: 'realtime-push-models',
      title: 'Push models: from polling to WebSockets',
      lead:
        'HTTP was built for ask-then-answer. Everything "real-time" on the web is a strategy for getting answers nobody asked for yet — and each rung up the ladder trades simplicity for immediacy.',
      blocks: [
        {
          kind: 'text',
          id: 'realtime-push-models:spectrum',
          body: `THE SPECTRUM, cheapest to most committed. POLLING: the client asks on a timer — "anything new?" — every N seconds. It is one line of fetch code and works everywhere, and its costs are structural, not accidental: the answer is stale by up to N seconds (LATENCY = the polling interval on average), most polls carry "no" (WASTED work on both sides — the server answers, the connection churns, for nothing), and N clients polling every second is N requests/second your server handles even when nothing happens. LONG-POLLING: the same question, but the server HOLDS the question open until it has an answer (or a timeout), answers, and the client immediately re-asks. Latency drops to the network round-trip the moment data exists — this is how every pre-WebSocket chat worked (and how XMPP/Comet systems shipped for years) — but each "answer" is still a full HTTP request/response cycle, and the server needs one hanging request per client per direction. SERVER-SENT EVENTS (SSE): the server answers ONCE with a response that never ends — a stream of events in a dead-simple text format. One long-lived connection, server-to-client ONLY, with reconnect semantics BUILT INTO THE BROWSER. WEB_SOCKETS: a real bidirectional channel — the client sends an HTTP request saying "upgrade me", the protocol switches (101 Switching Protocols), and both sides push framed messages at will over the same TCP connection. Full duplex, minimal per-message overhead, and the most machinery: your own message protocol, your own reconnect logic, your own heartbeat discipline. THE AXES THAT MATTER when choosing — DIRECTIONALITY (does the client need to SEND while subscribed? SSE can only listen; anything the client must push needs regular requests or WebSockets), LATENCY BUDGET (a dashboard updated every 30s is polling territory; a chat message must land in milliseconds), CONNECTION COST (each long-lived connection is a socket, memory, and — behind proxies — a slot of the per-origin limits), and OPERATIONAL WEIGHT (SSE rides plain HTTP through every proxy and load balancer on earth; WebSockets need Upgrade support end-to-end). THE DECISION, compressed to rules of thumb that are right far more often than they are wrong: if the client only LISTENS (tickers, feeds, notifications, progress, logs tails) — SSE, and be done; if the client speaks RARELY (mouse clicks, acks, occasional commands) — SSE down + plain POST up is a boring, robust architecture many production systems never outgrow; if the conversation is DENSE both ways (chat, collaborative editing, games, presence) — WebSockets; and if "real-time" really means "fresh within a minute" — polling, honestly, before the machinery earns its keep. This guide builds BOTH real ones: the SSE ticker and the WebSocket chat hub, side by side, from the same server.`,
        },
        {
          kind: 'code',
          id: 'realtime-push-models:decision-table',
          language: 'text',
          caption: 'The four models on the axes that decide',
          code: `model         direction      latency        per-message cost      client cost         server cost
─────────────  ─────────────  ─────────────  ─────────────────────  ─────────────────  ───────────────────────
polling       client pulls   up to interval  full HTTP cycle        one fetch           N × (1/interval) req/s
long-polling  server answers ~round-trip     full HTTP cycle        one fetch           1 hanging req per client
SSE           server → client ~round-trip     ~one line of text     EventSource (built  1 open response per
              (one-way)                      + framing                in, auto-reconnect) client, held open
WebSockets    both ways      ~round-trip     small frame header     WebSocket API +     upgrade handshake, own
                                              (2–14 bytes)          reconnect YOU write message protocol + pings

rules of thumb
  client only listens ............................................... SSE
  client speaks rarely (acks, commands) ............................. SSE down + POST up
  dense both-way traffic (chat, editing, games) ..................... WebSockets
  "fresh within a minute" is fresh enough .......................... polling`,
        },
      ],
    },
    {
      id: 'realtime-sse',
      title: 'Server-Sent Events — the protocol is four formatting rules',
      lead:
        'SSE is not a library or even really a protocol — it is a Content-Type, a set of line-formatting rules, and a browser API that reconnects for you. This guide hand-rolls the whole thing; the ticker endpoint below is the actual code the demo streams from.',
      blocks: [
        {
          kind: 'text',
          id: 'realtime-sse:format',
          body: `THE ENTIRE WIRE FORMAT. A server-sent event stream is an HTTP response with Content-Type: text/event-stream whose body is text, UTF-8, line-based, where each EVENT is a group of lines ended by a BLANK line ("\\n\\n" — the frame delimiter; until the blank line arrives, the browser buffers, so forgetting it is the classic "my events never fire" bug). Four line kinds: DATA — "data: <text>"; an event may have several data lines, which the browser joins with "\\n" and hands you as one string (the de-facto convention is ONE data line carrying JSON — and JSON.stringify never emits a raw newline, which is precisely why the framing cannot be smuggled by the payload). EVENT — "event: tick", a named event type the client listens for with addEventListener('tick', …); without it the event fires the generic onmessage. ID — "id: 42", the event's cursor, which the browser remembers and sends back as the Last-Event-ID header (or query param) when it reconnects — the seed of the replay story below. COMMENT — any line starting with ":", ignored by every client; comments are the channel for heartbeats and debug notes. Plus one client-to-server field: RETRY — "retry: 3000" tells the browser to wait 3000ms between reconnection attempts instead of its default (~3s, browser-chosen, with backoff). THAT IS THE WHOLE PROTOCOL. The browser side is equally small: const source = new EventSource('/api/stream'); source.addEventListener('tick', (e) => JSON.parse(e.data)); — and here is the part that sells SSE: when the connection drops, the BROWSER reconnects automatically (after its retry interval) and, if the server sent ids, passes Last-Event-ID so the stream can resume where it left off. You write zero reconnect code. THREE REAL-WORLD CONSTRAINTS before you commit: (1) ONE-WAY — the connection carries server→client only; the client's own communications ride separate normal requests. (2) CONNECTION LIMITS — on HTTP/1.1, browsers cap concurrent connections to one ORIGIN (six in Chrome/Firefox, and EventSource holds one OPEN), so a page with six SSE streams from one origin can starve every other request to that origin; HTTP/2 multiplexing dissolves this (one TCP connection, many streams), which is a deployment argument for TLS+HTTP/2 in front of your API (the deployment topic picks this up). (3) PROXY BUFFERING — proxies and load balancers love to buffer "incomplete" responses to efficient sizes before forwarding; a default nginx will happily sit on your events until its buffer fills (which, for a 1s tick stream, is NEVER). The fix is the X-Accel-Buffering: no response header (the convention nginx honors), plus Cache-Control: no-store so nothing between you and the client considers the stream cacheable — both set by the endpoint below, with the reasoning in the comments.`,
        },
        {
          kind: 'code',
          id: 'realtime-sse:verbatim-ticker',
          language: 'ts',
          source: 'server/src/presentation/routes/sse_demo_routes.ts',
          caption: 'Verbatim — the real ticker endpoint (routes/sse_demo_routes.ts)',
          code: `function encodeSse(event: TickEvent): string {
  // THE FRAMING RULES: one \`id:\` line, one \`event:\` line, one or more
  // \`data:\` lines, terminated by a BLANK line. JSON.stringify never emits a
  // raw newline, so the payload cannot smuggle extra frames.
  return \`id: \${event.seq}\\nevent: tick\\ndata: \${JSON.stringify(event)}\\n\\n\`;
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

  res.write(\`: stream open — ticks every \${String(requestedIntervalMs)}ms (feed currently \${String(feed.intervalMs)}ms)\\n\\n\`);

  // REPLAY FIRST: everything retained after the client's last seen id.
  const lastEventId = parseLastEventId(req.headers['last-event-id']);
  if (lastEventId !== undefined) {
    const missed = feed.ring.filter((event) => event.seq > lastEventId);
    if (missed.length > 0) {
      const replay = missed.slice(-REPLAY_LIMIT);
      if (replay.length < missed.length) {
        res.write(\`: replay truncated — \${String(missed.length - replay.length)} missed events outside the retained window\\n\`);
      }
      for (const event of replay) res.write(encodeSse(event));
    }
  }

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\\n\\n');   // comments: invisible keep-alive
  }, HEARTBEAT_MS);

  feed.connections.set(res, { requestedIntervalMs, heartbeat });
  syncFeedTimer();

  // CLIENT ABORT DETECTION — cleanup or leak, no third option (next section).
  req.on('close', () => {
    const connection = feed.connections.get(res);
    if (connection !== undefined) clearInterval(connection.heartbeat);
    feed.connections.delete(res);
    syncFeedTimer();
  });
}`,
        },
        {
          kind: 'text',
          id: 'realtime-sse:ticker-design',
          body: `THE TICKER'S OWN DESIGN, because the endpoint embeds three decisions worth stealing. ONE FEED, N SUBSCRIBERS: the price, the sequence counter, and the retained history live in ONE module-level feed; each connection is just a response object writing the same frames (and the feed's interval runs at its fastest listener's pace, started by the first connection and STOPPED by the last — an idle server owns zero timers, and the /ticker-status endpoint makes that observable: connections, totalEventsSent, ring occupancy, running). The random walk starts at 100 and steps ±1 per tick with a floor at 1 — deterministic shape, random path, exactly enough "market" to be honest. INTERVALMS QUERY: ?intervalMs= (clamped 100–5000) is a demo affordance and a real pattern — stream endpoints that let clients pick a cadence MUST clamp, or one client asking for intervalMs=1 makes your server a busy-loop. VALIDATION STILL APPLIES: a garbage ?intervalMs=abc is rejected by the same ValidationException → 400 envelope as every other query param in this guide — an event stream is still an HTTP response, and its INPUT is still an HTTP request. THE DEMO below streams this exact endpoint; the curl block in the last section shows the raw frames with ids you can feed back as Last-Event-ID to watch replay happen from a terminal.`,
        },
      ],
    },
    {
      id: 'realtime-sse-mechanics',
      title: 'Event stream mechanics on the server',
      lead:
        'Holding a response open is the easy part. The discipline is what keeps the open response healthy — heartbeats against proxies, backpressure against slow clients, and cleanup against the disconnect you will never be told about.',
      blocks: [
        {
          kind: 'text',
          id: 'realtime-sse-mechanics:rules',
          body: `HEADERS ONCE, THEN WRITE. An SSE response sets its four headers and calls res.flushHeaders() — from that moment the response is "in progress" forever: no res.json(), no res.send(), no Content-Length (transfer encoding is chunked); every res.write() appends frames, and the response only ends when the CLIENT goes away. This has a consequence for the middleware stack you met in the middleware topic: nothing AFTER your route can touch the response (no error handler rewriting it, no post-route transform) — by the time downstream middleware would run, the handler has "not finished" and never will. Plan the stream route as a terminus. HEARTBEATS: comment lines (": heartbeat\\n\\n") on a timer — every proxy, load balancer, and NAT in the path has an IDLE TIMEOUT (often 30–60s), and a stream that sends nothing for that long gets its connection reaped mid-air; the browser then reconnects (Last-Event-ID makes that cheap), but a 15s comment costs nothing and keeps the path warm. Comments are invisible to EventSource — pure keep-alive. BACKPRESSURE, the same law the Files & Media topic drilled: res.write() returns false when the socket buffer is full — a slow phone on a train is not reading, and every write past the false parks bytes in YOUR memory. For a small event stream the honest simple answer is what the ticker does (small frames, one per second — the buffer never fills); a stream that can burst (a snapshot payload, a fast feed) must check the boolean and await 'drain' (writeLinesWithBackpressure in the Files topic is the pattern, transplanted). The nuclear option is also a real one: if a client stays backed up for N seconds, it is gone in spirit — end the response and let the browser's reconnect machinery do a clean restart. ABORT DETECTION — the one that bites everyone: when a client vanishes (tab closed, laptop clammed), you get NO error — you get req's 'close' event, once, and that is your only signal. Everything the connection owns must die there: the tick timer, the heartbeat timer, the registry entry. Miss one and every abandoned tab leaks a timer and a socket for the life of the process — the guide's ticker is deliberately instrumented (/ticker-status reports live connections and whether the feed timer runs) so its specs can PROVE connections drop to zero across many connects/disconnects instead of promising it. THE SHUTDOWN ANGLE: a graceful shutdown (server.ts's chain) must also account for open streams — server.close() waits for connections to drain, and a stream that never ends means close() never returns; the force-exit timer catches it, but the polite pattern is to end streams explicitly on shutdown (the chat hub does exactly this for its sockets).`,
        },
        {
          kind: 'code',
          id: 'realtime-sse-mechanics:verbatim-cleanup',
          language: 'ts',
          source: 'server/src/presentation/routes/sse_demo_routes.ts',
          caption: 'Verbatim — the cleanup contract + the lazy feed timer (sse_demo_routes.ts)',
          code: `/**
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
};

/**
 * (Re)arm the one interval: the feed runs at its FASTEST listener's pace,
 * recomputed on every attach/detach. Started lazily on the first listener,
 * stopped on the last — an idle server holds no timers.
 */
// (The specs watch this set-on-attach / cleared-on-last-detach pair through
// /ticker-status to prove no timer leaks across many connects/disconnects.)
function syncFeedTimer(): void {
  const wanted =
    feed.connections.size === 0
      ? TICK_INTERVAL_MS_DEFAULT
      : Math.min(...[...feed.connections.values()].map((connection) => connection.requestedIntervalMs));

  if (feed.connections.size === 0) {
    if (feed.timer !== undefined) {
      clearInterval(feed.timer);
      feed.timer = undefined;          // "running: false" — observable
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
}`,
        },
      ],
    },
    {
      id: 'realtime-websockets',
      title: 'WebSockets — a socket that speaks for itself',
      lead:
        'One HTTP request that changes the rules: after the upgrade handshake, the connection is no longer HTTP at all. Frames both ways, your own protocol on top, and a library (ws) that handles the wire while you handle the meaning.',
      blocks: [
        {
          kind: 'text',
          id: 'realtime-websockets:handshake-and-frames',
          body: `THE HANDSHAKE, one paragraph as promised: a WebSocket connection begins as an ordinary HTTP GET carrying Upgrade: websocket, Connection: Upgrade, Sec-WebSocket-Key (16 random bytes, base64), and Sec-WebSocket-Version: 13; the server — if it speaks the protocol — answers 101 Switching Protocols with Sec-WebSocket-Accept (the key run through a fixed GUID + SHA-1, which proves the answer could only come from a real WebSocket endpoint, not a plain HTTP server that 200s everything). From byte one after that response, THE CONNECTION IS NOT HTTP ANYMORE: no methods, no status codes, no headers — just FRAMES. A frame carries an opcode (text, binary, ping, pong, close), a length, and a payload; long messages are split across FRAMES and reassembled into MESSAGES, which is the unit your code sees — "a message arrived," never "a packet." Ping/pong frames are the protocol's OWN heartbeat: either side may ping, the peer's stack answers pong automatically (ws does this for you), and a peer that stops answering is dead even though TCP hasn't noticed yet. WHAT THE SERVER MUST ADD, because the wire protocol deliberately stops at frames: (1) A MESSAGE PROTOCOL — frames carry bytes; MEANING is yours. The discipline this app uses everywhere — the JSON error envelope, the gRPC service, webhook payloads — applies verbatim: every frame is a {type, payload} envelope, and type decides the payload's shape, so both sides can add new types without breaking old readers. (2) VALIDATION AT THE BOUNDARY — a frame is client input exactly like a request body: the hub below JSON-parses guarded, checks the type against its known set, trims and caps the text, and answers garbage with an {type:'error'} envelope to the SENDER — one bad client must never kill the room. (3) LIFECYCLE PLUMBING — open (register), message (dispatch), close (deregister + notify), error (log + close); miss the close path and your registry fills with ghosts. WS, THE LIBRARY: the de-facto standard (everything else, Socket.IO included, wraps or imitates it). On the server you get WebSocketServer, and the one decision that matters is HOW it attaches: with a path/port, ws owns every upgrade arriving there; with {noServer: true} YOU route the http server's 'upgrade' event — which is what this guide does, because manual routing is the honest shape the moment a second socket endpoint or a second library shares the port. Only /api/demo/realtime/chat upgrades; every other path is declined with a plain HTTP 404 at the socket level and destroyed (a declined upgrade that HANGS leaks the socket silently). Note what the upgrade BYPASSES: it never touches Express — no middleware, no helmet, no request id — which is exactly why hubs must re-earn their input validation by hand. THE CHAT SERVER, real and running below: history replay on join, {type} envelopes for chat/system/history/error, a 30s ping sweep that terminates clients which missed a pong (half-open connections are the silent killer of in-memory registries), and a graceful close that tells every client why.`,
        },
        {
          kind: 'code',
          id: 'realtime-websockets:verbatim-hub',
          language: 'ts',
          source: 'server/src/data/realtime/chat_hub.ts',
          caption: 'Verbatim — the real chat hub: register, dispatch, guarded parse (data/realtime/chat_hub.ts)',
          code: `// THE MESSAGE PROTOCOL: every frame is a {type, payload} envelope —
//   client → server   {type: 'chat', text: 'hello'}
//   server → client   {type: 'chat'|'system'|'history'|'error', payload: …}
// A GARBAGE FRAME must never kill the hub: the sender gets an error envelope
// back and everyone else keeps chatting.
register(ws: WebSocket, username: string): void {
  const entry: ClientEntry = { id: this.nextClientId++, username, alive: true };
  this.clients.set(ws, entry);

  this.sendTo(ws, { type: 'history', payload: { messages: [...this.history] } });
  this.broadcast(
    { type: 'system', payload: { kind: 'join', text: \`\${username} joined\`, at: new Date().toISOString() } },
    { except: ws },
  );

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
        payload: { kind: 'leave', text: \`\${entry.username} left\`, at: new Date().toISOString() },
      },
      {},
    );
  });
  ws.on('error', (err: Error) => {
    logger.warn({ err }, 'chat socket error');
    ws.close();
  });
}

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
      payload: { message: \`unknown type \${JSON.stringify(envelope.type) ?? 'undefined'} — this hub speaks {"type":"chat"}\` },
    });
    return;
  }
  if (typeof envelope.text !== 'string' || envelope.text.trim() === '') {
    this.sendTo(ws, { type: 'error', payload: { message: '"text" must be a non-empty string' } });
    return;
  }
  const text = envelope.text.trim().slice(0, MAX_TEXT_LENGTH);
  const message: ChatMessagePayload = {
    id: \`msg-\${this.nextMessageId++}\`,
    from: entry.username,
    text,
    at: new Date().toISOString(),
  };
  this.history.push(message);
  if (this.history.length > HISTORY_LIMIT) this.history.shift();
  this.broadcast({ type: 'chat', payload: message }, {});
}

// The constructor arms the sweep every HEARTBEAT_INTERVAL_MS (30s). Its
// comment is the whole heartbeat idea, quoted: "The classic ws heartbeat:
// flag everyone down, ping, and let the pong handlers flag them back up.
// The next sweep TERMINATES anyone still down — a TCP peer that vanished
// without a FIN would otherwise sit in the registry forever (half-open
// connections are the silent killer of in-memory registries)."
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
}`,
        },
        {
          kind: 'code',
          id: 'realtime-websockets:verbatim-wiring',
          language: 'ts',
          source: 'server/src/data/realtime/chat_hub.ts',
          caption: 'Verbatim — noServer wiring + manual upgrade routing (data/realtime/chat_hub.ts)',
          code: `export function attachChatHub(server: HttpServer): ChatHub {
  const wss = new WebSocketServer({ noServer: true });
  const hub = new ChatHub(wss);

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== CHAT_WS_PATH) {
      // A declined upgrade must answer HTTP, not hang: one 404 line, then
      // destroy — leaving the socket open would leak it against the server.
      socket.write('HTTP/1.1 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n');
      socket.destroy();
      return;
    }
    // Browsers offer NO headers on WebSocket connects — the URL query is the
    // only client-controlled channel, so it gets sanitized like any input.
    const username = sanitizeUsername(url.searchParams.get('username'));
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.register(ws, username);
    });
  });

  activeHub = hub;   // the HTTP sidecar (/chat-status) reports its counters
  return hub;
}`,
        },
        {
          kind: 'code',
          id: 'realtime-websockets:verbatim-shutdown',
          language: 'ts',
          source: 'server/src/server.ts',
          caption: 'Verbatim — the attach + graceful shutdown chain (server.ts): open websockets must close before server.close() or it never returns',
          code: `// server.ts, right after app.listen: the upgrade rides the HTTP server's
// own port — a WebSocket connection starts life as an HTTP GET.
const chatHub: ChatHub = attachChatHub(server);

// …and in the graceful shutdown chain (after redis, before server.close —
// open websockets would otherwise hold server.close() open forever):
          void chatHub
            .close()
            .catch(() => undefined)
            .finally(() => {
              server.close(() => {
                logger.info('http server closed');
                process.exit(0);
              });`,
        },
      ],
    },
    {
      id: 'realtime-broadcast-rooms',
      title: 'Broadcasting, rooms, and the in-memory ceiling',
      lead:
        'A hub is a registry plus fanout. Both are trivial in one process — and both are exactly what stops scaling the moment a second process appears.',
      blocks: [
        {
          kind: 'text',
          id: 'realtime-broadcast-rooms:fanout',
          body: `FANOUT IS A LOOP. Broadcast-to-all — the chat hub's default — is: for every registered socket, if OPEN, send the envelope. That is the whole mechanism, and its cost is O(connections) per event, on YOUR event loop: ten thousand sockets × one message = ten thousand send calls, each queuing a frame — fine, until a burst makes the loop the bottleneck (the Node.js topic's event-loop probe would show exactly this stall). ROOMS are the standard refinement: partition the registry (a Map from room-id to Set of sockets), and fan out to a room's set instead of everyone — chat channels, per-document presence in collaborative editors, per-user notification streams. Same loop, smaller set; the hub below keeps it honest at "everyone" and the mechanism is identical either way. (When NOT to build it: rooms where membership is "one user" are just... per-user queues — sometimes the right model is a queue, not a socket registry. The background-jobs topic takes that fork.) THE IN-MEMORY CEILING, stated plainly because the demo is about to look production-ready: the registry (Map of sockets) and the history ring (array of the last 20 messages) live in ONE process's heap. Kill the process and both vanish — every client reconnects to an empty room. Run TWO processes behind a load balancer and it is worse than vanish: client A on node 1 and client B on node 2 share NOTHING — A's message broadcasts to node 1's sockets only, and the two halves of your chat never see each other. THE MULTI-NODE ANSWER, the pattern rather than the implementation here: a PUB/SUB BUS between the nodes. Each hub subscribes to a channel (say chat:rooms:general); a published message lands on EVERY node; each node fans it out to its OWN sockets. Redis pub/sub is the classic bus for this, and this repo already runs the exact plumbing it needs — the Redis topic's DEDICATED subscriber connection (a connection in subscriber mode cannot run commands, so it gets its own) plus the publish path is, component for component, what a scaled hub replicates on. The trade the bus introduces: delivery becomes at-most-once ACROSS the bus (a node restarting mid-message loses it), which is why the next section exists. Sticky sessions are the load balancer's half of the story (WebSockets must keep landing on the node that holds them — the scaling topic picks that up), and the honest ladder for most apps is: one node + in-memory registry, until real traffic forces the bus — not before.`,
        },
        {
          kind: 'code',
          id: 'realtime-broadcast-rooms:verbatim-fanout',
          language: 'ts',
          source: 'server/src/data/realtime/chat_hub.ts',
          caption: 'Verbatim — the fanout loop and its ceiling, in five lines (chat_hub.ts)',
          code: `/** Fanout to every OPEN socket — broadcast is O(clients), the honest ceiling. */
private broadcast(envelope: HubEnvelope, options: { except?: WebSocket }): void {
  if (envelope.type === 'chat') this.messagesSent += 1;
  for (const [client] of this.clients) {
    if (client === options.except) continue;   // the "rooms" seed: subsets
    this.sendTo(client, envelope);             //   of the registry, not all
  }
}

private sendTo(ws: WebSocket, envelope: HubEnvelope): void {
  // OPEN check per send: sockets close asynchronously, and a frame queued
  // to a closing socket is a silent drop at best, an error at worst.
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(envelope));
}`,
        },
      ],
    },
    {
      id: 'realtime-delivery-semantics',
      title: 'Reconnection and delivery semantics',
      lead:
        'Neither SSE nor WebSockets promises your message arrived. Both give you the raw materials for a promise — ids, replay, sequences — and leave the actual guarantee as an exercise. This section is the exercise.',
      blocks: [
        {
          kind: 'text',
          id: 'realtime-delivery-semantics:semantics',
          body: `THE DEFAULT IS AT-MOST-ONCE, on both technologies, and internalizing this is the whole section. A send that hits a dead-but-undetected connection vanishes (the socket looked OPEN; TCP had not told anyone otherwise). A server restart drops every stream and every socket mid-flight. A client that reconnects has, by default, no idea what it missed. at-most-once is FINE for a surprising amount of reality — a ticker is explicitly allowed to be "the latest wins" (a gap in a random walk is a gap in nothing), presence systems re-announce, most UIs re-render from state rather than events. It is NOT fine for: chat (a dropped message is a person erased from the room), orders/trades/anything with consequences (a dropped event is money), or any audit trail. SSE'S RECONNECT STORY is the strongest out of the box: the browser reconnects AUTOMATICALLY, and the id: line plus the LAST-EVENT-ID header (the browser sends back the last id it saw) give the server a cursor to resume from. The guide's ticker implements real replay: every event's id is its seq; the server retains the last 50 in a ring; a reconnecting client presenting Last-Event-ID: 42 first receives every retained event with seq > 42 (capped at 10 per reconnect), THEN the live stream resumes. Note what the ring makes honest: retention is FINITE — reconnect after the ring has rolled past your cursor and the server says so in a comment (": replay truncated") and serves what survived. Replay windows are always a bounded-memory compromise between "how long can a client be gone" and "how much history do you keep hot." One browser subtlety the demo shows live: Last-Event-ID rides only the browser's OWN automatic reconnects — a NEW EventSource (fresh page, manual reopen) sends nothing, and the stream starts at "now." WEBSOCKETS HAVE NO BUILT-IN STORY — the client library reconnects nothing; YOU write the retry with backoff (the reliability topic's jittered-retry pattern), and YOU carry the cursor: the standard is a SEQ on every message (the hub's msg-0, msg-1… ids) — the client remembers the highest seq it applied, sends it on reconnect (a query param or the first frame), and the server replays from its retention (the hub's answer is the history ring, last 20, replayed to every joiner). THE HARD TRUTH, the sentence to take home: NEITHER TECHNOLOGY GUARANTEES DELIVERY — TCP promises ordered bytes on ONE connection, and everything past the connection's death is application protocol. Applications that need a guarantee build ACKS on top: the sender keeps the message until the receiver confirms (an {type:'ack', id} frame back), with timeouts and re-sends — which is a distributed-systems pattern (exactly-once is a myth; what people build is at-least-once + idempotent applies: the client re-requests from seq N, and deduplicates by message id when replays overlap). When the requirement graduates past "messages," the answer stops being a smarter hub and becomes a DURABLE LOG — a queue the background-jobs topic builds, where messages persist beyond any process and delivery is a contract instead of a hope.`,
        },
      ],
    },
    {
      id: 'realtime-live',
      title: 'See it live (ticker and chat)',
      lead:
        'Two demos over the two real endpoints: an EventSource ticking a live sparkline you can reconnect mid-gap, and a WebSocket chat room — open it in two browser tabs and talk to yourself across the upgrade handshake.',
      blocks: [
        {
          kind: 'text',
          id: 'realtime-live:intro',
          body: `THE TICKER DEMO is a plain EventSource against /api/demo/realtime/ticker: every tick event appends to a sparkline (last 30 values, one SVG polyline), the seq/value/change line shows the wire payload, the connection chip shows the EventSource's own readyState, and the speed strip swaps ?intervalMs= live. The RECONNECT button teaches the subtle one: it closes the source and opens a fresh one, and because Last-Event-ID only rides the browser's AUTOMATIC reconnects, a manual reopen starts at "now" — the demo marks the gap in the seq counter so you can watch the sequence skip. (Kill the server mid-stream to see the OTHER path: onerror fires, the badge flips to "reconnecting", and the moment the server returns the browser resumes ON ITS OWN — no code of yours involved.) THE CHAT DEMO connects a real WebSocket to /api/demo/realtime/chat with the username you pick: the hub's history envelope renders (muted — it is the past), join/leave system messages render (italic — it is the room talking), chats render with sender names, and the status strip polls the hub's HTTP sidecar (/chat-status — live connections, messages broadcast) — proof the registry is real. Open the SAME page in a second tab with a different username and the room is suddenly two-headed: broadcasts, join notices, history on the third arrival. THE CURL BLOCK does both from a terminal: curl -N shows the raw frames (ids and all), and a two-line node script — the ws dependency is right there — connects two clients and prints the broadcast crossing.`,
        },
        {
          kind: 'demo',
          id: 'realtime-live:ticker-demo',
          demoId: 'realtime:ticker',
          title: 'The SSE ticker: a live random-walk stream over EventSource',
          description:
            'Real ticks from GET /api/demo/realtime/ticker — a sparkline of the last 30 values, the seq/id/change wire payload, an intervalMs speed strip, a readyState connection chip, and a reconnect button that demonstrates (honestly) which reconnects carry Last-Event-ID and which start at "now".',
        },
        {
          kind: 'demo',
          id: 'realtime-live:chat-demo',
          demoId: 'realtime:chat',
          title: 'The WebSocket chat room: history, system messages, live broadcasts',
          description:
            'A real ws:// connection to /api/demo/realtime/chat — pick a username, connect, and watch the {type} envelopes render by kind (history muted, system italic, chat with names); the status strip polls the hub-side counters. Open a second tab and the room is real.',
        },
        {
          kind: 'code',
          id: 'realtime-live:curl',
          language: 'bash',
          caption: 'The realtime surface from a terminal — raw SSE frames, replay, and a two-client WebSocket exchange',
          code: `# 1. Watch the raw tick frames (ids ARE the seqs — -N disables curl's buffering):
curl -N 'localhost:4000/api/demo/realtime/ticker' | head -12
#    faster ticks for impatient terminals (clamped 100–5000):
curl -N 'localhost:4000/api/demo/realtime/ticker?intervalMs=200' | head -12

# 2. Feed an id back as Last-Event-ID → the server REPLAYS the retained gap
#    (use a seq you saw above; events after it arrive instantly, live ones resume):
curl -N -H 'Last-Event-ID: 3' 'localhost:4000/api/demo/realtime/ticker?intervalMs=200' | head -8

# 3. The observable counters — connections drop to 0 when your curl exits:
curl -s localhost:4000/api/demo/realtime/ticker-status | jq

# 4. Two WebSocket clients exchanging one broadcast (the ws dep is installed):
node --input-type=module -e "
import WebSocket from 'ws';
const url = 'ws://localhost:4000/api/demo/realtime/chat?username=terminal';
const a = new WebSocket(url + '-a');
const b = new WebSocket(url + '-b');
b.on('message', (m) => { console.log('client b received:', m.toString()); process.exit(0); });
a.on('open', () => a.send(JSON.stringify({ type: 'chat', text: 'hello from curl-land' })));
setTimeout(() => { console.error('no broadcast arrived'); process.exit(1); }, 3000);
"

# 5. A stray upgrade to a path that is not the chat endpoint — declined at the socket:
curl -s -i --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \\
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \\
  localhost:4000/api/demo/realtime/not-a-socket | head -1

# 6. The hub's HTTP sidecar (upgrades bypass Express, so this is the status window):
curl -s localhost:4000/api/demo/realtime/chat-status | jq`,
        },
      ],
    },
  ],
};
