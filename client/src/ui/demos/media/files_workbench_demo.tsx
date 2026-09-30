import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `files:workbench` — the Files & Media topic's lab over
 * the real endpoints (files_demo_routes.ts + data/files/file_store.ts):
 *
 * 1. UPLOAD — a file input (the allowlist as accept) POSTing multipart via
 *    fetch + FormData at the real multer stack. Bait on purpose: >5MB answers
 *    the 400 envelope naming LIMIT_FILE_SIZE, a .exe answers mime_not_allowed,
 *    a text file renamed .png answers with the honest demotion note. fetch
 *    cannot report upload progress (no progress events for request bodies) —
 *    the note says so and points at XHR, the standard workaround.
 * 2. LIBRARY — every stored file as a card: the sharp webp thumbnail (a real
 *    <img> at /thumb), sanitized name, size, kind; open-raw (inline) and
 *    download (attachment) links — the Content-Disposition split, one click apart.
 * 3. RANGE TESTER — canned Range headers at /stream: bytes=0-99 (206 +
 *    Content-Range + exactly 100 received bytes), last 50 (suffix form), and
 *    an unsatisfiable offset (416 + the "bytes STAR-slash-size" pointer).
 * 4. BACKPRESSURE — runs the pipeline endpoint and renders its honest
 *    summary line: chunks, drainEvents, pausedMs.
 * 5. PATH GUARD — the containment verdict for any input, prefilled with the
 *    ../ attack; the endpoint never reads a byte either way.
 */

const LIST_URL = '/api/demo/files';
const UPLOAD_URL = '/api/demo/files/upload';
const PIPELINE_URL = '/api/demo/files/pipeline-demo';
const PATH_GUARD_URL = '/api/demo/files/path-guard';

const TRAVERSAL_INPUT = '../../etc/passwd';
const ENCODED_TRAVERSAL_INPUT = '..%2F..%2Fetc%2Fpasswd';
const SAFE_INPUT = 'reports/2026/q3.csv';

const ACCEPT_ATTRIBUTE = '.jpg,.jpeg,.png,.webp,.pdf,.txt,image/jpeg,image/png,image/webp,application/pdf,text/plain';

interface ThumbInfo {
  name: string;
  size: number;
  width: number;
  height: number;
}

interface StoredFile {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
  note?: string;
  variants?: { thumb?: ThumbInfo };
}

type LibraryState =
  | { kind: 'loading' }
  | { kind: 'ready'; files: StoredFile[] }
  | { kind: 'failed'; problem: string };

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string }
  | { kind: 'done'; file: StoredFile }
  | { kind: 'failed'; problem: string };

interface RangeResult {
  range: string;
  status: number;
  contentRange: string | null;
  acceptRanges: string | null;
  receivedBytes?: number;
  fullSize: number;
  errorCode?: string;
  message?: string;
}

type RangeState =
  | { kind: 'idle' }
  | { kind: 'loading'; range: string }
  | { kind: 'ready'; result: RangeResult }
  | { kind: 'failed'; problem: string };

interface PipelineSummary {
  chunks: number;
  drainEvents: number;
  pausedMs: number;
}

type PipelineState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; summary: PipelineSummary }
  | { kind: 'failed'; problem: string };

interface GuardVerdict {
  input: string;
  resolved: string;
  uploadRoot: string;
  contained: boolean;
  verdict: string;
  reason?: string;
}

type GuardState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; verdict: GuardVerdict }
  | { kind: 'failed'; problem: string };

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_OK =
  'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary';
const CHIP_ERROR =
  'rounded-md border border-outline bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';
const INPUT =
  'w-full max-w-md rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface';
const CARD = 'flex flex-col gap-xxs rounded-md border border-outline bg-surface p-sm';

const UNREACHABLE = 'could not reach the server — is the guide running on :4000?';

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function readBodyText(response: Response): Promise<string> {
  const textFn: unknown = (response as { text?: unknown }).text;
  if (typeof textFn === 'function') return response.text();
  try {
    const value: unknown = await response.json();
    return JSON.stringify(value);
  } catch {
    return '(unreadable body)';
  }
}

