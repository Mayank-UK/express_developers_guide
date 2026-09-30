import { createHash, type Hash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { ValidationException } from '../../core/error_handling/exceptions.js';

/**
 * Node.js-runtime demo endpoints (the `node-js` topic's live experiments):
 * - GET /api/demo/node/blocking — synchronous CPU work that stalls the event
 *   loop for the whole workload; the response reports the measured stall
 * - GET /api/demo/node/deferred — the same total work in small slices across
 *   setImmediate ticks; the loop stays responsive (stall ≈ one slice)
 * - GET /api/demo/node/stream  — identical telemetry payloads two ways:
 *   ?mode=buffered builds the whole body then sends it (Content-Length set),
 *   ?mode=stream writes line by line with a setImmediate pause between writes
 *   (chunked transfer encoding, no Content-Length)
 *
 * Every endpoint measures "event-loop stall" with the same probe: a
 * setImmediate callback scheduled before the work starts. The gap between
 * scheduling and firing is time the loop could not run ANY JavaScript —
 * other requests, timers, everything included.
 */

const WORK_MS_DEFAULT = 50;
const WORK_MS_MIN = 1;
const WORK_MS_MAX = 2000;
/** How long each slice of the deferred workload runs before yielding. */
const SLICE_MS = 10;

const CHUNKS_DEFAULT = 100;
const CHUNKS_MIN = 1;
const CHUNKS_MAX = 1000;
const STREAM_MODES = ['buffered', 'stream'] as const;
type StreamMode = (typeof STREAM_MODES)[number];

/**
 * Parses an optional integer query parameter, clamped into [min, max].
 * Missing or empty falls back to the default; anything that is not a whole
 * number (garbage, floats, repeated params) is a validation failure.
 */
function parseBoundedInt(
  raw: unknown,
  parameter: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
    throw new ValidationException(
      `"${parameter}" query parameter must be a whole number between ${min} and ${max}`,
      { parameter, defaultValue: fallback, validRange: [min, max] },
    );
  }
  return Math.min(max, Math.max(min, Number(raw.trim())));
}

function parseStreamMode(raw: unknown): StreamMode {
  if (raw === undefined || raw === '') return 'buffered';
  if (typeof raw === 'string' && (STREAM_MODES as readonly string[]).includes(raw)) {
    return raw as StreamMode;
  }
  throw new ValidationException('unknown or missing "mode" query parameter', {
    parameter: 'mode',
    validValues: [...STREAM_MODES],
  });
}

/** One decimal is plenty — the numbers are illustrative, not scientific. */
function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

const HASH_PAYLOAD = 'express_developers_guide event-loop demo payload\n';

/** Synchronous CPU work: keep hashing until `ms` of wall time has elapsed. */
function busyHashFor(ms: number, hash: Hash): void {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    hash.update(HASH_PAYLOAD);
  }
}

/** The same CPU work, yielded back to the event loop every SLICE_MS. */
function chunkedHashFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const deadline = performance.now() + ms;
    const slice = (): void => {
      busyHashFor(Math.min(SLICE_MS, deadline - performance.now()), hash);
      if (performance.now() < deadline) setImmediate(slice);
      else resolve();
    };
    slice(); // the first slice runs synchronously, then we start yielding
  });
}

async function blockingController(req: Request, res: Response): Promise<void> {
  const workMs = parseBoundedInt(
    req.query.workMs,
    'workMs',
    WORK_MS_DEFAULT,
    WORK_MS_MIN,
    WORK_MS_MAX,
  );

  // The probe: scheduled NOW, but it cannot fire until this handler's
  // synchronous work finishes — the schedule-to-fire gap IS the loop stall.
  const scheduledAt = performance.now();
  let firedAt = 0;
  setImmediate(() => {
    firedAt = performance.now();
  });
  busyHashFor(workMs, createHash('sha256'));
  // One more loop turn so the probe (queued first) has fired before we answer.
  await new Promise<void>((resolve) => setImmediate(resolve));

  res.json({
    mode: 'blocking',
    workMs,
    eventLoopDelayMs: roundMs(firedAt - scheduledAt),
  });
}

async function deferredController(req: Request, res: Response): Promise<void> {
  const workMs = parseBoundedInt(
    req.query.workMs,
    'workMs',
    WORK_MS_DEFAULT,
    WORK_MS_MIN,
    WORK_MS_MAX,
  );

  // Same probe as the blocking endpoint. The first work slice runs ~SLICE_MS
  // and yields, so the probe fires almost immediately — whatever the total.
  const scheduledAt = performance.now();
  let firedAt = 0;
  setImmediate(() => {
    firedAt = performance.now();
  });
  await chunkedHashFor(workMs);

  res.json({
    mode: 'deferred',
    workMs,
    eventLoopDelayMs: roundMs(firedAt - scheduledAt),
  });
}

/**
 * Deterministic fake telemetry: the same lines for both modes, so the demo
 * (and its spec) can prove the two delivery strategies carry identical bytes.
 * Each line is ~100 bytes of newline-delimited JSON.
 */
function telemetryLines(count: number): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    const valueC = 40 + (i * 7) % 40; // 40..79, stable per line index
    const status = valueC > 70 ? 'hot' : 'ok';
    lines.push(
      `{"seq":${i},"sensor":"cpu-package","valueC":${valueC},"unit":"celsius","status":"${status}","host":"guide-node-1"}\n`,
    );
  }
  return lines;
}

function streamController(req: Request, res: Response): void {
  const mode = parseStreamMode(req.query.mode);
  const chunks = parseBoundedInt(
    req.query.chunks,
    'chunks',
    CHUNKS_DEFAULT,
    CHUNKS_MIN,
    CHUNKS_MAX,
  );

  const lines = telemetryLines(chunks);
  const startedAt = performance.now();
  res.status(200).type('application/x-ndjson');
  res.setHeader('X-Stream-Mode', mode);
  // Server-side time before the response could start moving: buffered means
  // "whole body built", stream means "first line ready". Headers must be final
  // before the first write, so this is measured up to that moment.
  res.setHeader('X-Elapsed-Ms', String(roundMs(performance.now() - startedAt)));

  if (mode === 'buffered') {
    res.send(lines.join('')); // res.send on a string sets Content-Length
    return;
  }

  // Stream: one line per write, a deliberate setImmediate pause between
  // writes so the incremental delivery is observable. (A real endpoint with
  // large chunks would also honor write() returning false — backpressure —
  // but 1000 × ~100 bytes never approaches the socket's high-water mark.)
  let index = 0;
  const writeNext = (): void => {
    if (index >= lines.length) {
      res.end();
      return;
    }
    res.write(lines[index]);
    index += 1;
    setImmediate(writeNext);
  };
  writeNext();
}

export const nodeDemoRouter = Router();
nodeDemoRouter.get('/demo/node/blocking', blockingController);
nodeDemoRouter.get('/demo/node/deferred', deferredController);
nodeDemoRouter.get('/demo/node/stream', streamController);
