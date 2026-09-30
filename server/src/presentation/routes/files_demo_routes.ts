import { createReadStream } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { NotFoundException, ValidationException } from '../../core/error_handling/exceptions.js';
import { parseRangeHeader } from '../../core/http/range_header.js';
import { logger } from '../../core/logging/logger.js';
import {
  FILE_STORE_CAP,
  STORED_EXTENSIONS,
  fileStore,
  safeJoin,
  sanitizeDisplayName,
  type StoredFileMetadata,
} from '../../data/files/file_store.js';

/**
 * The Files & Media topic's live demo endpoints — the topic's artifacts, for
 * real: a multer upload with the full validation stack, downloads with
 * Content-Disposition, a hand-rolled Range responder, a backpressure-honest
 * ndjson producer, and the live path-containment guard.
 *
 * - POST /api/demo/files/upload           → multipart via multer (5MB cap, MIME
 *                                            allowlist, generated names) + sharp
 *                                            variants (128px webp thumb, EXIF strip)
 * - GET  /api/demo/files                  → stored file metadata (ids only — no client paths)
 * - GET  /api/demo/files/:id/download     → res.download (attachment + sanitized name)
 * - GET  /api/demo/files/:id/raw          → sendFile inline
 * - GET  /api/demo/files/:id/thumb        → the sharp webp variant
 * - GET  /api/demo/files/:id/stream       → the RANGE-AWARE streamer (206/416/200)
 * - GET  /api/demo/files/pipeline-demo    → ndjson written with REAL backpressure handling
 * - GET  /api/demo/files/path-guard       → the containment verdict (never reads)
 *
 * Dependency-rule note (deliberate teaching exception, same spirit as the db
 * and routing demo routes): these routes import the file store because the
 * STORE ITSELF — its containment guard, its generated names, its tmp-dir
 * placement — is the artifact being taught.
 */

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 3;
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
] as const;
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const THUMB_WIDTH = 128;

// --- multer: the multipart bus driver ---------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    // The store's session dir under os.tmpdir() — created at boot, NEVER the repo.
    destination: (_req, _file, cb) => cb(null, fileStore.rootDir),
    // GENERATED names only: the client filename is display data, not a path.
    filename: (_req, file, cb) => cb(null, fileStore.reserveStoredName(file.mimetype)),
  }),
  fileFilter: (_req, file, cb) => {
    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(
        new ValidationException(
          `"${file.mimetype}" is not an allowed upload type`,
          {
            reason: 'mime_not_allowed',
            receivedMimeType: file.mimetype,
            allowedMimeTypes: [...ALLOWED_MIME_TYPES],
          },
        ),
      );
      return;
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES_PER_REQUEST },
});

const MULTER_REASON: Readonly<Record<string, string>> = {
  LIMIT_FILE_SIZE: `file exceeds the upload size limit`,
  LIMIT_FILE_COUNT: `too many file parts — the limit is ${MAX_FILES_PER_REQUEST} per request`,
  LIMIT_UNEXPECTED_FILE: `unexpected file part — upload parts under the field name "file"`,
};

/**
 * Wraps a multer middleware so its errors arrive as the canonical envelope.
 * A raw multer.MulterError would fall through to the 500 path; mapped here it
 * becomes a 400 validation failure carrying the multer `code` as `reason`.
 * fileFilter's ValidationException already IS an AppException and flows
 * through unchanged.
 */
function uploadGuard(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (err === undefined) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        next(
          new ValidationException(MULTER_REASON[err.code] ?? `upload rejected (${err.code})`, {
            reason: err.code,
            ...(err.field !== undefined && { field: err.field }),
            fileSizeLimitBytes: MAX_FILE_SIZE_BYTES,
            filesLimit: MAX_FILES_PER_REQUEST,
          }),
        );
        return;
      }
      next(err);
    });
  };
}

/** The minimal writable surface the backpressure writer needs. */
export interface BackpressureSink {
  write(chunk: string): boolean;
  once(event: 'drain' | 'close', listener: () => void): unknown;
}