function parseStoredFile(value: unknown): StoredFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.originalName !== 'string' ||
    typeof record.size !== 'number' ||
    (record.kind !== 'image' && record.kind !== 'file')
  ) {
    return null;
  }
  return {
    id: record.id,
    originalName: record.originalName,
    mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'application/octet-stream',
    size: record.size,
    kind: record.kind,
    ...(typeof record.note === 'string' && { note: record.note }),
    ...(typeof record.variants === 'object' &&
      record.variants !== null &&
      typeof (record.variants as Record<string, unknown>).thumb === 'object' &&
      (record.variants as Record<string, unknown>).thumb !== null && {
        variants: { thumb: (record.variants as { thumb: ThumbInfo }).thumb },
      }),
  };
}

function parseFileList(value: unknown): StoredFile[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  const parsed = files.map(parseStoredFile).filter((file): file is StoredFile => file !== null);
  return parsed.length === files.length ? parsed : null;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parseGuardVerdict(value: unknown): GuardVerdict | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.input !== 'string' || typeof record.contained !== 'boolean') return null;
  return {
    input: record.input,
    resolved: typeof record.resolved === 'string' ? record.resolved : '?',
    uploadRoot: typeof record.uploadRoot === 'string' ? record.uploadRoot : '?',
    contained: record.contained,
    verdict: typeof record.verdict === 'string' ? record.verdict : '?',
    ...(typeof record.reason === 'string' && { reason: record.reason }),
  };
}

