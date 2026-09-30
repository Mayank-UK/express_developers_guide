import type { Topic } from '../types.js';

/**
 * The Files and Media topic: the byte-level half of the guide. Everything
 * here runs for real in this app — the multer upload and its validation
 * stack, the sharp thumbnail pipeline, the hand-rolled Range responder, the
 * backpressure-honest ndjson producer, and the path-containment guard live
 * under /api/demo/files and the workbench demo drives all of it. This topic
 * also OWNS two patterns earlier topics deliberately deferred: real
 * backpressure handling (the Node.js and Request/Response stream demos never
 * approached the socket's high-water mark) and the path-traversal guard the
 * Security topic promised.
 */
export const topicFilesMedia: Topic = {
  id: 'files-media',
  title: 'Files and Media',
  subtitle:
    'Uploads with validation, downloads, range requests, and image processing.',
  group: 'files-media',
  order: 1,
  sections: [
    {
      id: 'files-uploads-anatomy',
      title: 'Uploads are streams, not payloads',
      lead:
        'A file crossing HTTP is not JSON with extra steps — it is a different wire format, a different parser, and a different resource profile. Start with what multipart actually is before touching a library.',
      blocks: [
        {
          kind: 'text',
          id: 'files-uploads-anatomy:multipart',
          body: `THE WIRE FORMAT, first, because every library decision falls out of it. A file upload rides MULTIPART/Form-DATA: one HTTP body carrying several PARTS — each part a set of headers (a name, and for files a filename plus a content type) followed by raw bytes — separated by a BOUNDARY string that must not occur in any part's data. The Content-Type header announces it: multipart/form-data; boundary=----WebKitFormBoundaryX3nHtZ... and the body is boundary-delimited sections the receiver must PARSE, not deserialize. That is the first mental shift from JSON: express.json() reads a bounded buffer and runs JSON.parse; multipart is a STREAMING format where the parser walks boundaries over bytes as they arrive — a 2GB upload never needs 2GB of RAM, and a good parser never buffers more than one part (or one chunk) at a time. WHY JSON APIs DO NOT DO FILES, three reasons stacked: (1) ENCODING — JSON strings are UTF-16-ish text; file bytes are arbitrary binary, so you would have to base64 them (+33% size, CPU on both ends, and now your "body" is a giant string your JSON parser happily tries to hold whole); (2) BOUNDARIES — JSON has no framing for "here ends the metadata, here starts the blob, there are two blobs"; multipart has boundaries exactly for that; (3) STREAMING — JSON bodies are parsed whole, so a JSON-file API is an unbounded-buffering API by construction. This is also why JSON APIs cap body sizes so aggressively (this guide's own limits topic) while file endpoints stream. MULTER IS THE BUS DRIVER: Express ships body parsers for urlencoded and JSON but deliberately NOT multipart (connect's multipart middleware was removed in 2014 over resource-exhaustion concerns — the Express maintainers' position is that multipart parsing is a specialized, security-sensitive job). Multer is the standard answer: a middleware that consumes the multipart stream, enforces limits WHILE PARSING (a size cap aborts mid-part, not after buffering), and hands the route req.file / req.files plus parsed text fields on req.body. It is still Express-shaped — mounted per-route, errors flowing through next() — which is why this app wraps it (below) so its errors land in the one error envelope instead of a naked 500. MEMORY VS DISK STORAGE, the first real decision: multer.diskStorage streams each part straight to a file on disk (constant memory, survives reboots, but you manage temp files and cleanup) while multer.memoryStorage holds the whole file in a Buffer (simplest possible post-processing — the buffer IS the input to sharp or S3 upload — but N concurrent uploads × M MB each is a DoS primitive pointed at your own RAM). The rules of thumb: files that get post-processed into OTHER bytes (thumbnails, transcodes) can stream to disk and let the processor re-read them; files forwarded verbatim to object storage can go memory if small and capped HARD; anything uncapped goes to disk. This guide uses disk storage into a session dir under os.tmpdir() — never inside the repo — because the post-processing story (sharp reads the file, rewrites it, writes a variant) wants stable paths, and because "uploads land outside the source tree" is a standing rule the path-traversal section will justify.`,
        },
      ],
    },
    {
      id: 'files-receiving-safety',
      title: 'Receiving uploads safely',
      lead:
        'An upload endpoint is a writeable filesystem API exposed to the internet. The validation stack is not optional: MIME allowlist, size caps, generated names, and a storage location that is not your codebase.',
      blocks: [
        {
          kind: 'text',
          id: 'files-receiving-safety:layers',
          body: `THE THREAT MODEL BEFORE THE CODE (the security topic's habit, applied). An upload endpoint grants strangers the ability to put BYTES on your disk and later have those bytes SERVED BACK — so the failure modes are: arbitrary file OVERWRITE (writing ../../start-uploads/every-boot.png somewhere that executes), STORAGE EXHAUSTION (one client uploading until the disk fills and the database dies), TOXIC PAYLOADS (a "PNG" that is a PHP script or an HTML page — stored XSS the moment it is served inline from your origin), and PATH MANIPULATION (the client filename is a path traversal attempt, or contains a null byte, or just collides with another user's file). The defense stack, layered in the order the request meets them: (1) THE MIME ALLOWLIST in fileFilter — reject anything not on a short list you chose (this guide: image/jpeg, image/png, image/webp, application/pdf, text/plain). An allowlist, never a blocklist of "known bad" — blocklists always miss one spelling. Honest limit, stated now because the demo proves it: fileFilter sees the DECLARED Content-Type of the part, which the client fully controls — a text file renamed .png sails through with image/png on its lips. Type-by-BYTES (magic numbers, or just letting sharp try to decode) is the deeper check; this app catches the lie at the processing step and demotes the file with an honest note instead of a 500. (2) LIMITS, ENFORCED MID-STREAM — fileSize caps each part (5MB here), files caps parts per request (3), and multer enforces them while parsing: an oversized part is aborted partway through the stream, not buffered to completion and then measured. The unsung hero is parts/fields limits — without them a client can send ten thousand tiny parts and make the parser itself the DoS. (3) GENERATED STORAGE NAMES — the client filename is DISPLAY DATA, never a path component. The diskStorage filename callback in this app ignores it entirely and mints up-<24-hex>.<ext> where the extension comes from the server's own MIME→extension map. This kills three attacks in one move: path traversal (nothing client-controlled reaches path.join), COLLISIONS (two users uploading photo.png cannot clobber each other, and an attacker cannot target a known name), and CONFUSION (the stored name's extension always matches the validated MIME). The original name survives only as SANITIZED display metadata — basename only, control characters stripped, length capped (data/files/file_store.ts, sanitizeDisplayName). (4) STORAGE OUTSIDE THE APP ROOT — uploads land under os.tmpdir()/express_guide_uploads/<session>/, never beside source or static assets. The rule this encodes: an uploads directory is DATA, and data directories are never executable, never served by a static middleware with their original names, and never inside anything a deploy step copies. Serving user uploads is its own decision — this app serves them only through controller routes that set explicit Content-Type and ride the app's nosniff header; a production system puts them in object storage behind a CDN domain of their own (a separate origin kills the stored-XSS blast radius: an uploaded "HTML file" executed on static.example.com cannot read cookies for example.com). (5) THE HONEST GAPS, named like the security topic names them: VIRUS SCANNING is real infrastructure (ClamAV behind a queue, scan-before-serve) and out of scope for a teaching app — the code below notes where it would slot in; and per-USER quotas (count + total bytes) are the resource-exhaustion answer this demo approximates with its 50-file store cap.`,
        },
        {
          kind: 'code',
          id: 'files-receiving-safety:verbatim-multer',
          language: 'ts',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          caption: 'Verbatim — the multer config this app mounts (routes/files_demo_routes.ts)',
          code: `const upload = multer({
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
          \`"\${file.mimetype}" is not an allowed upload type\`,
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

// Multer errors are NOT AppExceptions — unwrapped they fall through to the
// 500 path. The guard maps LIMIT_FILE_SIZE & friends onto the canonical 400
// envelope with the multer code as \`reason\`; fileFilter's ValidationException
// already IS one and flows through unchanged:
function uploadGuard(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (err === undefined) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        next(
          new ValidationException(MULTER_REASON[err.code] ?? \`upload rejected (\${err.code})\`, {
            reason: err.code,
            fileSizeLimitBytes: MAX_FILE_SIZE_BYTES,
            filesLimit: MAX_FILES_PER_REQUEST,
          }),
        );
        return;
      }
      next(err);
    });
  };
}`,
        },
        {
          kind: 'text',
          id: 'files-receiving-safety:multipart-quirks',
          body: `THE INTEGRATION QUIRKS you will hit on day one, all proven by this app's specs. MOUNT MULPER ON THE ROUTE, not the app: it is a parser like express.json — app-global multipart parsing means every route pays it and text-field limits apply everywhere; the upload route mounts uploadGuard(upload.array('file', 3)) and nothing else knows multipart exists. THE FIELD NAME IS PART OF THE CONTRACT — upload.single('file')/array('file') expect parts under exactly that name; a client sending file_contents gets LIMIT_UNEXPECTED_FILE (mapped to a 400 here, raw 500 in unwrapped apps — the most common "multer broke my API" post on the internet). NO JSON BODY PARSER INVOLVEMENT: multipart content types are none of express.json's business, so the root parser skips these requests and multer IS the body parser — which also means the request-id/helmet ordering rules are unaffected. EMPTY UPLOADS: a multipart request with only text fields reaches the controller with req.files as an empty array — this route answers a 400 naming the expected field, because "successfully stored nothing" is not a 201. THE SANITIZATION PAIR, one more time because it is the actual security boundary: originalName is sanitized into DISPLAY metadata (never touches the filesystem), storedName is generated from nothing the client said (never displayed). The download endpoint re-runs the sanitizer when composing the Content-Disposition filename — defense in depth, same function, because the metadata store is not trusted either the day a second write path appears.`,
        },
      ],
    },
    {
      id: 'files-downloads',
      title: 'Downloads and Content-Disposition',
      lead:
        'Serving a file back is one header decision: attachment (save to disk) or inline (render here). res.download and res.sendFile are the two Express spellings of that choice.',
      blocks: [
        {
          kind: 'text',
          id: 'files-downloads:disposition',
          body: `THE HEADER THAT DECIDES: Content-Disposition tells the browser what to DO with the body — inline (render it: image in an <img>, PDF in the viewer) or attachment; filename="report.pdf" (SAVE AS this name, and for inline, the name used if the user saves anyway). It is astonishing how much behavior rides on one header: serving a user-uploaded HTML file inline from your own origin is STORED XSS (the browser executes it in your origin — CSP limits it, but the intent is already wrong); serving the same bytes as attachment makes the browser treat it as a download, no origin, no execution. This app's split is deliberate: /raw serves INLINE with an explicit Content-Type for images the workbench renders in <img> tags, /download serves ATTACHMENT for the save-to-disk path. RES.DOWNLOAD VS RES.SENDFILE — the same streaming machinery (send, Range support, ETag, content-type from extension) with one difference: res.download(path, filename?) sets Content-Disposition: attachment (with the filename you pass, defaulting to the file's basename), res.sendFile(path) sets none (you choose inline or nothing via headers). Two real-world sharp edges, both handled in the code below: (1) the FILENAME comes from metadata the client once controlled — this app passes sanitizeDisplayName(meta.originalName) again, because a newline or quote inside a Content-Disposition value is a header-injection primitive, and the stored name's extension belongs to the server's MIME map anyway; (2) NON-ASCII FILENAMES — a download named rapport-2026-最终.pdf cannot ride the bare filename="..." parameter (historically Latin-1). The RFC 5987 answer is the filename* parameter with percent-encoded UTF-8: filename="rapport-2026-.pdf"; filename*=UTF-8''rapport-2026-%E6%9C%80%E7%BB%88.pdf — and Express does this FOR YOU: res.download composes the header through the content-disposition package, emitting both parameters when the name needs it. Verify with curl -D - and read the header; the spec pins the ASCII case exactly (attachment; filename="notes.txt"). THE STREAMING PART you get for free but should understand: sendFile stats the file, sets Content-Length, streams it in chunks (never whole-file-in-RAM), handles ETag/If-None-Match (304s for cache revalidation — the caching topic's asset endpoint does this by hand), and — the next section's whole subject — forwards Range headers to give you a 206. One production footnote: sendFile's content-type comes from the file EXTENSION; this app sets Content-Type explicitly from validated metadata first, because the extension on disk and the truth in the database should never disagree — and nosniff (helmet, app-wide) makes the browser respect that claim instead of sniffing the bytes.`,
        },
        {
          kind: 'code',
          id: 'files-downloads:verbatim-download',
          language: 'ts',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          caption: 'Verbatim — the two serving modes (routes/files_demo_routes.ts)',
          code: `// ATTACHMENT — res.download = sendFile + Content-Disposition: attachment,
// with Express handling the RFC 5987 filename* encoding for non-ASCII names.
// The filename is re-sanitized: a newline or quote inside this header is a
// header-injection primitive, and the metadata store is not trusted either.
async function downloadController(req: Request, res: Response): Promise<void> {
  const meta = requireStoredFile(String(req.params.id));
  await res.download(fileStore.absolutePath(meta), sanitizeDisplayName(meta.originalName));
}

// INLINE — same file, same streaming, but the browser RENDERS it (the
// workbench's <img> tags point here). Content-Type from validated metadata,
// not from the on-disk extension.
function rawController(req: Request, res: Response): void {
  const meta = requireStoredFile(String(req.params.id));
  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(fileStore.absolutePath(meta));
}`,
        },
      ],
    },
    {
      id: 'files-ranges',
      title: 'Range requests — video seeking and resumable downloads',
      lead:
        'A quarter of a video watched is a quarter downloaded — Range is the header that makes partial HTTP possible. The spec behavior first, then the hand-rolled parser this app actually serves.',
      blocks: [
        {
          kind: 'text',
          id: 'files-ranges:spec',
          body: `THE PROBLEM RANGES SOLVE: a 2GB video and a browser that wants byte 1,500,000,000 (the user dragged the seek bar). Without ranges the only correct move is downloading 1.5GB to throw it away; with ranges the client sends Range: bytes=1499999999- and the server answers JUST THE REST. Same mechanism, different costumes: video SEEKING, resumable downloads (the connection died at 60MB — reconnect with bytes=62914560- and continue), parallel chunked downloading (several connections each taking a slice), and HTTP-203-style patching of large objects. THE HEADER GRAMMAR, exact because the parser must be: Range: bytes=START-END (closed — both offsets inclusive, END clamped to size-1 if beyond), bytes=START- (open — START to the end), bytes=-SUFFIX (the last SUFFIX bytes — the resumable-download spelling), and the multi-range bytes=0-99,200-299 (several slices in one request — more below). THE RESPONSE CONTRACT, three shapes that are NOT interchangeable: a satisfiable range gets 206 Partial Content + Content-Range: bytes START-END/TOTAL (the slice it serves AND the whole size — how a resuming client verifies its offset) + Content-Length equal to the SLICE and a body containing exactly those bytes; a VALID-but-out-of-bounds range (bytes=999999999- on a 5MB file) gets 416 Range Not Satisfiable + Content-Range: bytes */TOTAL (the star says "impossible", the TOTAL tells the client the real size — often a stale-cache situation, the client should re-fetch); and an INVALID or unsupported range is simply IGNORED — full 200, whole body. That third shape is the one everybody gets wrong: RFC 9110 says a recipient MUST ignore a syntactically invalid byte-range-spec (bytes=abc, bytes=9-5 inverted) and MAY disregard anything it does not want to serve. Being lenient is not a courtesy — proxies, flaky encoders, and hand-written clients all emit garbage ranges, and the spec's answer is to serve the full representation, not to 400. SUPPORT IS ADVERTISED: Accept-Ranges: bytes on responses tells clients ranges work at all (needed before the first Range is risked); and If-Range — the conditional companion — lets a client say "give me the range ONLY IF the resource is still the version I have (this ETag/date); otherwise the whole thing" so a resumed download never stitches bytes from two different versions of a file. MULTI-RANGE in one paragraph, as promised: bytes=0-99,500-599 technically asks for two slices, and the spec's answer is MULTIPART/BYTERANGES — a multipart response whose parts are the requested slices each with its own Content-Range. Almost nobody implements it by hand: CDNs and file servers do it at the edge, applications either serve the FIRST range, the FULL body, or ignore the header. This app deliberately ignores multi-ranges (serving 200 full, verdict header saying so) because multipart/byteranges is complexity with no teaching payoff — and its spec case pins that behavior so the leniency is a contract, not an accident. WHICH LEAVES the hand-rolled parser below — no library, because Express's sendFile/Range interplay is exactly the kind of magic you should have read once in your life: the parser turns a header + a size into one of four verdicts (none / ignored / satisfiable / unsatisfiable), and the responder maps each verdict onto its status, headers, and fs.createReadStream({ start, end }) slice. This is the code the /stream endpoint runs for every request.`,
        },
        {
          kind: 'code',
          id: 'files-ranges:verbatim-parser',
          language: 'ts',
          source: 'server/src/core/http/range_header.ts',
          caption: 'Verbatim — the parser (core/http/range_header.ts, unit-tested against the whole matrix)',
          code: `export function parseRangeHeader(raw: string | undefined, size: number): ParsedRange {
  if (raw === undefined || raw.trim() === '') return { kind: 'none' };

  const header = /^([A-Za-z]+)\\s*=\\s*(.*)$/.exec(raw.trim());
  if (header === null) return { kind: 'ignored', reason: 'malformed header (no unit=value shape)' };
  const [, unit, spec] = header;
  if (unit.toLowerCase() !== 'bytes') {
    return { kind: 'ignored', reason: \`range unit "\${unit}" is not "bytes" - only byte ranges apply\` };
  }
  if (size === 0) return { kind: 'unsatisfiable' };
  if (spec.includes(',')) {
    return {
      kind: 'ignored',
      reason: 'multi-range request - this server answers the full body instead of multipart/byteranges',
    };
  }

  const range = /^(\\d*)-(\\d*)$/.exec(spec);
  if (range === null) return { kind: 'ignored', reason: 'malformed range syntax' };
  const [, startText, endText] = range;
  if (startText === '' && endText === '') {
    return { kind: 'ignored', reason: 'empty on both sides of the dash' };
  }

  if (startText === '') {
    // Suffix form — bytes=-N means THE LAST N BYTES (the resumable-download shape).
    const suffix = Number(endText);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'satisfiable', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  if (start >= size) return { kind: 'unsatisfiable' };
  if (endText === '') {
    // Open-ended — bytes=N- runs from N to the end (the video-seek shape).
    return { kind: 'satisfiable', start, end: size - 1 };
  }

  const end = Number(endText);
  if (end < start) return { kind: 'ignored', reason: 'inverted range (last byte before first byte)' };
  // A first-byte-pos INSIDE the file with an end beyond it is valid and CLAMPED.
  return { kind: 'satisfiable', start, end: Math.min(end, size - 1) };
}`,
        },
        {
          kind: 'code',
          id: 'files-ranges:verbatim-responder',
          language: 'ts',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          caption: 'Verbatim — verdict to wire: the 206/416/200 responder slice',
          code: `const raw = req.headers.range;
const parsed = parseRangeHeader(raw, size);
res.setHeader('Accept-Ranges', 'bytes');

if (parsed.kind === 'none' || parsed.kind === 'ignored') {
  // No Range (or one we disregard per spec) → the full representation, 200.
  res.status(200);
  res.setHeader('Content-Length', String(size));
  if (parsed.kind === 'ignored') {
    res.setHeader('X-Range-Verdict', \`ignored: \${parsed.reason}\`);
  }
  streamFileToResponse(res, absolutePath, requestId); // a read failure destroys the socket, never the process
  return;
}

if (parsed.kind === 'unsatisfiable') {
  // Valid syntax, outside the file → 416 + the */size pointer. Hand-rolled
  // envelope: the app's failure taxonomy has no 416 kind, so this response
  // matches the canonical shape deliberately.
  res.status(416);
  res.setHeader('Content-Range', \`bytes */\${size}\`);
  res.json({
    error: {
      code: 'range_not_satisfiable',
      message: \`Range "\${raw}" cannot be satisfied — the file is \${size} bytes\`,
      requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : 'n/a',
      fileSizeBytes: size,
    },
  });
  return;
}

// Satisfiable → 206 + Content-Range + EXACTLY the requested slice:
const { start, end } = parsed;
res.status(206);
res.setHeader('Content-Range', \`bytes \${start}-\${end}/\${size}\`);
res.setHeader('Content-Length', String(end - start + 1));
streamFileToResponse(res, absolutePath, requestId, { start, end });`,
        },
        {
          kind: 'text',
          id: 'files-ranges:edge-matrix',
          body: `THE EDGE MATRIX, because a range parser is exactly the kind of code where an off-by-one hides (every row below is a pinned spec case in this repo). bytes=0-9 on a 100-byte file → 206, Content-Range bytes 0-9/100, exactly 10 bytes (BOTH offsets inclusive — END is not exclusive, the single most common mistake). bytes=5- → 5-99, 95 bytes. bytes=-10 → 90-99 — and bytes=-200 → 0-99, the WHOLE file: a suffix longer than the file is satisfiable and covers everything (a resuming client that asks for more than remains gets the remainder, not an error). bytes=0-999999 on the same file → 206 with 0-99: an END beyond the file CLAMPS to size-1, it does not 416 — 416 is reserved for a START at or beyond the end. bytes=100- and bytes=-0 on a 100-byte file → both 416 (start == size is already past the end; a zero-length suffix is defined unsatisfiable). bytes=9-5 → ignored, 200 full — an inverted range is INVALID syntax, and the spec's must-ignore clause applies. items=0-9 → ignored, 200 — the unit must be bytes (case-insensitively: BYTES=0-9 parses). bytes=0-9,20-29 → ignored, 200 full, per this app's no-multipart stance. And the subtle one implementers forget: a ZERO-BYTE file makes every byte range unsatisfiable by definition — there is no byte 0 to serve. The suite drives all of these through the real endpoint AND the pure function, which is the testing pattern worth copying: the parser is a pure (header, size) → verdict function, so the matrix costs microseconds at the unit level, and a handful of HTTP-level cases prove the responder wires the verdicts to the right statuses and headers.`,
        },
      ],
    },
    {
      id: 'files-backpressure',
      title: 'Streaming with backpressure — for real this time',
      lead:
        'The pattern the Node.js and Request/Response topics explicitly deferred: what happens when your producer outruns the socket, and the two lines of code that keep it from eating your memory.',
      blocks: [
        {
          kind: 'text',
          id: 'files-backpressure:mechanism',
          body: `THE DEFERRED PROMISE, collected: the Node.js topic streamed ~100KB of telemetry and the Request/Response topic sent ndjson with setImmediate pauses — both demos ended with a note saying real backpressure handling belongs here, because at those sizes the socket's buffer NEVER fills and write() NEVER returns false. So: WHAT BACKPRESSURE IS. Every writable stream (an HTTP response included) has an internal buffer with a HIGH-WATER MARK (16KB by default for http). res.write(chunk) does not "send" anything — it queues the chunk for the socket and returns TRUE while the buffer is under the mark, FALSE when it is full. If you ignore the false and keep writing, the buffer grows without bound: your producer (a file read, a database cursor, a loop) is generating bytes faster than the client across the network is consuming them, and YOUR process holds the difference in memory. A 10GB file streamed to a phone on 3G via a naive write() loop is a 10GB Node process — this is not a theoretical concern; it is the single most common way naive streaming code takes down a server, and it is why the API looks the way it does: the boolean is the socket ASKING you to stop. THE PATTERN, exactly two moves: (1) CHECK the return of every write; (2) when it is false, STOP producing and RESUME on the stream's 'drain' event — fired when the buffer empties back below the mark. The await-drain spelling in an async loop is the modern idiom (the code below); the pre-async spelling registers a one-time listener and continues in its callback. What this buys is not just memory: the PAUSE propagates. While you wait for drain you are not reading the file, so the disk is not feeding a full pipe, so the OS socket buffer back-pressures the network, so TCP windows shrink and the SLOW CLIENT's pace actually throttles the whole pipeline — the system self-regulates end to end instead of buffering the difference at the weakest point (you). THE SHORTHANDS, when you don't need the loop: source.pipe(res) honors backpressure internally (pause the source on false, resume on drain — this is literally what pipe does, plus error plumbing you must handle yourself), and stream.pipeline(source, res) is pipe WITH error handling and cleanup — the production default when the body is a straight-through transform of one readable. The hand-rolled loop earns its keep the moment there is logic between reads: generating telemetry lines, batched database reads, per-chunk accounting — anything where you are the producer. THE DEMO, honestly designed: GET /api/demo/files/pipeline-demo?chunks=200 generates ~2KB ndjson lines and writes them through the real pattern; the LAST line of the stream is a summary reporting how many times write() returned false (drainEvents) and how long the producer waited (pausedMs). With a fast local client — supertest, or your browser on localhost — the socket drains as fast as you fill it and drainEvents is honestly 0; open a slow consumer against a big chunk count (curl piping through a rate limiter, or just a large ?chunks over a real network) and the pauses appear in the report. Because the endpoint refuses to fake it, the PATTERN's proof lives where it belongs, in a unit test: a fake sink whose write() returns false once and emits 'drain' fifteen milliseconds later, with the test asserting the next write happens AFTER the drain fires — the ordering IS the pattern. One last edge the code handles that most hand-rolls miss: an ABORTED client. If the socket closes mid-stream, 'drain' may never fire, and a bare await-drain would hang the handler forever — one promise, two exits ('drain' or 'close'), first one wins.`,
        },
        {
          kind: 'code',
          id: 'files-backpressure:verbatim-pattern',
          language: 'ts',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          caption: 'Verbatim — the pattern, whole (routes/files_demo_routes.ts)',
          code: `/**
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
}`,
        },
        {
          kind: 'code',
          id: 'files-backpressure:verbatim-endpoint',
          language: 'ts',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          caption: 'Verbatim — the endpoint that reports honestly (drainEvents may be a truthful 0)',
          code: `async function pipelineDemoController(req: Request, res: Response): Promise<void> {
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
    \`\${JSON.stringify({ summary: true, chunks, drainEvents, pausedMs })}\\n\`,
  );
  res.end();
}`,
        },
      ],
    },
    {
      id: 'files-images',
      title: 'Images with sharp — processing at the edge',
      lead:
        'Uploaded images are raw material: resize them, re-encode them, strip their metadata. sharp is libvips with a Node face — streams in, streams out, megapixels per millisecond.',
      blocks: [
        {
          kind: 'text',
          id: 'files-images:pipeline',
          body: `WHY PROCESS ON UPLOAD, not on request: every variant you can generate AT INGEST is a variant you never generate per-request — the thumbnail exists once instead of being re-rendered by every list view, the oversized 12-megapixel phone photo becomes a web-sized image before it ever touches a disk you pay for, and the bytes you serve are the bytes you validated. The upload pipeline in this app: after multer lands the file and the metadata is registered, images run through sharp twice — a RE-ENCODE of the original in its own format (jpeg at quality 90, webp at 80, png as-is) whose real job is EXIF STRIPPING, and a 128px-wide WEBP THUMBNAIL derived from those already-clean bytes. sharp's DEFAULT is to drop all metadata (EXIF, IPTC, XMP, ICC) unless you call .withMetadata() — a deliberate inversion that makes the privacy-safe path the lazy path. WHAT EXIF CARRIES, and why stripping is a privacy feature and not just byte-shaving: GPS coordinates (every photo a phone takes is geotagged — a public photo album with intact EXIF is a map of where your users live), device serial numbers, capture timestamps, and occasionally thumbnail images embedded from edits the user believed they had cropped away. The journalism phrase for what leaked through embedded thumbnails and metadata is real; re-encoding on upload closes the whole class. THE API SHAPE, streams all the way down: sharp(input) accepts a file PATH, a Buffer, or a Readable (stream-to-stream — no temp files: createReadStream(in).pipe through sharp into createWriteStream(out) via stream.pipeline, the shape you want for files too big to buffer), then chains format-specific encoders — .jpeg({ quality }), .png({ compressionLevel }), .webp({ quality }), .avif — and output methods .toBuffer() (small files, when you want bytes in hand) or .toFile(path) (returns { size, width, height } — the metadata for free) or .pipe() (the streaming spelling). RESIZE deserves its specifics: .resize({ width: 128 }) scales to a 128px WIDE image preserving aspect (the 1×1 test PNG becomes 128×1 — the specs assert the width); withoutEnlargement: true refuses to upscale small inputs; fit: 'cover' | 'contain' | 'inside' picks the crop behavior when you set both dimensions; position controls the crop anchor. FORMAT CHOICES, the current honest table: WEBP at quality 80 is the workhorse variant format (30-50% smaller than jpeg at similar quality, universally supported in 2026 — this app's thumbnails); AVIF beats it by another ~20% with slower encoding (fine for ingest-time work, painful per-request) — a production server negotiates via Accept and serves avif → webp → jpeg fallbacks, or just lets the CDN transcode; JPEG remains the camera-input format you re-encode FROM; PNG for lossless/alpha, WebP/AVIF also do alpha and mostly win. THE FAILURE MODE every sharp integration must handle: DECODING CAN FAIL — the fileFilter validated the DECLARED mime, not the bytes, so a text file wearing image/png arrives and sharp throws (VipsError: Input file has corrupt data). This app catches it at ingest and DEMOTES the record: the bytes are kept as an opaque kind 'file' with an honest note ("not a decodable image") and no thumbnail — the upload still succeeded, the lie is documented, no 500. The alternative — trusting the filter — means one renamed text file produces a stack trace in production. Bigger-file footnote: at this app's 5MB cap, buffers in memory are fine; a video-transcoding sibling of this pipeline would go stream-to-stream with pipeline() and report progress via events — same library discipline, different output methods.`,
        },
        {
          kind: 'code',
          id: 'files-images:verbatim-ingest',
          language: 'ts',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          caption: 'Verbatim — the ingest pipeline: re-encode, thumbnail, honest demotion (files_demo_routes.ts)',
          code: `async function ingestUploadedFile(file: Express.Multer.File): Promise<StoredFileMetadata> {
  const declaredImage = (IMAGE_MIME_TYPES as readonly string[]).includes(file.mimetype);
  const id = fileStore.nextId();
  // The COMPLETE record is built first and registered ONCE at the end —
  // the store hands out defensive copies, never live records to mutate.
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

    const thumbName = \`\${id}.thumb.webp\`; // server-generated variant name
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
      note: \`declared \${file.mimetype}, but the bytes are not a decodable image — stored as an opaque file with no variants\`,
    });
  }
}

// Stream-to-stream, the shape for inputs too big to buffer — same library:
//   await pipeline(
//     createReadStream(inputPath),
//     sharp().resize({ width: THUMB_WIDTH }).webp({ quality: 80 }),
//     createWriteStream(thumbPath),
//   );`,
        },
      ],
    },
    {
      id: 'files-path-traversal',
      title: 'Path traversal and safe paths',
      lead:
        'The Security topic deferred its live traversal demo here. This is the anatomy of ../, the resolve-then-contain guard this app runs on every access, and the endpoint that lets you attack it yourself.',
      blocks: [
        {
          kind: 'text',
          id: 'files-path-traversal:anatomy',
          body: `THE ATTACK IN ONE LINE: user input becomes part of a filesystem path, and ../ means "parent directory" to the filesystem regardless of what it meant to you. The classic: an avatar endpoint GET /avatars?name=../.env reads the environment file because path.join(uploadsDir, name) CONCATENATES — join('/app/uploads', '../.env') → '/app/uploads/../.env' → the OS resolves it to '/app/.env'. The developer's mental model was "a filename"; the input's actual meaning was "a relative path"; the .. walked straight out of the intended directory. THREE DEGREES OF THE SAME BUG: plain traversal (../../../etc/passwd on unix, ..\\..\\windows\\ on windows — separators are platform-specific and attackers send both); URL-DECODED traversal — the guide's own guard endpoint proves this one: the query string arrives percent-encoded (..%2F..%2Fetc%2Fpasswd) and BY THE TIME YOUR CODE SEES IT, the framework has already decoded it — req.query.input IS ../../etc/passwd, the same attack in a party dress, and the guard must judge the DECODED value (the flip side bites frameworks that decode twice: input encoded ..%252F.. decodes to ..%2F.. at the query layer, looks contained, then a downstream component decodes again and traverses — the fix is to canonicalize ONCE, at the boundary, and reject encoded spellings that still contain %2e/%2f after your one decode); and the NULL-BYTE history — older C-based string APIs treated \\0 as end-of-string, so "evil\\u0000.png" passed extension checks as evil\\u0000.png while the filesystem opened "evil" (Node's fs has rejected null bytes since 2016, but the guard still refuses them at the door because a defense named after a dead variant is how variants get in). THE GUARD, whole thing: resolve-then-contain. path.resolve(root, candidate) canonicalizes ABSOLUTELY — it collapses ../, resolves symlinks' logical paths, and returns a final absolute path with no remaining .. segments. THEN you assert the result still starts with the resolved ROOT (root itself plus a separator — the separator matters: /app/uploads-evil startsWith /app/uploads is TRUE without it, the prefix bug). Contained → proceed; not contained → refuse BEFORE any filesystem call. This app's safeJoin is that guard, and the discipline that makes it security rather than code: it is not A helper for file routes, it is THE ONLY path from an id or name to a disk location — every read, write, stat, and unlink in the store goes through it (grep the store: absolutePath, variantPath, writeVariant all call safeJoin; the routes never call path.join on anything user-shaped at all). THE STRONGER DEFENSE THIS APP ACTUALLY LEANS ON, say it plainly: DON'T BUILD PATHS FROM USER INPUT AT ALL. The workbench's URLs carry opaque server ids (files-1a2b…), and the STORE maps ids to server-generated stored names — there is no client-controlled path segment to sanitize because there is no client-controlled path. The guard exists as the layer beneath that policy, because policies rot: the day someone adds a "serve by original name" endpoint, safeJoin is what stands between ../ and /etc/passwd. Defense in depth is not two locks on one door — it is the second lock that works when the first was never installed. THE ENDPOINT, live and read-only: GET /api/demo/files/path-guard?input=../../etc/passwd runs the REAL guard and answers with the verdict — the input as received (already URL-decoded), the upload root, the resolved path, contained: false, verdict: 'rejected' — and it NEVER reads the file either way: a guard you can attack all day costs nothing to let you attack. Swap in reports/2026/q3.csv and watch resolution stay inside the root.`,
        },
        {
          kind: 'code',
          id: 'files-path-traversal:verbatim-guard',
          language: 'ts',
          source: 'server/src/data/files/file_store.ts',
          caption: 'Verbatim — the containment guard (data/files/file_store.ts), used for EVERY file access in this topic',
          code: `/**
 * THE containment guard, used for EVERY file access in this topic:
 * resolve the candidate against the root, then assert the result is still
 * INSIDE the root. path.join alone does not contain — join(root, '../..')
 * happily walks out. Null bytes are rejected outright (the historical
 * truncation attack: "evil\\u0000.png" → "evil" at the C layer).
 */
export function safeJoin(root: string, candidate: string): SafeJoinResult {
  if (candidate.includes('\\0')) return { ok: false, reason: 'null byte' };
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const contained = resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  return contained ? { ok: true, path: resolved } : { ok: false, reason: 'escapes the upload root' };
}`,
        },
        {
          kind: 'code',
          id: 'files-path-traversal:verbatim-endpoint',
          language: 'ts',
          source: 'server/src/presentation/routes/files_demo_routes.ts',
          caption: 'Verbatim — the live verdict endpoint (files_demo_routes.ts): the REAL guard, and it never reads anything',
          code: `function pathGuardController(req: Request, res: Response): void {
  const raw = req.query.input;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationException('"input" query parameter is required (the path candidate to judge)', {
      parameter: 'input',
      // …example: 'reports/2026/q3.csv', attackExample: '../../etc/passwd'…
    });
  }

  const resolvedRoot = path.resolve(fileStore.rootDir);
  const verdict = safeJoin(fileStore.rootDir, raw);
  const contained = verdict.ok;

  res.json({
    input: raw,                                    // as DECODED — what your code sees
    uploadRoot: resolvedRoot,
    resolved: path.resolve(resolvedRoot, raw),
    contained,
    verdict: contained ? 'allowed' : 'rejected',
    ...(contained ? {} : { reason: verdict.reason }),
    readsNothing: true,
  });
}`,
        },
      ],
    },
    {
      id: 'files-live',
      title: 'See it live (the workbench)',
      lead:
        'Five panels over the real endpoints: an upload with the full validation stack, the file library with sharp thumbnails, a range tester against the hand-rolled responder, the backpressure report, and the path guard you can attack.',
      blocks: [
        {
          kind: 'text',
          id: 'files-live:intro',
          body: `THE WORKBENCH'S FIVE PANELS. UPLOAD: a file input (the allowlist as its accept attribute) sends multipart via fetch + FormData straight at the real multer stack — a small PNG or a text file lands as a card in the library; a >5MB file comes back as the 400 envelope naming LIMIT_FILE_SIZE (the bait: try it — the button is yours); a .exe comes back mime_not_allowed; and a text file RENAMED .png sails past the filter and comes back with the honest demotion note, because the filter sees declarations, not bytes (fetch cannot report UPLOAD progress — it has no progress event for request bodies — the panel says so and points at XHR or the newer streams, the standard workaround). LIBRARY: every stored file as a card — the sharp webp thumbnail in a real <img>, the sanitized display name, size, kind — with open-raw (inline) and download (attachment) links, so the Content-Disposition split from the downloads section is one click apart. RANGE TESTER: pick a stored file and fire canned Range headers at /stream — bytes=0-99 (a 206 with Content-Range and exactly 100 received bytes), last 50 (the suffix form), and an unsatisfiable offset (the 416 with its bytes */size pointer) — each verdict rendered as status + Content-Range + RECEIVED-BYTES-VS-FULL-SIZE, so partial content stops being a diagram and becomes arithmetic. BACKPRESSURE: runs the pipeline endpoint and renders its honest report — chunks written, drainEvents, pausedMs — with the reminder that a fast local client honestly reports zero pauses and the unit-tested fake sink is where the pattern is proven. PATH GUARD: the input is prefilled with ../../etc/passwd (URL-encoded on the wire, decoded by the framework — the panel shows both); press check and the guard answers rejected with the resolved path that escaped; swap in a safe name and it answers allowed with the path that stayed home — and the endpoint never reads a byte either way. The curl block below drives the same surface from a terminal, including the boundary-level view of a multipart body and a range loop worth watching.`,
        },
        {
          kind: 'demo',
          id: 'files-live:workbench-demo',
          demoId: 'files:workbench',
          title: 'The files workbench: upload, library, ranges, backpressure, the path guard',
          description:
            'Real uploads through the multer validation stack (MIME allowlist, 5MB cap, generated names) with sharp thumbnails on the cards; a range tester firing bytes=0-99 / suffix / unsatisfiable headers at the hand-rolled 206/416 responder; the honest drainEvents report from the backpressure pipeline; and the live containment guard rejecting ../ in plain and URL-decoded spellings without ever reading a file.',
        },
        {
          kind: 'code',
          id: 'files-live:curl',
          language: 'bash',
          caption: 'The workbench from a terminal — upload, ranges, backpressure, the guard',
          code: `# 1. Upload a real file (multipart — note the boundary in the verbose output):
curl -s -F "file=@some-photo.jpg" localhost:4000/api/demo/files/upload | jq '{id: .file.id, kind: .file.kind, thumb: .file.variants.thumb.size}'
# …and watch the request body's actual shape if you want to see boundaries:
curl -v -F "file=@notes.txt" localhost:4000/api/demo/files/upload 2>&1 | grep -A2 'Content-Disposition: form-data'

# 2. Bait the validation stack — each answer is the canonical 400 envelope:
head -c 6000000 /dev/zero > big.png
curl -s -F "file=@big.png;type=image/png" localhost:4000/api/demo/files/upload | jq '.error | {code, reason, fileSizeLimitBytes}'
curl -s -F "file=@tool.exe;type=application/x-msdownload" localhost:4000/api/demo/files/upload | jq '.error | {code, reason}'
printf 'just text lying about its type' > imposter.png
curl -s -F "file=@imposter.png;type=image/png" localhost:4000/api/demo/files/upload | jq '{kind: .file.kind, note: .file.note}'

# 3. Range requests against the streamer (use an id from step 1/2):
ID=files-xxxxxxxxxxxxxxxxxxxxxx
curl -s -o /dev/null -w 'no range   → %{http_code} bytes=%{size_download}\\n' localhost:4000/api/demo/files/$ID/stream
curl -s -D - -o /dev/null -H 'Range: bytes=0-99' localhost:4000/api/demo/files/$ID/stream | grep -Ei 'HTTP/|content-range|content-length'
curl -s -D - -o /dev/null -H 'Range: bytes=-50' localhost:4000/api/demo/files/$ID/stream | grep -Ei 'HTTP/|content-range'
curl -s -H 'Range: bytes=999999-' localhost:4000/api/demo/files/$ID/stream | jq '.error | {code, fileSizeBytes}'
curl -s -D - -o /dev/null -H 'Range: bytes=zzz' localhost:4000/api/demo/files/$ID/stream | grep -Ei 'HTTP/|x-range-verdict'

# 4. Backpressure report — the last ndjson line is the honest summary
#    (drainEvents > 0 needs a client slower than the producer):
curl -s 'localhost:4000/api/demo/files/pipeline-demo?chunks=50' | tail -1 | jq

# 5. Attack the path guard — decoded ../ and its percent-encoded twin, both rejected:
curl -s 'localhost:4000/api/demo/files/path-guard?input=..%2F..%2Fetc%2Fpasswd' | jq '{input, contained, verdict}'
curl -s 'localhost:4000/api/demo/files/path-guard?input=reports/2026/q3.csv' | jq '{input, contained, verdict, resolved}'

# 6. The library, the thumbnail, and the two dispositions:
curl -s localhost:4000/api/demo/files | jq '.files[] | {id, originalName, kind}'
curl -s -o /dev/null -w '%{content_type} %{size_download} bytes\\n' localhost:4000/api/demo/files/$ID/thumb
curl -sD - -o /dev/null localhost:4000/api/demo/files/$ID/download | grep -i content-disposition`,
        },
      ],
    },
  ],
};