/**
 * THE backpressure pattern this topic owns (deferred from the Node.js and
 * Request/Response topics, whose demo streams never approached the socket's
 * high-water mark): check res.write()'s return value; when it is false the
 * socket's buffer is full, and you AWAIT the 'drain' event before writing
 * more. 'close' resolves the wait too, so an aborted client cannot hang the
 * producer forever. The unit tests drive this with a fake sink whose write()
 * returns false once — proving the await actually happens.
 */
export async function writeLinesWithBackpressure(
  sink: BackpressureSink,
  lines: readonly string[],
): Promise<{ drainEvents: number; pausedMs: number }> {
  let drainEvents = 0;
  let pausedMs = 0;
  for (const line of lines) {
    if (sink.write(line)) continue; // buffer has room — keep producing
    drainEvents += 1;
    const pausedAt = performance.now();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      sink.once('drain', finish);
      sink.once('close', finish); // client went away — stop waiting
    });
    pausedMs += performance.now() - pausedAt;
  }
  return { drainEvents, pausedMs: Math.round(pausedMs * 10) / 10 };
}

// --- the Range responder (the parser itself lives in core/http/range_header) --

/**
 * The error path a bare `createReadStream(path).pipe(res)` leaves to fate: if
 * the read fails AFTER the status line and Content-Length are on the wire
 * (file deleted between stat and open, EACCES, a disk error), the stream
 * emits 'error' with no listener — and an EventEmitter 'error' nobody hears
 * is not a warning, it is an uncaughtException, which this app's fatal
 * process-level handler answers by exiting. One bad read would take the whole
 * guide down with every connected client. The listener goes on BEFORE the
 * pipe — and once it fires there is no 500 envelope left to send: the headers
 * are committed, so the honest move is to log with the request id and
 * res.destroy() the socket. The client sees a truncated body (fewer bytes
 * than Content-Length promised) instead of a hang or a lie.
 */
export function streamFileToResponse(
  res: Response,
  absolutePath: string,
  requestId: string,
  range?: { start: number; end: number },
): void {
  const stream =
    range === undefined
      ? createReadStream(absolutePath)
      : createReadStream(absolutePath, { start: range.start, end: range.end });
  stream.on('error', (err: Error) => {
    logger.error(
      { err, requestId, path: absolutePath },
      'file stream failed mid-response — destroying the socket',
    );
    stream.destroy();
    res.destroy(); // headers are already sent: a 500 envelope is impossible
  });
  stream.pipe(res);
}

// --- controllers --------------------------------------------------------------

function requireStoredFile(id: string): StoredFileMetadata {
  const meta = fileStore.get(id);
  if (meta === undefined) {
    throw new NotFoundException(`no stored file with id "${id}"`, { fileId: id });
  }
  return meta;
}

/** Re-encodes image bytes in their own format — sharp drops EXIF unless told to keep it. */
function reencodeImage(sourcePath: string, mimeType: string): Promise<Buffer> {
  const pipeline = sharp(sourcePath);
  switch (mimeType) {
    case 'image/jpeg':
      return pipeline.jpeg({ quality: 90 }).toBuffer();
    case 'image/webp':
      return pipeline.webp({ quality: 80 }).toBuffer();
    default:
      return pipeline.png().toBuffer();
  }
}

/**
 * Post-processes one multer-written file: images get an EXIF-stripped
 * re-encode (the original is overwritten with clean bytes) plus a 128px-wide
 * webp thumbnail derived from those clean bytes. Content that LIES about
 * being an image (a text file renamed .png — the fileFilter checks the
 * DECLARED type, not the bytes) fails sharp decoding here and is kept as an
 * opaque file with a note, never a 500.
 *
 * The complete record — derived size, variants, demotion note — is built
 * FIRST and registered ONCE at the end: the store hands out defensive copies
 * only, so post-register mutation is not a thing callers can do anymore.
 */
