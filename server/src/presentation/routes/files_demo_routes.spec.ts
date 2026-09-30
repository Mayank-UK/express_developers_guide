import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import type { Response } from 'express';
import { createApp } from '../../app.js';
import {
  FILE_STORE_CAP,
  fileStore,
  safeJoin,
  sanitizeDisplayName,
} from '../../data/files/file_store.js';
import { parseRangeHeader } from '../../core/http/range_header.js';
import { streamFileToResponse, writeLinesWithBackpressure } from './files_demo_routes.js';
import { UUID_RE } from '../../test_support/index.js';

/** A real 1×1 transparent PNG — the smallest honest image that exists. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Deterministic 100-byte text body: "0123456789" × 10 — range math is easy to eyeball. */
const TEXT_100 = Buffer.from('0123456789'.repeat(10), 'utf8');

let pixelJpeg: Buffer;

beforeEach(() => {
  fileStore.reset(); // each spec starts with an empty session dir
});

afterAll(() => {
  fileStore.reset();
});

/** application/x-ndjson has no superagent parser — the body arrives as a Buffer. */
function bodyText(res: request.Response): string {
  const raw = res.text !== undefined ? res.text : String(res.body);
  return raw.replace(/\r/g, '');
}

// --- pure units: the display-name sanitizer -----------------------------------

describe('sanitizeDisplayName (display only — never a filesystem path)', () => {
  it('strips path components in both separator styles', () => {
    expect(sanitizeDisplayName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeDisplayName('C:\\Users\\mak\\photo.png')).toBe('photo.png');
    expect(sanitizeDisplayName('nested/folders/deep.txt')).toBe('deep.txt');
  });

  it('drops control characters and answers something for empty input', () => {
    expect(sanitizeDisplayName('ev\u0000il.png')).toBe('evil.png');
    expect(sanitizeDisplayName('\u0001\u0002')).toBe('unnamed');
    expect(sanitizeDisplayName('')).toBe('unnamed');
    expect(sanitizeDisplayName('ok.png')).toBe('ok.png');
  });

  it('caps absurdly long names without losing the extension', () => {
    const long = `${'a'.repeat(200)}.png`;
    const sanitized = sanitizeDisplayName(long);
    expect(sanitized.length).toBeLessThanOrEqual(80);
    expect(sanitized.endsWith('.png')).toBe(true);
  });
});

// --- pure units: the containment guard ------------------------------------------

describe('safeJoin (resolve + startsWith containment)', () => {
  const root = '/tmp/express_guide_uploads/demo-session';

  it('allows names that stay inside the root', () => {
    expect(safeJoin(root, 'a.txt')).toEqual({ ok: true, path: `${root}/a.txt` });
    expect(safeJoin(root, 'sub/../b.txt')).toEqual({ ok: true, path: `${root}/b.txt` });
    expect(safeJoin(root, 'sub/dir/c.webp')).toEqual({ ok: true, path: `${root}/sub/dir/c.webp` });
  });

  it('rejects traversal, absolute escapes, and null bytes', () => {
    expect(safeJoin(root, '../../etc/passwd')).toEqual({
      ok: false,
      reason: 'escapes the upload root',
    });
    expect(safeJoin(root, '/etc/passwd')).toEqual({
      ok: false,
      reason: 'escapes the upload root',
    });
    expect(safeJoin(root, 'ok.png\u0000.jpg')).toEqual({ ok: false, reason: 'null byte' });
  });
});

// --- pure units: the Range parser (the hard matrix) ------------------------------

