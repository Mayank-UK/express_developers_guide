import { Router, type Request, type Response } from 'express';
import { ValidationException } from '../../core/error_handling/exceptions.js';

/**
 * Request/response demo endpoints (the `request-response` topic's live
 * experiments):
 * - ALL /api/demo/reqres/inspect — accepts EVERY method and reports exactly
 *   what the server received: the request line, the parsed query, the
 *   lowercased header map (with the correlation id merged in the way a
 *   reverse proxy would forward it), and the body BOTH ways — `body` when a
 *   parser claimed the stream, `bodyRaw` (length-capped) read straight from
 *   the request stream when no parser matched the content-type. POSTing
 *   different content types shows the parser effect live.
 * - PUT /api/demo/reqres/echo-custom-headers — echoes back ONLY the request
 *   headers whose names start with "x-", proving custom headers travel.
 * - GET /api/demo/reqres/respond?mode=… — the response-methods playground:
 *   one real response family per mode (json / text / status / redirect /
 *   cookie / stream / download), each asserting its own contract in the
 *   spec sibling.
 * - GET /api/demo/reqres/redirect-target — the small JSON body the 307 from
 *   ?mode=redirect lands on, so the demo (or curl -L) can show the arrival.
 */

/** Where the whole demo sub-app answers — every demo URL starts with this. */
export const REQRES_DEMO_MOUNT_PATH = '/api/demo/reqres';

/** How many raw body characters the inspector will report back, at most. */
const BODY_RAW_CAP = 2048;

/** The response families the playground can produce. */
const RESPOND_MODES = [
  'json',
  'text',
  'status',
  'redirect',
  'cookie',
  'stream',
  'download',
] as const;
type RespondMode = (typeof RESPOND_MODES)[number];

/**
 * The status codes the playground may answer with — the working set from the
 * status-codes section, all safe to actually send from a teaching endpoint.
 * 204 is in the list precisely because it must carry NO body.
 */
const SAFE_STATUSES = [200, 201, 204, 400, 401, 403, 404, 409, 418, 500, 503] as const;

/** The ndjson line count the stream mode writes, one write per line. */
const STREAM_LINE_COUNT = 5;

const REDIRECT_TARGET = `${REQRES_DEMO_MOUNT_PATH}/redirect-target`;

// --- input parsing (validation lives at the boundary, never in handlers) ------

function parseRespondMode(raw: unknown): RespondMode {
  if (typeof raw === 'string' && (RESPOND_MODES as readonly string[]).includes(raw)) {
    return raw as RespondMode;
  }
  throw new ValidationException('"mode" query parameter must name one of the response families', {
    parameter: 'mode',
    validValues: [...RESPOND_MODES],
  });
}

function parseChosenStatus(raw: unknown): number {
  if (raw === undefined || raw === '') return 409; // the demo's default conflict
  if (typeof raw === 'string' && (SAFE_STATUSES as readonly number[]).includes(Number(raw))) {
    return Number(raw);
  }
  throw new ValidationException(
    '"status" query parameter must be one of the safe demo statuses',
    { parameter: 'status', defaultValue: 409, validValues: [...SAFE_STATUSES] },
  );
}

// --- controllers (thin: read the view / write one response family) ------------

/**
 * The request inspector. Reading the raw stream is async, so the handler is
 * async too — Express 5 forwards any rejection into the error pipeline.
 */
async function inspectController(req: Request, res: Response): Promise<void> {
  const requestId =
    typeof res.locals.requestId === 'string' && res.locals.requestId !== ''
      ? res.locals.requestId
      : 'n/a';

  // Node already lowercases request header names; sort for a stable read (the
  // same convention as the http topic's inspect endpoint).
  const headers: Record<string, string | string[]> = {};
  for (const name of Object.keys(req.headers).sort()) {
    const value = req.headers[name];
    headers[name] = value === undefined ? '' : value;
  }
  // The correlation id lives on the RESPONSE so far (request-id middleware);
  // record it the way a forwarding proxy would hand it back — as a request
  // header — so the x- highlight row always exists in the reflected view.
  headers['x-request-id'] = requestId;

  let body: unknown = null;
  let bodyRaw: string | null = null;
  let bodyRawTruncated = false;

  if (req.body !== undefined) {
    // A parser matched the content-type (express.json()): the parsed value IS
    // the body, and the stream behind it is already consumed.
    body = req.body;
  } else {
    // No parser claimed these bytes — read the request stream ourselves,
    // keeping at most BODY_RAW_CAP bytes but consuming to the end (socket
    // hygiene: answering over an unconsumed body risks a socket reset).
    const chunks: Buffer[] = [];
    let keptBytes = 0;
    let sawMore = false;
    for await (const chunk of req) {
      if (keptBytes >= BODY_RAW_CAP) {
        sawMore = true;
        continue;
      }
      const room = BODY_RAW_CAP - keptBytes;
      const slice = chunk.subarray(0, room);
      chunks.push(Buffer.from(slice));
      keptBytes += slice.length;
      if (slice.length < chunk.length) sawMore = true;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw !== '') {
      bodyRaw = raw.slice(0, BODY_RAW_CAP);
      bodyRawTruncated = sawMore;
    }
  }

  res.status(200).json({
    method: req.method,
    // The path as the CLIENT wrote it — req.path is mount-relative once /api
    // is stripped by app.use.
    path: req.originalUrl.split('?')[0],
    query: { ...req.query } as Record<string, unknown>,
    headers,
    body,
    bodyRaw,
    bodyRawTruncated,
    requestId,
  });
}

