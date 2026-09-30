import { gzipSync } from 'node:zlib';
import compression from 'compression';
import { Router, type Request, type Response } from 'express';
import { ValidationException } from '../../core/error_handling/exceptions.js';

/**
 * The performance topic's live demo endpoints — the BEFORE/AFTER COMPRESSION
 * benchmark pair:
 *
 * - GET /api/demo/perf/payload?size=small|medium|large[&noCompress=1]
 *     A deterministic, deliberately-compressible telemetry payload (~2KB /
 *     ~50KB / ~500KB). Same bytes every time per size (no clocks, no
 *     randomness) — specs hash it to prove it. Mounted with the `compression`
 *     middleware SCOPED TO THIS ROUTE ONLY: without ?noCompress the response
 *     negotiates br/gzip and arrives chunked; with ?noCompress=1 it is
 *     identity with a Content-Length.
 * - GET /api/demo/perf/benchmark?size=&runs=10
 *     The server measures BOTH variants in-process and reports honest
 *     numbers: median JSON.stringify time (identity) vs median
 *     stringify+gzipSync time, plus raw/compressed byte counts and the ratio.
 *
 * WHY COMPRESSION IS SCOPED, NOT GLOBAL (the tradeoff this router exists to
 * teach): nearly every response in this app is a TEACHING ARTIFACT whose
 * headers the specs assert (Content-Length on buffered streams, ETag bodies,
 * raw ndjson, …). A global compression middleware would silently rewrite all
 * of them. Production apps usually mount it app-wide — this app mounts it
 * where its lesson lives, and says so.
 *
 * Mounted under /api by src/app.ts (the sibling demo routers' convention):
 * the router registers /demo/perf/…, the full path is /api/demo/perf/….
 */

export const PERF_DEMO_MOUNT_PATH = '/api/demo/perf';

const PAYLOAD_SIZES = ['small', 'medium', 'large'] as const;
type PayloadSize = (typeof PAYLOAD_SIZES)[number];

/**
 * The teaching payload's shape: N sensor readings, each carrying a `note` of
 * exactly `noteBytes` bytes of repeated structured text — repetitive BY
 * DESIGN, because that is what real telemetry looks like and what compression
 * feeds on.
 */
const PAYLOAD_SPECS: Readonly<Record<PayloadSize, { items: number; noteBytes: number }>> = {
  small: { items: 4, noteBytes: 400 }, // ≈ 2KB serialized
  medium: { items: 24, noteBytes: 2000 }, // ≈ 50KB serialized
  large: { items: 48, noteBytes: 10500 }, // ≈ 500KB serialized
};

/** ASCII-only so `.length` in chars === bytes on the wire (no escape ambiguity). */
const NOTE_SENTENCE =
  'the probe reports a steady reading; telemetry compresses well because structured text repeats. ';

export interface TelemetryReading {
  seq: number;
  sensor: string;
  reading: number;
  unit: string;
  note: string;
}

export interface TelemetryPayload {
  kind: 'telemetry-batch';
  size: PayloadSize;
  items: number;
  readings: TelemetryReading[];
}

export function parsePayloadSize(raw: unknown): PayloadSize {
  if (raw === undefined || raw === '') return 'medium';
  if (typeof raw === 'string' && (PAYLOAD_SIZES as readonly string[]).includes(raw)) {
    return raw as PayloadSize;
  }
  throw new ValidationException(
    `"size" must be one of ${PAYLOAD_SIZES.map((size) => `"${size}"`).join(', ')}`,
    { parameter: 'size', received: String(raw), validValues: [...PAYLOAD_SIZES] },
  );
}

function noteOf(bytes: number): string {
  let note = '';
  while (note.length < bytes) note += NOTE_SENTENCE;
  return note.slice(0, bytes);
}

/**
 * Deterministic by construction: fixed sentence filler, readings derived from
 * seq by arithmetic (no Math.random, no Date) — the same size ALWAYS produces
 * byte-identical JSON, which is what makes the benchmark's byte counts (and
 * the spec's two-call hash compare) honest.
 */
export function buildTelemetryPayload(size: PayloadSize): TelemetryPayload {
  const spec = PAYLOAD_SPECS[size];
  const note = noteOf(spec.noteBytes);
  const readings: TelemetryReading[] = [];
  for (let seq = 1; seq <= spec.items; seq += 1) {
    readings.push({
      seq,
      sensor: `temp-probe-${String(seq).padStart(2, '0')}`,
      reading: Math.round(((seq * 7) % 30) * 2) / 2 + 4, // 4..33.5, stable per seq
      unit: 'celsius',
      note,
    });
  }
  return {
    kind: 'telemetry-batch',
    size,
    items: spec.items,
    readings,
  };
}