describe('parseRangeHeader (the spec matrix)', () => {
  const SIZE = 100;

  it('treats a missing or blank header as no-range', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('  ', SIZE)).toEqual({ kind: 'none' });
  });

  it('parses closed, open-ended, and suffix forms', () => {
    expect(parseRangeHeader('bytes=0-9', SIZE)).toEqual({ kind: 'satisfiable', start: 0, end: 9 });
    expect(parseRangeHeader('bytes=5-', SIZE)).toEqual({
      kind: 'satisfiable',
      start: 5,
      end: 99,
    });
    expect(parseRangeHeader('bytes=-10', SIZE)).toEqual({
      kind: 'satisfiable',
      start: 90,
      end: 99,
    });
    expect(parseRangeHeader('bytes=0-0', SIZE)).toEqual({ kind: 'satisfiable', start: 0, end: 0 });
  });

  it('clamps an end beyond the file and covers the whole file for an oversized suffix', () => {
    expect(parseRangeHeader('bytes=0-999999', SIZE)).toEqual({
      kind: 'satisfiable',
      start: 0,
      end: 99,
    });
    expect(parseRangeHeader('bytes=-200', SIZE)).toEqual({
      kind: 'satisfiable',
      start: 0,
      end: 99,
    });
  });

  it('marks valid-but-outside ranges unsatisfiable (→ 416)', () => {
    expect(parseRangeHeader('bytes=100-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=999999-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores malformed, non-bytes, inverted, and multi-range specs (→ 200 full)', () => {
    expect(parseRangeHeader('bytes=abc', SIZE).kind).toBe('ignored');
    expect(parseRangeHeader('bytes=', SIZE).kind).toBe('ignored');
    expect(parseRangeHeader('bytes=-', SIZE).kind).toBe('ignored');
    expect(parseRangeHeader('items=0-1', SIZE).kind).toBe('ignored');
    expect(parseRangeHeader('bytes=90-10', SIZE).kind).toBe('ignored');
    expect(parseRangeHeader('bytes=0-9,20-29', SIZE).kind).toBe('ignored');
    expect(parseRangeHeader('garbage', SIZE).kind).toBe('ignored');
    // Range units are case-insensitive per spec:
    expect(parseRangeHeader('BYTES=0-9', SIZE)).toEqual({ kind: 'satisfiable', start: 0, end: 9 });
  });
});

// --- pure units: the backpressure writer (fake sink proves the await) -------------

describe('writeLinesWithBackpressure (the fake-res proof)', () => {
  it('awaits drain before writing again when write() returns false', async () => {
    const events: string[] = [];
    let calls = 0;
    const sink = {
      write: (_chunk: string): boolean => {
        calls += 1;
        events.push(`write${calls}`);
        return calls !== 2; // the second write fills the socket buffer
      },
      once: (event: 'drain' | 'close', listener: () => void): void => {
        expect(['drain', 'close']).toContain(event);
        if (event === 'close') return; // no abort in this scenario
        events.push('wait-registered');
        setTimeout(() => {
          events.push('drain');
          listener();
        }, 15);
      },
    };

    const report = await writeLinesWithBackpressure(sink, ['a\n', 'b\n', 'c\n']);
    events.push('done');

    // The third write MUST follow the drain event — that ordering is the pattern.
    expect(events).toEqual(['write1', 'write2', 'wait-registered', 'drain', 'write3', 'done']);
    expect(report.drainEvents).toBe(1);
    expect(report.pausedMs).toBeGreaterThanOrEqual(10);
  });

  it('never pauses when write() always returns true', async () => {
    const sink = { write: (): boolean => true, once: (): void => {} };
    const report = await writeLinesWithBackpressure(sink, ['a\n', 'b\n']);
    expect(report).toEqual({ drainEvents: 0, pausedMs: 0 });
  });

  it('resolves the wait on close too — an aborted client cannot hang the producer', async () => {
    const listeners: Array<() => void> = [];
    let calls = 0;
    const sink = {
      write: (): boolean => {
        calls += 1;
        return calls !== 1; // pause immediately on the first write
      },
      once: (event: 'drain' | 'close', listener: () => void): void => {
        if (event === 'close') listeners.push(listener);
      },
    };

    const pending = writeLinesWithBackpressure(sink, ['a\n', 'b\n']);
    // Give the writer a tick to register its listeners, then abort:
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(listeners.length).toBe(1);
    listeners[0]!();
    const report = await pending;
    expect(report.drainEvents).toBe(1);
  });
});

// --- pure units: the streamer's mid-response error path ----------------------------

/**
 * pipe() touches the destination's EventEmitter surface synchronously (drain/
 * error/close hooks) before any byte flows, so the fake res needs those too —
 * a bare { destroy } would throw inside pipe() before the read ever failed.
 */
function fakeStreamResponse(): { res: Response; destroy: Mock } {
  const destroy = vi.fn();
  const res = {
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    write: vi.fn((): boolean => true),
    end: vi.fn(),
    destroy,
  } as unknown as Response;
  return { res, destroy };
}

describe('streamFileToResponse (a failed read must not become an uncaughtException)', () => {
  const MISSING_PATH = '/nonexistent/express-guide-unit/stream-error.txt';

  it('listens for the error synchronously and destroys the response when the read fails', async () => {
    const { res, destroy } = fakeStreamResponse();

    // No listener attached here ⇒ the later 'error' event would be an
    // uncaughtException that the process-level fatal handler exits on. The
    // call itself must not throw — the listener goes on before any I/O.
    expect(() => streamFileToResponse(res, MISSING_PATH, 'req-unit-1')).not.toThrow();

    // ENOENT arrives on a later tick (open() is async): poll for the destroy
    // the error handler owes us rather than guessing a fixed delay.
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  });

  it('guards the 206 range slice the same way', async () => {
    const { res, destroy } = fakeStreamResponse();

    expect(() =>
      streamFileToResponse(res, MISSING_PATH, 'req-unit-1', { start: 0, end: 9 }),
    ).not.toThrow();

    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  });
});

// --- the store: cap eviction ------------------------------------------------------

describe('FileStore cap', () => {
  it('evicts the oldest files beyond the cap of 50', () => {
    for (let i = 0; i < FILE_STORE_CAP + 3; i += 1) {
      fileStore.register({
        id: `files-test${String(i).padStart(3, '0')}`,
        originalName: `f${i}.txt`,
        storedName: `up-test${i}.txt`,
        mimeType: 'text/plain',
        size: 1,
        kind: 'file',
      });
    }
    const list = fileStore.list();
    expect(list).toHaveLength(FILE_STORE_CAP);
    expect(fileStore.get('files-test000')).toBeUndefined(); // oldest evicted
    expect(fileStore.get('files-test052')).toBeDefined(); // newest kept
  });
});

// --- the store: defensive-copy discipline ------------------------------------------

describe('FileStore hands out defensive copies (house discipline: callers never hold store state)', () => {
  const record = {
    id: 'files-copy-1',
    originalName: 'copy.txt',
    storedName: 'up-copy-1.txt',
    mimeType: 'text/plain',
    size: 100,
    kind: 'file' as const,
  };

  it('mutating a record from list()/get()/register() never changes the store', () => {
    const registered = fileStore.register({ ...record });
    const listed = fileStore.list();

    // Every handle is its own object — no live references to store internals:
    expect(registered).not.toBe(listed[0]);
    expect(fileStore.get(record.id)).not.toBe(listed[0]);

    // Bash every mutation vector a careless caller might reach for:
    registered.originalName = 'hacked-via-register';
    listed[0].size = 999_999;
    (listed[0].variants ??= {}).thumb = { name: 'evil.webp', size: 0, width: 0, height: 0 };
    fileStore.get(record.id)!.originalName = 'hacked-via-get';

    const fresh = fileStore.get(record.id);
    expect(fresh).toMatchObject({ originalName: 'copy.txt', size: 100 });
    expect(fresh?.variants?.thumb).toBeUndefined();
    expect(fileStore.list()[0]).toMatchObject({ originalName: 'copy.txt', size: 100 });
  });

  it('overwriteOriginal derives the new size into its RETURN — the stored record is never mutated', async () => {
    const registered = fileStore.register(record);
    await fileStore.writeVariant(record.storedName, Buffer.from('stale bytes')); // the guarded write creates the file

    const reported = await fileStore.overwriteOriginal(record, Buffer.from('0123456789'));
    expect(reported).toBe(10); // the honest post-rewrite size, for the caller to register

    // The store still holds what was registered — derivation is the caller's job:
    expect(fileStore.get(record.id)?.size).toBe(100);
    expect(registered.size).toBe(100);
  });
});

// --- HTTP: the upload pipeline ----------------------------------------------------

async function uploadPng(): Promise<request.Response> {
  return request(createApp())
    .post('/api/demo/files/upload')
    .attach('file', PIXEL_PNG, { filename: 'pixel.png', contentType: 'image/png' });
}

describe('POST /api/demo/files/upload', () => {
  it('stores a real PNG with generated names, a webp thumb, and EXIF-stripped bytes', async () => {
    const res = await uploadPng();

    expect(res.status).toBe(201);
    const file = res.body.file;
    expect(file.id).toMatch(/^files-/);
    expect(file.kind).toBe('image');
    expect(file.originalName).toBe('pixel.png');
    // Stored names are server-generated — nothing client-shaped:
    expect(file.storedName).toMatch(/^up-[0-9a-f]{18}\.png$/);
    expect(file.storedName).not.toContain('pixel');
    expect(file.size).toBeGreaterThan(0);
    expect(file.variants?.thumb?.size).toBeGreaterThan(0);
    expect(file.variants?.thumb?.name).toMatch(/^files-.*\.thumb\.webp$/);
    expect(res.body.files).toHaveLength(1);

    // The thumbnail endpoint serves the webp variant:
    const thumb = await request(createApp()).get(`/api/demo/files/${file.id}/thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(Buffer.byteLength(thumb.body)).toBeGreaterThan(0);
    const thumbMeta = await sharp(thumb.body).metadata();
    expect(thumbMeta.format).toBe('webp');

    // The original was re-encoded (sharp rewrote it without ancillary chunks):
    const raw = await request(createApp()).get(`/api/demo/files/${file.id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('image/png');
    const rawMeta = await sharp(raw.body).metadata();
    expect(rawMeta.format).toBe('png');
    expect(raw.body.length).toBeGreaterThan(0);
  });

  it('sanitizes a path-shaped client filename and never uses it on disk', async () => {
    const res = await request(createApp())
      .post('/api/demo/files/upload')
      .attach('file', PIXEL_PNG, {
        filename: '../../../etc/passwd.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(201);
    expect(res.body.file.originalName).toBe('passwd.png'); // display name: basename only
    expect(res.body.file.storedName).toMatch(/^up-[0-9a-f]{18}\.png$/);

    // The download re-sanitizes into the Content-Disposition filename:
    const download = await request(createApp()).get(
      `/api/demo/files/${res.body.file.id}/download`,
    );
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-disposition']).toContain('passwd.png');
    expect(download.headers['content-disposition']).not.toContain('../');
  });

  it('demotes content that lies about being an image — no 500, an honest note', async () => {
    const res = await request(createApp())
      .post('/api/demo/files/upload')
      .attach('file', Buffer.from('this is definitely not a png, just text lying about its type'), {
        filename: 'imposter.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(201);
    expect(res.body.file.kind).toBe('file');
    expect(res.body.file.note).toContain('not a decodable image');
    expect(res.body.file.variants).toBeUndefined();

    const thumb = await request(createApp()).get(`/api/demo/files/${res.body.file.id}/thumb`);
    expect(thumb.status).toBe(404);
    expect(thumb.body.error.code).toBe('not_found');
    expect(thumb.body.error.requestId).toMatch(UUID_RE);

    // The raw bytes are still served (nosniff keeps the declared type honest):
    const raw = await request(createApp()).get(`/api/demo/files/${res.body.file.id}/raw`);
    expect(raw.status).toBe(200);
  });

  it('rejects an oversized file with the canonical envelope naming the limit', async () => {
    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 512, 65); // 5MB + 512 of 'A'
    const res = await request(createApp())
      .post('/api/demo/files/upload')
      .attach('file', tooBig, { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.reason).toBe('LIMIT_FILE_SIZE');
    expect(res.body.error.fileSizeLimitBytes).toBe(5 * 1024 * 1024);
    expect(res.body.error.requestId).toMatch(UUID_RE);
  });

  it('rejects a disallowed MIME type at the filter', async () => {
    const res = await request(createApp())
      .post('/api/demo/files/upload')
      .attach('file', Buffer.from('MZfake executable bytes'), {
        filename: 'tool.exe',
        contentType: 'application/x-msdownload',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.reason).toBe('mime_not_allowed');
    expect(res.body.error.allowedMimeTypes).toContain('image/png');
  });

  it('rejects a multipart request with no file parts', async () => {
    const res = await request(createApp()).post('/api/demo/files/upload').field('note', 'no file');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.expectedField).toBe('file');
  });

  it('rejects more than three file parts with the count limit', async () => {
    const res = await request(createApp())
      .post('/api/demo/files/upload')
      .attach('file', TEXT_100, { filename: 'a.txt', contentType: 'text/plain' })
      .attach('file', TEXT_100, { filename: 'b.txt', contentType: 'text/plain' })
      .attach('file', TEXT_100, { filename: 'c.txt', contentType: 'text/plain' })
      .attach('file', TEXT_100, { filename: 'd.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.reason).toBe('LIMIT_FILE_COUNT');
    expect(res.body.error.filesLimit).toBe(3);
  });

  it('re-encodes a real JPEG through the jpeg quality-90 path', async () => {
    pixelJpeg ??= await sharp(PIXEL_PNG).jpeg().toBuffer();
    const res = await request(createApp())
      .post('/api/demo/files/upload')
      .attach('file', pixelJpeg, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.file.kind).toBe('image');
    expect(res.body.file.storedName).toMatch(/^up-[0-9a-f]{18}\.jpg$/);
    const raw = await request(createApp()).get(`/api/demo/files/${res.body.file.id}/raw`);
    expect(await sharp(raw.body).metadata()).toMatchObject({ format: 'jpeg' });
  });
});

// --- HTTP: listing + downloads -----------------------------------------------------

describe('GET /api/demo/files (listing) and download/raw', () => {
  it('lists stored metadata and serves a text file end to end', async () => {
    const uploaded = await request(createApp())
      .post('/api/demo/files/upload')
      .attach('file', TEXT_100, { filename: 'notes.txt', contentType: 'text/plain' });
    expect(uploaded.status).toBe(201);
    const id = uploaded.body.file.id as string;

    const list = await request(createApp()).get('/api/demo/files');
    expect(list.status).toBe(200);
    expect(list.body.files).toHaveLength(1);
    expect(list.body.files[0]).toMatchObject({
      id,
      originalName: 'notes.txt',
      kind: 'file',
      mimeType: 'text/plain',
      size: 100,
    });
    expect(list.body.cap).toBe(50);
    expect(list.body.uploadRoot).toContain('express_guide_uploads');

    const download = await request(createApp()).get(`/api/demo/files/${id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toBe(
      'attachment; filename="notes.txt"',
    );
    expect(download.headers['content-type']).toContain('text/plain');

    const raw = await request(createApp()).get(`/api/demo/files/${id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-disposition']).toBe('inline');
    expect(bodyText(raw)).toBe(TEXT_100.toString('utf8'));

    const missing = await request(createApp()).get('/api/demo/files/files-nope/raw');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });
});

// --- HTTP: the range-aware streamer -------------------------------------------------

describe('GET /api/demo/files/:id/stream (range requests)', () => {
  let id = '';
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    app = createApp();
    const uploaded = await request(app)
      .post('/api/demo/files/upload')
      .attach('file', TEXT_100, { filename: 'range.txt', contentType: 'text/plain' });
    expect(uploaded.status).toBe(201);
    id = uploaded.body.file.id;
  });

  const get = (range?: string): request.Test =>
    range === undefined
      ? request(app).get(`/api/demo/files/${id}/stream`)
      : request(app).get(`/api/demo/files/${id}/stream`).set('Range', range);

  it('serves the full body with 200 + Accept-Ranges when no Range arrives', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('100');
    expect(bodyText(res)).toBe(TEXT_100.toString('utf8'));
  });

  it('serves exactly the requested slice with 206 + Content-Range', async () => {
    const res = await get('bytes=0-9');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-9/100');
    expect(res.headers['content-length']).toBe('10');
    expect(bodyText(res)).toBe('0123456789');
  });

  it('serves open-ended ranges to the end of the file', async () => {
    const res = await get('bytes=5-');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 5-99/100');
    expect(res.headers['content-length']).toBe('95');
    expect(bodyText(res)).toBe(TEXT_100.toString('utf8').slice(5));
  });

  it('serves suffix ranges — the last N bytes (resumable downloads)', async () => {
    const res = await get('bytes=-10');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 90-99/100');
    expect(res.headers['content-length']).toBe('10');
    expect(bodyText(res)).toBe(TEXT_100.toString('utf8').slice(-10));
  });

  it('answers 416 with the */size pointer for unsatisfiable ranges', async () => {
    const res = await get('bytes=999999-');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */100');
    expect(res.body.error.code).toBe('range_not_satisfiable');
    expect(res.body.error.fileSizeBytes).toBe(100);
    expect(res.body.error.requestId).toMatch(UUID_RE);
  });

  it('deliberately ignores garbage, inverted, and multi-range specs — 200 full', async () => {
    for (const range of ['bytes=zzz', 'bytes=90-10', 'bytes=0-9,20-29', 'items=0-1']) {
      const res = await get(range);
      expect(res.status, `Range: ${range}`).toBe(200);
      expect(res.headers['x-range-verdict']).toContain('ignored');
      expect(bodyText(res)).toBe(TEXT_100.toString('utf8'));
    }
  });

  it('404s a range request for an unknown id', async () => {
    const res = await request(app).get('/api/demo/files/files-void/stream').set('Range', 'bytes=0-9');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

// --- HTTP: the backpressure pipeline --------------------------------------------------

describe('GET /api/demo/files/pipeline-demo', () => {
  it('streams ndjson and ends with the honest summary line', async () => {
    const res = await request(createApp()).get('/api/demo/files/pipeline-demo?chunks=5');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['x-pipeline']).toBe('backpressure-aware');

    const lines = bodyText(res).split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(6); // 5 telemetry lines + 1 summary
    const telemetry = lines.slice(0, 5).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(telemetry.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5]);

    const summary = JSON.parse(lines[5]!) as Record<string, unknown>;
    expect(summary.summary).toBe(true);
    expect(summary.chunks).toBe(5);
    // drainEvents is honestly reported — 0 with supertest's eager buffering is
    // a truthful answer; the await logic itself is proven by the fake-sink unit.
    expect(summary.drainEvents).toEqual(expect.any(Number));
    expect(summary.pausedMs).toEqual(expect.any(Number));
    expect(summary.pausedMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects garbage chunk counts and clamps the range', async () => {
    const garbage = await request(createApp()).get('/api/demo/files/pipeline-demo?chunks=abc');
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('validation_failed');
    expect(garbage.body.error.parameter).toBe('chunks');

    const zero = await request(createApp()).get('/api/demo/files/pipeline-demo?chunks=0');
    expect(zero.status).toBe(200);
    const lines = bodyText(zero).split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2); // clamped to 1 + the summary
    expect((JSON.parse(lines[1]!) as Record<string, unknown>).chunks).toBe(1);
  });
});

// --- HTTP: the path guard -------------------------------------------------------------

describe('GET /api/demo/files/path-guard (containment, live — never reads)', () => {
  it('rejects plain traversal and the URL-decoded spelling of the same attack', async () => {
    for (const input of ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd']) {
      const res = await request(createApp()).get(`/api/demo/files/path-guard?input=${input}`);
      expect(res.status, `input=${input}`).toBe(200);
      expect(res.body.contained).toBe(false);
      expect(res.body.verdict).toBe('rejected');
      expect(res.body.resolved).not.toContain(res.body.uploadRoot);
      expect(res.body.readsNothing).toBe(true);
    }
  });

  it('rejects absolute escapes and null bytes with named reasons', async () => {
    const absolute = await request(createApp()).get(
      `/api/demo/files/path-guard?input=${encodeURIComponent('/etc/passwd')}`,
    );
    expect(absolute.body.contained).toBe(false);
    expect(absolute.body.verdict).toBe('rejected');

    const nullByte = await request(createApp()).get(
      `/api/demo/files/path-guard?input=${encodeURIComponent('safe.png\u0000.jpg')}`,
    );
    expect(nullByte.body.contained).toBe(false);
    expect(nullByte.body.reason).toBe('null byte');
  });

  it('allows a name that resolves inside the upload root', async () => {
    const res = await request(createApp()).get(
      `/api/demo/files/path-guard?input=${encodeURIComponent('reports/2026/q3.csv')}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.contained).toBe(true);
    expect(res.body.verdict).toBe('allowed');
    expect(res.body.resolved.startsWith(res.body.uploadRoot)).toBe(true);
  });

  it('requires the input parameter', async () => {
    const res = await request(createApp()).get('/api/demo/files/path-guard');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.parameter).toBe('input');
  });
});
