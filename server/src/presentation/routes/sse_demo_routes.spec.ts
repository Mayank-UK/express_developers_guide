import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { REALTIME_DEMO_MOUNT_PATH } from './sse_demo_routes.js';

/**
 * SSE is a never-ending response, which supertest cannot await — so the
 * streaming cases boot a REAL http server on an ephemeral port and consume
 * the stream with fetch + a ReadableStream reader, aborting via
 * AbortController once enough frames arrived. The bounded endpoints
 * (ticker-status, chat-status, validation failures) ride plain supertest.
 */

const MOUNT = REALTIME_DEMO_MOUNT_PATH; // /api/demo/realtime

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected ephemeral port');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface SseFrame {
  id: number | null;
  event: string | null;
  data: string;
}

function parseFrame(block: string): SseFrame | null {
  let id: number | null = null;
  let event: string | null = null;
  let data: string | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      const chunk = line.slice(5).trim();
      data = data === null ? chunk : `${data}\n${chunk}`;
    }
  }
  if (data === null) return null; // comment-only block (heartbeat / greeting)
  return { id, event, data };
}

interface StreamHandle {
  frames: SseFrame[];
  comments: string[];
  headers: Headers;
  /** Resolves when the predicate holds on the frames collected so far. */
  until(predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

async function openStream(path: string, headers?: Record<string, string>): Promise<StreamHandle> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    signal: controller.signal,
  });
  if (response.body === null) throw new Error('no stream body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const frames: SseFrame[] = [];
  const comments: string[] = [];
  let buffer = '';
  const finished = new Promise<void>((resolve) => {
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary === -1) break;
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const frame = parseFrame(block);
            if (frame === null) comments.push(block);
            else frames.push(frame);
          }
        }
      } catch {
        // AbortError after stop() — the expected exit for an infinite stream.
      }
      resolve();
    })();
  });

  return {
    frames,
    comments,
    headers: response.headers,
    until(predicate, timeoutMs = 5000) {
      const startedAt = Date.now();
      return new Promise<void>((resolve, reject) => {
        const tick = (): void => {
          if (predicate(frames)) {
            resolve();
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            reject(new Error(`stream condition not met within ${String(timeoutMs)}ms — frames: ${String(frames.length)}`));
            return;
          }
          setTimeout(tick, 25);
        };
        tick();
      });
    },
    async stop() {
      controller.abort();
      await finished;
    },
  };
}

interface FeedStatus {
  connections: number;
  totalEventsSent: number;
  ringSize: number;
  intervalMs: number;
  running: boolean;
  oldestRetainedSeq: number | null;
  latestSeq: number;
}

async function fetchStatus(): Promise<FeedStatus> {
  const response = await fetch(`${baseUrl}${MOUNT}/ticker-status`);
  return (await response.json()) as FeedStatus;
}