async function ingestUploadedFile(file: Express.Multer.File): Promise<StoredFileMetadata> {
  const declaredImage = (IMAGE_MIME_TYPES as readonly string[]).includes(file.mimetype);
  const id = fileStore.nextId();
  const draft: Omit<StoredFileMetadata, 'uploadedAt'> = {
    id,
    originalName: sanitizeDisplayName(file.originalname),
    storedName: file.filename,
    mimeType: file.mimetype,
    size: file.size,
    kind: declaredImage ? 'image' : 'file',
  };

  if (!declaredImage) return fileStore.register(draft);

  const originalPath = fileStore.absolutePath(draft); // through the containment guard
  try {
    // Validate + clean FIRST, in memory — nothing is written unless both pass.
    const cleaned = await reencodeImage(originalPath, file.mimetype);
    const thumbBuffer = await sharp(cleaned)
      .resize({ width: THUMB_WIDTH })
      .webp({ quality: 80 })
      .toBuffer();
    const thumbInfo = await sharp(thumbBuffer).metadata();

    const thumbName = `${id}.thumb.webp`; // server-generated variant name
    const size = await fileStore.overwriteOriginal(draft, cleaned); // derived, never mutated in
    await fileStore.writeVariant(thumbName, thumbBuffer);
    return fileStore.register({
      ...draft,
      size,
      variants: {
        thumb: {
          name: thumbName,
          size: thumbBuffer.length,
          width: thumbInfo.width ?? 0,
          height: thumbInfo.height ?? 0,
        },
      },
    });
  } catch {
    // The bytes contradicted the declared MIME. Keep them, demote the record.
    return fileStore.register({
      ...draft,
      kind: 'file',
      note: `declared ${file.mimetype}, but the bytes are not a decodable image — stored as an opaque file with no variants`,
    });
  }
}

async function uploadController(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    throw new ValidationException('no file parts arrived — attach part(s) under the field name "file"', {
      expectedField: 'file',
      hint: 'multipart/form-data — curl -F "file=@photo.jpg" (fetch: new FormData().append("file", file))',
    });
  }
  const ingested: StoredFileMetadata[] = [];
  for (const file of files) {
    ingested.push(await ingestUploadedFile(file));
  }
  res.status(201).json({ files: ingested, file: ingested[0] });
}

function listController(_req: Request, res: Response): void {
  const files = fileStore.list();
  res.json({
    files,
    count: files.length,
    cap: FILE_STORE_CAP,
    uploadRoot: fileStore.rootDir,
    storedExtensions: STORED_EXTENSIONS,
  });
}

async function downloadController(req: Request, res: Response): Promise<void> {
  const meta = requireStoredFile(String(req.params.id));
  // res.download = sendFile + Content-Disposition: attachment, with Express
  // handling the RFC 5987 filename* encoding for non-ASCII names.
  await res.download(fileStore.absolutePath(meta), sanitizeDisplayName(meta.originalName));
}

function rawController(req: Request, res: Response): void {
  const meta = requireStoredFile(String(req.params.id));
  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(fileStore.absolutePath(meta));
}

function thumbController(req: Request, res: Response): void {
  const meta = requireStoredFile(String(req.params.id));
  const thumb = meta.variants?.thumb;
  if (thumb === undefined) {
    throw new NotFoundException(
      `file ${meta.id} has no thumbnail${meta.note !== undefined ? ` (${meta.note})` : ' — it is not a processed image'}`,
      { fileId: meta.id },
    );
  }
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(fileStore.variantPath(meta, thumb.name));
}

async function streamController(req: Request, res: Response): Promise<void> {
  const meta = requireStoredFile(String(req.params.id));
  const absolutePath = fileStore.absolutePath(meta);
  const size = fileStore.sizeOnDisk(absolutePath);
  // Node's http types allow string | undefined here; a repeated Range header
  // joins with ", " which the parser treats as (ignored) multi-range anyway.
  const raw = req.headers.range;
  const parsed = parseRangeHeader(raw, size);
  // The log line streamFileToResponse writes if the read fails mid-stream.
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a';

  res.setHeader('Accept-Ranges', 'bytes');

  if (parsed.kind === 'none' || parsed.kind === 'ignored') {
    // No Range (or one we disregard per spec) → the full representation, 200.
    // Header values must stay ASCII — Node rejects non-Latin-1 characters.
    res.status(200);
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Length', String(size));
    if (parsed.kind === 'ignored') {
      res.setHeader('X-Range-Verdict', `ignored: ${parsed.reason}`);
    }
    streamFileToResponse(res, absolutePath, requestId);
    return;
  }

  if (parsed.kind === 'unsatisfiable') {
    // Valid syntax, but outside the file → 416 with the */size pointer so the
    // client can learn the real size. Hand-rolled envelope (the app's failure
    // taxonomy has no 416 kind — this shape matches it deliberately). No
    // Content-Type preset here: res.json must be free to set application/json,
    // or clients (and supertest) will not parse the envelope.
    res.status(416);
    res.setHeader('Content-Range', `bytes */${size}`);
    res.json({
      error: {
        code: 'range_not_satisfiable',
        message: `Range "${raw}" cannot be satisfied — the file is ${size} bytes`,
        requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a',
        fileSizeBytes: size,
      },
    });
    return;
  }

  // Satisfiable → 206 + Content-Range + EXACTLY the requested slice.
  const { start, end } = parsed;
  res.status(206);
  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  streamFileToResponse(res, absolutePath, requestId, { start, end });
}