export default function FilesWorkbenchDemo(): ReactNode {
  const [libraryState, setLibraryState] = useState<LibraryState>({ kind: 'loading' });
  const [uploadState, setUploadState] = useState<UploadState>({ kind: 'idle' });
  const [rangeTargetId, setRangeTargetId] = useState<string>('');
  const [rangeState, setRangeState] = useState<RangeState>({ kind: 'idle' });
  const [pipelineState, setPipelineState] = useState<PipelineState>({ kind: 'idle' });
  const [guardInput, setGuardInput] = useState(TRAVERSAL_INPUT);
  const [guardState, setGuardState] = useState<GuardState>({ kind: 'idle' });

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refreshLibrary = (): void => {
    void (async () => {
      try {
        const response = await fetch(LIST_URL);
        if (!aliveRef.current) return;
        if (response.status >= 400) {
          setLibraryState({
            kind: 'failed',
            problem: `${String(response.status)} — ${await readBodyText(response)}`,
          });
          return;
        }
        const parsed = tryParseJson(await readBodyText(response));
        const files = parsed.ok ? parseFileList(parsed.value) : null;
        if (files === null) {
          setLibraryState({ kind: 'failed', problem: 'unexpected files payload' });
          return;
        }
        setLibraryState({ kind: 'ready', files });
      } catch {
        if (aliveRef.current) setLibraryState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  // The library loads with the demo.
  useEffect(() => {
    refreshLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The range tester follows the first card whenever the library gains one.
  useEffect(() => {
    if (libraryState.kind === 'ready' && libraryState.files.length > 0 && rangeTargetId === '') {
      setRangeTargetId(libraryState.files[0]!.id);
    }
  }, [libraryState, rangeTargetId]);

  const upload = (file: File): void => {
    setUploadState({ kind: 'uploading', fileName: file.name });
    void (async () => {
      try {
        // fetch + FormData is the multipart client; note: fetch has NO upload
        // progress events — XHR (or request streams) is the workaround.
        const body = new FormData();
        body.append('file', file);
        const response = await fetch(UPLOAD_URL, { method: 'POST', body });
        if (!aliveRef.current) return;
        const text = await readBodyText(response);
        if (response.status >= 400) {
          setUploadState({ kind: 'failed', problem: `${String(response.status)} — ${text}` });
          return;
        }
        const parsed = tryParseJson(text);
        const stored = parsed.ok ? parseStoredFile((parsed.value as { file?: unknown }).file) : null;
        if (stored === null) {
          setUploadState({ kind: 'failed', problem: 'unexpected upload payload' });
          return;
        }
        setUploadState({ kind: 'done', file: stored });
        refreshLibrary();
      } catch {
        if (aliveRef.current) setUploadState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const runRange = (range: string): void => {
    if (rangeTargetId === '') return;
    setRangeState({ kind: 'loading', range });
    void (async () => {
      try {
        const response = await fetch(`/api/demo/files/${rangeTargetId}/stream`, {
          headers: { Range: range },
        });
        if (!aliveRef.current) return;
        const fullSize =
          libraryState.kind === 'ready'
            ? (libraryState.files.find((file) => file.id === rangeTargetId)?.size ?? 0)
            : 0;
        const base: RangeResult = {
          range,
          status: response.status,
          contentRange: response.headers.get('content-range'),
          acceptRanges: response.headers.get('accept-ranges'),
          fullSize,
        };
        if (response.status >= 400) {
          const parsed = tryParseJson(await readBodyText(response));
          const error =
            parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
              ? (parsed.value as { error?: Record<string, unknown> }).error
              : undefined;
          setRangeState({
            kind: 'ready',
            result: {
              ...base,
              errorCode: typeof error?.code === 'string' ? error.code : undefined,
              message: typeof error?.message === 'string' ? error.message : undefined,
            },
          });
          return;
        }
        const bufferFn: unknown = (response as { arrayBuffer?: unknown }).arrayBuffer;
        const receivedBytes =
          typeof bufferFn === 'function' ? (await response.arrayBuffer()).byteLength : 0;
        setRangeState({ kind: 'ready', result: { ...base, receivedBytes } });
      } catch {
        if (aliveRef.current) setRangeState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const runPipeline = (): void => {
    setPipelineState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`${PIPELINE_URL}?chunks=200`);
        if (!aliveRef.current) return;
        if (response.status >= 400) {
          setPipelineState({
            kind: 'failed',
            problem: `${String(response.status)} — ${await readBodyText(response)}`,
          });
          return;
        }
        const text = (await readBodyText(response)).replace(/\r/g, '');
        const lines = text.split('\n').filter((line) => line !== '');
        const summaryLine = lines[lines.length - 1];
        const parsed = summaryLine === undefined ? null : tryParseJson(summaryLine);
        const record =
          parsed !== null && parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
            ? (parsed.value as Record<string, unknown>)
            : null;
        if (
          record === null ||
          record.summary !== true ||
          typeof record.chunks !== 'number' ||
          typeof record.drainEvents !== 'number' ||
          typeof record.pausedMs !== 'number'
        ) {
          setPipelineState({ kind: 'failed', problem: 'no summary line in the pipeline stream' });
          return;
        }
        setPipelineState({
          kind: 'ready',
          summary: { chunks: record.chunks, drainEvents: record.drainEvents, pausedMs: record.pausedMs },
        });
      } catch {
        if (aliveRef.current) setPipelineState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const runGuard = (): void => {
    setGuardState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(`${PATH_GUARD_URL}?input=${encodeURIComponent(guardInput)}`);
        if (!aliveRef.current) return;
        if (response.status >= 400) {
          setGuardState({
            kind: 'failed',
            problem: `${String(response.status)} — ${await readBodyText(response)}`,
          });
          return;
        }
        const parsed = tryParseJson(await readBodyText(response));
        const verdict = parsed.ok ? parseGuardVerdict(parsed.value) : null;
        if (verdict === null) {
          setGuardState({ kind: 'failed', problem: 'unexpected path-guard payload' });
          return;
        }
        setGuardState({ kind: 'ready', verdict });
      } catch {
        if (aliveRef.current) setGuardState({ kind: 'failed', problem: UNREACHABLE });
      }
    })();
  };

  const rangeTarget =
    libraryState.kind === 'ready' ? libraryState.files.find((file) => file.id === rangeTargetId) : undefined;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="files-summary" className="text-body-sm text-on-surface">
        Five panels over the real endpoints: an upload through the full validation stack, the
        library with sharp thumbnails, a range tester against the hand-rolled 206/416 responder,
        the backpressure report, and the path guard you can attack yourself.
      </p>

      {/* 1 — upload */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          1 · Upload (multipart → multer → sharp)
        </h3>

        <div className="flex flex-wrap items-center gap-sm">
          <input
            type="file"
            data-testid="files-upload-input"
            accept={ACCEPT_ATTRIBUTE}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) upload(file);
              event.target.value = ''; // allow re-uploading the same name
            }}
            className="text-caption text-on-surface-variant"
          />
        </div>

        {uploadState.kind === 'uploading' && (
          <p data-testid="files-upload-uploading" className="font-mono text-caption text-on-surface-variant">
            uploading {uploadState.fileName}…
          </p>
        )}
        {uploadState.kind === 'done' && (
          <div data-testid="files-upload-result" className="flex flex-col gap-xxs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_OK}>201 stored</span>
              <span className={CHIP}>{uploadState.file.id}</span>
              <span className={CHIP}>{uploadState.file.kind}</span>
              <span className="text-on-surface-variant">
                {formatBytes(uploadState.file.size)}
                {uploadState.file.variants?.thumb !== undefined
                  ? ` · thumb ${String(uploadState.file.variants.thumb.width)}w webp, ${formatBytes(uploadState.file.variants.thumb.size)}`
                  : ''}
              </span>
            </p>
            {uploadState.file.note !== undefined && (
              <p className="font-mono text-caption text-on-surface-variant">{uploadState.file.note}</p>
            )}
          </div>
        )}
        {uploadState.kind === 'failed' && (
          <pre data-testid="files-upload-error" className={PRE}>
            {uploadState.problem}
          </pre>
        )}

        <p data-testid="files-upload-hint" className="text-caption text-on-surface-variant">
          bait, on purpose: try a file &gt;5MB (the 400 envelope names LIMIT_FILE_SIZE), a
          non-allowlisted type (mime_not_allowed), or a text file renamed .png — the filter checks
          the DECLARED type, so the lie gets caught later and reported honestly. fetch cannot show
          upload progress; XHR is the standard workaround.
        </p>
      </section>

      {/* 2 — library */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          2 · Library (thumbnails by sharp, dispositions by choice)
        </h3>

        {libraryState.kind === 'loading' && (
          <p data-testid="files-library-loading" className="text-caption text-on-surface-variant">
            fetching stored files…
          </p>
        )}
        {libraryState.kind === 'failed' && (
          <pre data-testid="files-library-failed" className={PRE}>
            {libraryState.problem}
          </pre>
        )}
        {libraryState.kind === 'ready' && libraryState.files.length === 0 && (
          <p data-testid="files-library-empty" className="text-caption text-on-surface-variant">
            nothing stored yet — upload something above (or curl -F "file=@photo.jpg").
          </p>
        )}
        {libraryState.kind === 'ready' && libraryState.files.length > 0 && (
          <div data-testid="files-library" className="flex flex-wrap gap-sm">
            {libraryState.files.map((file) => (
              <div key={file.id} data-testid="files-card" className={CARD}>
                {file.variants?.thumb !== undefined ? (
                  <img
                    data-testid="files-card-thumb"
                    src={`/api/demo/files/${file.id}/thumb`}
                    alt={`thumbnail of ${file.originalName}`}
                    className="h-16 w-32 rounded-sm border border-outline object-cover"
                  />
                ) : (
                  <div
                    data-testid="files-card-nothumb"
                    className="flex h-16 w-32 items-center justify-center rounded-sm border border-dashed border-outline font-mono text-caption text-on-surface-variant"
                  >
                    no thumb
                  </div>
                )}
                <p className="font-mono text-caption break-all text-on-surface">{file.originalName}</p>
                <p className="font-mono text-caption text-on-surface-variant">
                  {formatBytes(file.size)} · {file.kind} · {file.id}
                </p>
                {file.note !== undefined && (
                  <p className="max-w-64 font-mono text-caption break-words text-on-surface-variant">
                    {file.note}
                  </p>
                )}
                <div className="flex gap-xs">
                  <a
                    data-testid="files-card-raw-link"
                    className={`${CHIP} hover:bg-surface-variant`}
                    href={`/api/demo/files/${file.id}/raw`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    open inline
                  </a>
                  <a
                    data-testid="files-card-download-link"
                    className={`${CHIP} hover:bg-surface-variant`}
                    href={`/api/demo/files/${file.id}/download`}
                  >
                    download
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-caption text-on-surface-variant">
          open inline = Content-Disposition: inline (the browser renders it); download = attachment
          (save-to-disk with the sanitized name). Stored under the OS temp dir, never the repo.
        </p>
      </section>

      {/* 3 — range tester */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          3 · Range tester (206 · Content-Range · 416)
        </h3>

        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex items-center gap-xxs text-caption text-on-surface-variant">
            file
            <select
              data-testid="files-range-select"
              value={rangeTargetId}
              onChange={(event) => {
                setRangeTargetId(event.target.value);
                setRangeState({ kind: 'idle' });
              }}
              className="rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface"
            >
              {libraryState.kind !== 'ready' && <option value="">(no files)</option>}
              {libraryState.kind === 'ready' &&
                libraryState.files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.originalName} ({String(file.size)} B)
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="files-range-0-99"
            onClick={() => runRange('bytes=0-99')}
            disabled={rangeTargetId === '' || rangeState.kind === 'loading'}
            className={BUTTON_PRIMARY}
          >
            bytes=0-99
          </button>
          <button
            type="button"
            data-testid="files-range-last50"
            onClick={() => runRange('bytes=-50')}
            disabled={rangeTargetId === '' || rangeState.kind === 'loading'}
            className={BUTTON}
          >
            last 50 (suffix)
          </button>
          <button
            type="button"
            data-testid="files-range-unsat"
            onClick={() => runRange('bytes=999999999-')}
            disabled={rangeTargetId === '' || rangeState.kind === 'loading'}
            className={BUTTON}
          >
            unsatisfiable
          </button>
        </div>

        {rangeTarget !== undefined && (
          <p className="font-mono text-caption text-on-surface-variant">
            target {rangeTarget.id} · full size {String(rangeTarget.size)} bytes
          </p>
        )}
        {rangeState.kind === 'idle' && (
          <p data-testid="files-range-idle" className="text-caption text-on-surface-variant">
            every button sends a real Range header at /stream — watch the status, the Content-Range
            arithmetic, and how many bytes actually arrive.
          </p>
        )}
        {rangeState.kind === 'loading' && (
          <p data-testid="files-range-loading" className="font-mono text-caption text-on-surface-variant">
            sending Range: {rangeState.range} …
          </p>
        )}
        {rangeState.kind === 'failed' && (
          <pre data-testid="files-range-failed" className={PRE}>
            {rangeState.problem}
          </pre>
        )}
        {rangeState.kind === 'ready' && (
          <div data-testid="files-range-result" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={rangeState.result.status < 400 ? CHIP_OK : CHIP_ERROR}>
                {String(rangeState.result.status)}
              </span>
              <span className="text-on-surface">Range: {rangeState.result.range}</span>
              <span className="text-on-surface-variant">
                Content-Range → {rangeState.result.contentRange ?? '(none — full body)'}
              </span>
            </p>
            {rangeState.result.receivedBytes !== undefined ? (
              <p className="font-mono text-caption text-on-surface-variant">
                received {String(rangeState.result.receivedBytes)} of {String(rangeState.result.fullSize)} bytes
                {` · Accept-Ranges: ${rangeState.result.acceptRanges ?? '?'}`}
                {rangeState.result.receivedBytes !== rangeState.result.fullSize
                  ? ' — a slice, not the file'
                  : ' — the whole file'}
              </p>
            ) : (
              <p className="font-mono text-caption break-all text-on-surface-variant">
                {`${rangeState.result.errorCode ?? 'error'}${
                  rangeState.result.message !== undefined ? ` — ${rangeState.result.message}` : ''
                } · Content-Range: ${rangeState.result.contentRange ?? '?'} (the star says: impossible; the number says: real size)`}
              </p>
            )}
          </div>
        )}
      </section>

      {/* 4 — backpressure */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          4 · Backpressure report (write → false → await drain)
        </h3>

        <button
          type="button"
          data-testid="files-pipeline-button"
          onClick={runPipeline}
          disabled={pipelineState.kind === 'loading'}
          className={BUTTON_PRIMARY}
        >
          {pipelineState.kind === 'loading' ? 'streaming…' : 'run the pipeline (200 × ~2KB lines)'}
        </button>

        {pipelineState.kind === 'idle' && (
          <p data-testid="files-pipeline-idle" className="text-caption text-on-surface-variant">
            the producer writes ndjson through the real pattern — write() checked, drain awaited —
            and reports honestly. On localhost the client is usually faster than the producer, so
            drainEvents may truthfully be 0; the pattern itself is unit-proven with a fake sink
            that returns false once.
          </p>
        )}
        {pipelineState.kind === 'failed' && (
          <pre data-testid="files-pipeline-failed" className={PRE}>
            {pipelineState.problem}
          </pre>
        )}
        {pipelineState.kind === 'ready' && (
          <div data-testid="files-pipeline-result" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={CHIP_OK}>stream complete</span>
              <span className={CHIP}>chunks: {String(pipelineState.summary.chunks)}</span>
              <span className={CHIP}>drainEvents: {String(pipelineState.summary.drainEvents)}</span>
              <span className={CHIP}>pausedMs: {String(pipelineState.summary.pausedMs)}</span>
            </p>
            <p className="text-caption text-on-surface-variant">
              {pipelineState.summary.drainEvents > 0
                ? 'the socket buffer filled — the producer paused and waited for drain, exactly the pattern the topic teaches.'
                : 'no pauses this run — the consumer kept up (honest 0). Slower consumers see drainEvents climb; unbounded write() loops are the failure mode this replaces.'}
            </p>
          </div>
        )}
      </section>

      {/* 5 — path guard */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <h3 className="font-mono text-body-sm font-semibold text-on-surface">
          5 · The path guard (resolve + contain — never reads)
        </h3>

        <div className="flex flex-wrap items-center gap-sm">
          <label className="flex flex-1 items-center gap-xxs text-caption text-on-surface-variant">
            input
            <input
              type="text"
              data-testid="files-guard-input"
              value={guardInput}
              onChange={(event) => setGuardInput(event.target.value)}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            data-testid="files-guard-button"
            onClick={runGuard}
            disabled={guardState.kind === 'loading' || guardInput.trim() === ''}
            className={BUTTON_PRIMARY}
          >
            {guardState.kind === 'loading' ? 'judging…' : 'check input'}
          </button>
        </div>
        <div className="flex flex-wrap gap-xxs">
          {[
            { label: '../ traversal', value: TRAVERSAL_INPUT, testid: 'files-guard-preset-traversal' },
            { label: 'url-encoded form', value: ENCODED_TRAVERSAL_INPUT, testid: 'files-guard-preset-encoded' },
            { label: 'safe path', value: SAFE_INPUT, testid: 'files-guard-preset-safe' },
          ].map((preset) => (
            <button
              key={preset.value}
              type="button"
              data-testid={preset.testid}
              onClick={() => setGuardInput(preset.value)}
              className={CHIP}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {guardState.kind === 'idle' && (
          <p data-testid="files-guard-idle" className="text-caption text-on-surface-variant">
            prefilled with the attack — press check. The endpoint runs the REAL containment guard
            and never reads a file either way.
          </p>
        )}
        {guardState.kind === 'failed' && (
          <pre data-testid="files-guard-failed" className={PRE}>
            {guardState.problem}
          </pre>
        )}
        {guardState.kind === 'ready' && (
          <div data-testid="files-guard-verdict" className="flex flex-col gap-xs">
            <p className="flex flex-wrap items-center gap-xs font-mono text-caption">
              <span className={guardState.verdict.contained ? CHIP_OK : CHIP_ERROR}>
                {guardState.verdict.verdict.toUpperCase()}
              </span>
              <span className="text-on-surface">input: {guardState.verdict.input}</span>
              {guardState.verdict.reason !== undefined && (
                <span className={CHIP}>{guardState.verdict.reason}</span>
              )}
            </p>
            <p data-testid="files-guard-resolved" className="font-mono text-caption break-all text-on-surface-variant">
              resolved → {guardState.verdict.resolved}
            </p>
            <p data-testid="files-guard-root" className="font-mono text-caption break-all text-on-surface-variant">
              upload root → {guardState.verdict.uploadRoot}
            </p>
            <p className="text-caption text-on-surface-variant">
              the url-encoded preset arrives DECODED at the server — ../ and ..%2F are the same
              attack by the time your code sees them. Contained means the resolved path stayed
              under the root; nothing was read.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