// Payloads never change — build (and serialize, and gzip) each size ONCE.
const serializedCache = new Map<PayloadSize, string>();
const gzipBytesCache = new Map<PayloadSize, number>();

function getSerializedPayload(size: PayloadSize): string {
  let serialized = serializedCache.get(size);
  if (serialized === undefined) {
    serialized = JSON.stringify(buildTelemetryPayload(size));
    serializedCache.set(size, serialized);
  }
  return serialized;
}

/** The gzip size of the exact bytes we serve — the number the demo compares. */
function getGzipByteLength(size: PayloadSize): number {
  let bytes = gzipBytesCache.get(size);
  if (bytes === undefined) {
    bytes = gzipSync(getSerializedPayload(size)).length;
    gzipBytesCache.set(size, bytes);
  }
  return bytes;
}

// --- the compression middleware, SCOPED to the payload route -------------------

/**
 * The middleware is attached per-route below — the whole app's other
 * responses keep their identity headers. The filter ANDs the teaching switch
 * (?noCompress → identity) with compression's own compressible-type check.
 */
const payloadCompression = compression({
  filter: (req, _res) => req.query.noCompress === undefined && compression.filter(req, _res),
});

// --- controllers ----------------------------------------------------------------

function payloadController(req: Request, res: Response): void {
  const size = parsePayloadSize(req.query.size);
  const raw = getSerializedPayload(size);

  res.status(200).type('application/json');
  // Honest telemetry for the client panel: the body's byte length, and what
  // the same bytes weigh under gzip (memoized — gzip of identical input).
  // Custom headers pass through the compression middleware untouched.
  res.set('x-payload-raw-bytes', String(Buffer.byteLength(raw)));
  res.set('x-payload-gzip-bytes', String(getGzipByteLength(size)));
  res.set('Cache-Control', 'no-store');
  res.send(raw);
}

const RUNS_DEFAULT = 10;
const RUNS_MIN = 1;
const RUNS_MAX = 50;

function parseBoundedInt(
  raw: unknown,
  parameter: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new ValidationException(
      `"${parameter}" query parameter must be a whole number between ${min} and ${max}`,
      { parameter, defaultValue: fallback, validRange: [min, max] },
    );
  }
  return Math.min(max, Math.max(min, Number(raw.trim())));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value * 1000) / 1000;
}

async function benchmarkController(req: Request, res: Response): Promise<void> {
  const size = parsePayloadSize(req.query.size);
  const runs = parseBoundedInt(req.query.runs, 'runs', RUNS_DEFAULT, RUNS_MIN, RUNS_MAX);
  const payload = buildTelemetryPayload(size);

  // Warmup (the content's own rule): first-run numbers pay JIT and cache
  // population — discard one round of each variant before measuring.
  JSON.stringify(payload);
  gzipSync(JSON.stringify(payload));

  const rawTimes: number[] = [];
  const compressedTimes: number[] = [];
  let bytesRaw = 0;
  let bytesCompressed = 0;
  for (let i = 0; i < runs; i += 1) {
    let startedAt = performance.now();
    const serialized = JSON.stringify(payload);
    rawTimes.push(performance.now() - startedAt);

    startedAt = performance.now();
    const compressed = gzipSync(serialized);
    compressedTimes.push(performance.now() - startedAt + rawTimes[rawTimes.length - 1]!);

    bytesRaw = Buffer.byteLength(serialized);
    bytesCompressed = compressed.length; // deterministic input → same output every run
  }

  res.json({
    size,
    runs,
    bytesRaw,
    bytesCompressed,
    ratio: Math.round((bytesCompressed / bytesRaw) * 1000) / 1000,
    msRaw: median(rawTimes),
    msCompressed: median(compressedTimes),
    note: `medians of ${String(runs)} in-process runs: msRaw = JSON.stringify alone; msCompressed = stringify + gzipSync (default level). No network, no negotiation — the payload endpoint above shows the negotiated wire encoding. Byte counts are deterministic; millisecond values vary run to run with the machine.`,
  });
}

export const perfDemoRouter = Router();
perfDemoRouter.get('/demo/perf/payload', payloadCompression, payloadController);
perfDemoRouter.get('/demo/perf/benchmark', benchmarkController);