// --- the pipeline demo (ndjson with real backpressure) ------------------------

const PIPELINE_CHUNKS_DEFAULT = 200;
const PIPELINE_CHUNKS_MIN = 1;
const PIPELINE_CHUNKS_MAX = 2000;
/** Each line is ~2KB — big enough that a client slower than the producer can actually fill the socket buffer. */
const LINE_PADDING = 2048;

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

function pipelineLines(count: number): string[] {
  const filler = 'x'.repeat(LINE_PADDING);
  const lines: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(
      `{"seq":${i},"event":"telemetry","payload":"${filler}"}\n`,
    );
  }
  return lines;
}

async function pipelineDemoController(req: Request, res: Response): Promise<void> {
  const chunks = parseBoundedInt(
    req.query.chunks,
    'chunks',
    PIPELINE_CHUNKS_DEFAULT,
    PIPELINE_CHUNKS_MIN,
    PIPELINE_CHUNKS_MAX,
  );

  res.status(200).type('application/x-ndjson');
  res.setHeader('X-Pipeline', 'backpressure-aware');

  const lines = pipelineLines(chunks);
  const { drainEvents, pausedMs } = await writeLinesWithBackpressure(res, lines);

  // The honest summary rides as the LAST ndjson line: how many times the
  // producer had to pause, and how long it waited. With a fast local client
  // (supertest buffers eagerly) drainEvents may honestly be 0 — the pattern's
  // proof lives in the unit test with a fake sink that returns false.
  res.write(
    `${JSON.stringify({ summary: true, chunks, drainEvents, pausedMs })}\n`,
  );
  res.end();
}

// --- the path-guard (containment, live — never reads anything) -----------------

function pathGuardController(req: Request, res: Response): void {
  const raw = req.query.input;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationException('"input" query parameter is required (the path candidate to judge)', {
      parameter: 'input',
      example: 'reports/2026/q3.csv',
      attackExample: '../../etc/passwd',
    });
  }

  const resolvedRoot = path.resolve(fileStore.rootDir);
  const verdict = safeJoin(fileStore.rootDir, raw);
  const contained = verdict.ok;

  res.json({
    input: raw,
    uploadRoot: resolvedRoot,
    resolved: path.resolve(resolvedRoot, raw),
    contained,
    verdict: contained ? 'allowed' : 'rejected',
    ...(contained ? {} : { reason: verdict.reason }),
    readsNothing: true,
    note: contained
      ? 'resolve() kept the path inside the upload root — a real read would proceed from here (this endpoint never reads)'
      : 'path.resolve() walked OUTSIDE the upload root — the guard refuses before any filesystem call. Query params arrive URL-DECODED, so ../ and ..%2F are the same attack by the time you see them.',
  });
}

// --- the router ----------------------------------------------------------------

export const filesDemoRouter = Router();
filesDemoRouter.post('/demo/files/upload', uploadGuard(upload.array('file', MAX_FILES_PER_REQUEST)), uploadController);
filesDemoRouter.get('/demo/files', listController);
filesDemoRouter.get('/demo/files/pipeline-demo', pipelineDemoController);
filesDemoRouter.get('/demo/files/path-guard', pathGuardController);
filesDemoRouter.get('/demo/files/:id/download', downloadController);
filesDemoRouter.get('/demo/files/:id/raw', rawController);
filesDemoRouter.get('/demo/files/:id/thumb', thumbController);
filesDemoRouter.get('/demo/files/:id/stream', streamController);