/** Echo ONLY the x- prefixed request headers — proof custom headers travel. */
function echoCustomHeadersController(req: Request, res: Response): void {
  const customHeaders: Record<string, string | string[]> = {};
  for (const name of Object.keys(req.headers).sort()) {
    if (!name.startsWith('x-')) continue;
    const value = req.headers[name];
    customHeaders[name] = value === undefined ? '' : value;
  }
  res.status(200).json({ method: req.method, customHeaders });
}

/** The stream family: five ndjson lines, one write each, setImmediate pauses. */
function streamRespond(res: Response): void {
  res.status(200).type('application/x-ndjson');
  res.setHeader('X-Stream-Lines', String(STREAM_LINE_COUNT));

  const lines: string[] = [];
  for (let seq = 1; seq <= STREAM_LINE_COUNT; seq += 1) {
    lines.push(`{"seq":${seq},"of":${STREAM_LINE_COUNT},"mode":"stream"}\n`);
  }

  // Same simple write loop as the node topic's demo — five ~35-byte lines
  // never approach the socket's high-water mark, so backpressure handling
  // would be dead weight here; the topic shows the real pattern for when it
  // is not.
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

/** The response-methods playground: one real family per mode. */
function respondController(req: Request, res: Response): void {
  const mode = parseRespondMode(req.query.mode);

  switch (mode) {
    case 'json': {
      res.json({
        mode: 'json',
        producedBy: 'res.json(object)',
        lesson:
          'res.json serializes the object and sets Content-Type: application/json; charset=utf-8',
      });
      return;
    }
    case 'text': {
      res
        .type('text/plain')
        .send(
          'mode: text — produced by res.type("text/plain").send(string)\n' +
            'Content-Type was set explicitly; the body is the string exactly as written.\n',
        );
      return;
    }
    case 'status': {
      const chosen = parseChosenStatus(req.query.status);
      if (chosen === 204) {
        // 204 No Content means NO body — res.end() terminates the response
        // without ever starting one. A body on a 204 is a protocol violation.
        res.status(204).end();
        return;
      }
      res.status(chosen).json({
        mode: 'status',
        chosen,
        producedBy: `res.status(${String(chosen)}).json(object)`,
        note: 'the status line is the lesson — a chosen status is not a failure, so this is an ordinary body, not the error envelope',
      });
      return;
    }
    case 'redirect': {
      // 307: the method and body survive the redirect (301/302 may rewrite
      // POST into GET). Express sets Location and a tiny text/plain body.
      res.redirect(307, REDIRECT_TARGET);
      return;
    }
    case 'cookie': {
      res
        .cookie('teaching_cookie', 'baked', {
          httpOnly: true, // invisible to document.cookie
          sameSite: 'strict', // never attached cross-site
          maxAge: 60_000, // relative expiry → Max-Age=60
        })
        .json({
          mode: 'cookie',
          set: true,
          producedBy: 'res.cookie(name, value, options).json(object)',
          note: 'the real lesson is in the Set-Cookie response header — HttpOnly, SameSite=Strict, Max-Age=60',
        });
      return;
    }
    case 'stream': {
      streamRespond(res);
      return;
    }
    case 'download': {
      // A teaching stand-in for res.download(): no file dependency, just the
      // header that makes a body a download. The Files & Media topic streams
      // real files with res.download()/res.sendFile().
      res.setHeader('Content-Disposition', 'attachment; filename="teaching.txt"');
      res
        .type('text/plain')
        .send(
          'teaching.txt — this body arrives as a download because of one header.\n' +
            'Real endpoints use res.download() / res.sendFile(); the Files & Media topic does it for real.\n',
        );
      return;
    }
  }
}

/** Where the 307 lands — small enough to read at a glance. */
function redirectTargetController(_req: Request, res: Response): void {
  res.json({
    arrived: true,
    at: REDIRECT_TARGET,
    note: 'the 307 landed here with the method and body preserved — curl -L (or fetch following redirects) shows this as the followed response',
  });
}

export const reqresDemoRouter = Router();
// app.all-style: ONE registration, every method answers the inspector.
reqresDemoRouter.all('/demo/reqres/inspect', inspectController);
reqresDemoRouter.put('/demo/reqres/echo-custom-headers', echoCustomHeadersController);
reqresDemoRouter.get('/demo/reqres/respond', respondController);
reqresDemoRouter.get('/demo/reqres/redirect-target', redirectTargetController);