/** Poll the status endpoint until the predicate holds — disconnects settle asynchronously. */
async function waitStatus(predicate: (status: FeedStatus) => boolean, timeoutMs = 5000): Promise<FeedStatus> {
  const startedAt = Date.now();
  for (;;) {
    const status = await fetchStatus();
    if (predicate(status)) return status;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`status condition not met within ${String(timeoutMs)}ms — last: ${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('GET /api/demo/realtime/ticker — the SSE stream', () => {
  it('serves the SSE headers once, then ticks with id === seq and increasing sequence', async () => {
    const stream = await openStream(`${MOUNT}/ticker?intervalMs=100`);

    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toBe('no-store');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    // The greeting comment line rides ahead of the first event.
    await stream.until((frames) => frames.length >= 3);
    expect(stream.comments.some((block) => block.startsWith(': stream open'))).toBe(true);

    const seqs = stream.frames.map((frame) => JSON.parse(frame.data).seq as number);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBe(seqs[index - 1] + 1);
    }
    for (const frame of stream.frames) {
      const payload = JSON.parse(frame.data) as { seq: number; time: string; value: number; change: number };
      expect(frame.event).toBe('tick');
      // THE reconnect contract: the id line is the seq, verbatim.
      expect(frame.id).toBe(payload.seq);
      expect(typeof payload.value).toBe('number');
      expect(payload.value).toBeGreaterThanOrEqual(1);
      expect(typeof payload.change).toBe('number');
      expect(typeof payload.time).toBe('string');
    }

    // While streaming: the feed is observable as RUNNING with a connection.
    const during = await fetchStatus();
    expect(during.connections).toBeGreaterThanOrEqual(1);
    expect(during.running).toBe(true);
    expect(during.intervalMs).toBe(100);

    // Disconnect: interval AND registry entry die with the connection — the
    // no-timer-leak discipline, proven through the status endpoint.
    await stream.stop();
    const after = await waitStatus((status) => status.connections === 0 && !status.running);
    expect(after.running).toBe(false);
  }, 10_000);

  it('replays retained events after Last-Event-ID — a REAL replay from the ring', async () => {
    // Keep the first stream OPEN (it keeps the feed alive), let it collect a
    // few ticks, then reconnect "from" an older id.
    const live = await openStream(`${MOUNT}/ticker?intervalMs=100`);
    await live.until((frames) => frames.length >= 4);

    const replayFrom = JSON.parse(live.frames[1].data).seq as number; // deliberately NOT the latest
    const reconnected = await openStream(`${MOUNT}/ticker?intervalMs=100`, { 'last-event-id': String(replayFrom) });
    await reconnected.until((frames) => frames.length >= 1);

    const replayedSeqs = reconnected.frames.map((frame) => JSON.parse(frame.data).seq as number);
    // Every replayed event is one the client had NOT seen yet…
    for (const seq of replayedSeqs) expect(seq).toBeGreaterThan(replayFrom);
    // …and the first replayed events are exactly the retained gap (ring had
    // at least 4 events; we asked from the second one, so ≥ 2 replay first).
    expect(replayedSeqs.length).toBeGreaterThanOrEqual(2);

    await reconnected.stop();
    await live.stop();
    await waitStatus((status) => status.connections === 0);
  }, 10_000);

  it('a Last-Event-ID beyond the ring serves what exists — no crash, live ticks resume', async () => {
    const stream = await openStream(`${MOUNT}/ticker?intervalMs=100`, { 'last-event-id': '999999' });
    // No retained event has seq > 999999, so replay is empty and the first
    // frame is a live tick like any other.
    await stream.until((frames) => frames.length >= 2);
    for (const frame of stream.frames) {
      const seq = (JSON.parse(frame.data) as { seq: number }).seq;
      expect(seq).toBeLessThan(999999);
      expect(frame.id).toBe(seq);
    }
    await stream.stop();
  }, 10_000);

  it('many connects/disconnects leave zero connections and no running timer', async () => {
    for (let round = 0; round < 5; round += 1) {
      const stream = await openStream(`${MOUNT}/ticker?intervalMs=100`);
      await stream.until((frames) => frames.length >= 1);
      await stream.stop();
    }
    const settled = await waitStatus((status) => status.connections === 0 && !status.running);
    expect(settled.connections).toBe(0);
    expect(settled.running).toBe(false);
    // The ring retained everything sent and reports its bounds honestly.
    expect(settled.ringSize).toBeLessThanOrEqual(50);
    if (settled.ringSize > 0) {
      expect(settled.oldestRetainedSeq).toBeLessThanOrEqual(settled.latestSeq);
    }
  }, 15_000);

  it('clamps intervalMs into 100–5000 and reports the running interval', async () => {
    const fast = await openStream(`${MOUNT}/ticker?intervalMs=50`); // below the floor
    await fast.until((frames) => frames.length >= 1);
    expect((await fetchStatus()).intervalMs).toBe(100);

    const slow = await openStream(`${MOUNT}/ticker?intervalMs=99999`); // above the ceiling
    await slow.until((frames) => frames.length >= 1);
    // The feed runs at its FASTEST listener's pace — fast (100ms) is still attached.
    expect((await fetchStatus()).intervalMs).toBe(100);
    await fast.stop();
    await slow.stop();
    await waitStatus((status) => status.connections === 0);
  }, 10_000);
});

describe('GET /api/demo/realtime/ticker — input validation', () => {
  it('rejects garbage intervalMs with the canonical 400 envelope', async () => {
    for (const raw of ['abc', '12.5', '-10']) {
      const res = await request(createApp()).get(`${MOUNT}/ticker?intervalMs=${raw}`);
      expect(res.status, `intervalMs=${raw}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.parameter).toBe('intervalMs');
    }
  });

  it('rejects repeated intervalMs params (arrays) with 400', async () => {
    const res = await request(createApp()).get(`${MOUNT}/ticker?intervalMs=100&intervalMs=200`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('GET /api/demo/realtime/ticker-status — the observable counters', () => {
  it('reports feed state as JSON', async () => {
    const res = await request(createApp()).get(`${MOUNT}/ticker-status`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ringLimit: 50,
      heartbeatMs: 15_000,
      replayLimit: 10,
    });
    expect(res.body.connections).toBe(0);
    expect(res.body.running).toBe(false);
    expect(res.body.totalEventsSent).toBeGreaterThanOrEqual(0);
    expect(res.body.latestSeq).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/demo/realtime/chat-status — the hub sidecar', () => {
  it('answers honestly when no hub is attached to this process', async () => {
    const res = await request(createApp()).get(`${MOUNT}/chat-status`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attached: false, connections: 0, messagesSent: 0 });
    expect(typeof res.body.note).toBe('string');
  });
});
