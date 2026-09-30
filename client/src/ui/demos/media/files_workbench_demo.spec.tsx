import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import FilesWorkbenchDemo from './files_workbench_demo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const LIST_URL = '/api/demo/files';
const UPLOAD_URL = '/api/demo/files/upload';
const PIPELINE_URL = '/api/demo/files/pipeline-demo?chunks=200';
const GUARD_URL = '/api/demo/files/path-guard';

const IMAGE_FILE = {
  id: 'files-aaaa1111bbbb',
  originalName: 'pixel.png',
  mimeType: 'image/png',
  size: 2048,
  kind: 'image',
  variants: { thumb: { name: 'files-aaaa1111bbbb.thumb.webp', size: 154, width: 128, height: 1 } },
} as const;

const TEXT_FILE = {
  id: 'files-cccc2222dddd',
  originalName: 'notes.txt',
  mimeType: 'text/plain',
  size: 100,
  kind: 'file',
} as const;

const UPLOADED_FILE = {
  id: 'files-eeee3333ffff',
  originalName: 'fresh-upload.png',
  mimeType: 'image/png',
  size: 512,
  kind: 'image',
  variants: { thumb: { name: 'files-eeee3333ffff.thumb.webp', size: 120, width: 128, height: 1 } },
} as const;

function responseLike(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
  extra: { arrayBuffer?: () => ArrayBuffer | Promise<ArrayBuffer> } = {},
) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string): string | null => lower[name.toLowerCase()] ?? null,
      entries: (): Array<[string, string]> => Object.entries(lower),
    },
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: extra.arrayBuffer ?? (async () => bytes.buffer as ArrayBuffer),
  };
}

/**
 * A stateful fake server: dispatches on URL + method + the Range header of
 * init.headers (the range buttons share one URL and differ only by header).
 */
function stubFilesServer(overrides: { uploadError?: unknown } = {}) {
  let uploaded = false;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const rangeHeader =
      init !== undefined &&
      typeof init.headers === 'object' &&
      init.headers !== null &&
      !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>).Range
        : undefined;

    if (url === LIST_URL && method === 'GET') {
      const files = [IMAGE_FILE, TEXT_FILE, ...(uploaded ? [UPLOADED_FILE] : [])];
      return responseLike({ files, count: files.length, cap: 50 });
    }
    if (url === UPLOAD_URL && method === 'POST') {
      if (overrides.uploadError !== undefined) {
        return responseLike(overrides.uploadError, 400);
      }
      uploaded = true;
      return responseLike({ file: UPLOADED_FILE, files: [UPLOADED_FILE] }, 201);
    }
    if (url === `/api/demo/files/${IMAGE_FILE.id}/stream` && method === 'GET') {
      if (rangeHeader === 'bytes=0-99') {
        return responseLike(
          null,
          206,
          { 'content-range': 'bytes 0-99/2048', 'accept-ranges': 'bytes', 'content-length': '100' },
          { arrayBuffer: async () => new ArrayBuffer(100) },
        );
      }
      if (rangeHeader === 'bytes=-50') {
        return responseLike(
          null,
          206,
          { 'content-range': 'bytes 1998-2047/2048', 'accept-ranges': 'bytes' },
          { arrayBuffer: async () => new ArrayBuffer(50) },
        );
      }
      if (rangeHeader === 'bytes=999999999-') {
        return responseLike(
          { error: { code: 'range_not_satisfiable', message: 'Range "bytes=999999999-" cannot be satisfied — the file is 2048 bytes', requestId: 'test' } },
          416,
          { 'content-range': 'bytes */2048' },
        );
      }
      return responseLike(null, 200, { 'accept-ranges': 'bytes', 'content-length': '2048' }, {
        arrayBuffer: async () => new ArrayBuffer(2048),
      });
    }
    if (url === PIPELINE_URL && method === 'GET') {
      const lines = ['{"seq":1,"event":"telemetry"}', '{"summary":true,"chunks":200,"drainEvents":0,"pausedMs":0}'];
      return responseLike(`${lines.join('\n')}\n`, 200, { 'content-type': 'application/x-ndjson' });
    }
    if (url.startsWith(GUARD_URL)) {
      const input = decodeURIComponent(url.split('input=')[1] ?? '');
      const contained = input === 'reports/2026/q3.csv';
      return responseLike({
        input,
        uploadRoot: '/tmp/express_guide_uploads/session-1',
        resolved: contained
          ? '/tmp/express_guide_uploads/session-1/reports/2026/q3.csv'
          : '/etc/passwd',
        contained,
        verdict: contained ? 'allowed' : 'rejected',
        ...(contained ? {} : { reason: 'escapes the upload root' }),
        readsNothing: true,
      });
    }
    return responseLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}` } }, 404);
  });
}

describe('FilesWorkbenchDemo — five panels over the real endpoints', () => {
  it('renders the library with thumbnail cards and both disposition links', async () => {
    vi.stubGlobal('fetch', stubFilesServer());
    render(<FilesWorkbenchDemo />);

    const library = await screen.findByTestId('files-library');
    const cards = screen.getAllByTestId('files-card');
    expect(cards).toHaveLength(2);
    expect(library).toHaveTextContent('pixel.png');
    expect(library).toHaveTextContent('notes.txt');
    expect(library).toHaveTextContent('2.0 KB');

    const thumb = screen.getByTestId('files-card-thumb') as HTMLImageElement;
    expect(thumb.getAttribute('src')).toBe(`/api/demo/files/${IMAGE_FILE.id}/thumb`);
    expect(screen.getByTestId('files-card-nothumb')).toBeDefined();

    const rawLink = screen.getAllByTestId('files-card-raw-link')[0] as HTMLAnchorElement;
    expect(rawLink.getAttribute('href')).toBe(`/api/demo/files/${IMAGE_FILE.id}/raw`);
    const downloadLink = screen.getAllByTestId('files-card-download-link')[0] as HTMLAnchorElement;
    expect(downloadLink.getAttribute('href')).toBe(`/api/demo/files/${IMAGE_FILE.id}/download`);
  });

  it('uploads a chosen file and the new card appears (FormData POST, then refresh)', async () => {
    const fetchMock = stubFilesServer();
    vi.stubGlobal('fetch', fetchMock);
    render(<FilesWorkbenchDemo />);
    await screen.findByTestId('files-library');
    expect(screen.getAllByTestId('files-card')).toHaveLength(2);

    const file = new File(['png-bytes-here'], 'fresh-upload.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('files-upload-input'), { target: { files: [file] } });

    const result = await screen.findByTestId('files-upload-result');
    expect(result).toHaveTextContent('201 stored');
    expect(result).toHaveTextContent(UPLOADED_FILE.id);
    expect(result).toHaveTextContent('thumb 128w webp');

    expect(await screen.findAllByTestId('files-card')).toHaveLength(3);

    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(post?.[0]).toBe(UPLOAD_URL);
    expect((post?.[1]?.body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('renders the 400 envelope when the upload is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      stubFilesServer({
        uploadError: {
          error: {
            code: 'validation_failed',
            message: 'file exceeds the upload size limit',
            reason: 'LIMIT_FILE_SIZE',
            fileSizeLimitBytes: 5242880,
            requestId: 'test',
          },
        },
      }),
    );
    render(<FilesWorkbenchDemo />);
    await screen.findByTestId('files-library');

    const file = new File([new ArrayBuffer(10)], 'big.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('files-upload-input'), { target: { files: [file] } });

    const error = await screen.findByTestId('files-upload-error');
    expect(error).toHaveTextContent('400');
    expect(error).toHaveTextContent('LIMIT_FILE_SIZE');
    expect(screen.getAllByTestId('files-card')).toHaveLength(2); // library untouched
  });

  it('range buttons: 206 slice, 206 suffix, and the 416 star pointer', { timeout: 15000 }, async () => {
    vi.stubGlobal('fetch', stubFilesServer());
    render(<FilesWorkbenchDemo />);
    // Budget raised to 10s (default 1s): three sequential fetch→render rounds
    // still missed even a 4s budget under heavy ambient load (loadavg 20+).
    // Test-level timeout raised to 15s to match — the default 5s cap killed
    // the test before its own find budgets could elapse.
    await screen.findByTestId('files-library', {}, { timeout: 14000 });

    // Closed range — exactly 100 of 2048 bytes:
    fireEvent.click(screen.getByTestId('files-range-0-99'));
    let result = await screen.findByTestId('files-range-result', {}, { timeout: 14000 });
    expect(result).toHaveTextContent('206');
    expect(result).toHaveTextContent('Content-Range → bytes 0-99/2048');
    expect(result).toHaveTextContent('received 100 of 2048 bytes');
    expect(result).toHaveTextContent('a slice, not the file');

    // Suffix form — the last 50:
    fireEvent.click(screen.getByTestId('files-range-last50'));
    result = await screen.findByTestId('files-range-result', {}, { timeout: 14000 });
    expect(result).toHaveTextContent('bytes 1998-2047/2048');
    expect(result).toHaveTextContent('received 50 of 2048 bytes');

    // Unsatisfiable — 416 with the */size pointer:
    fireEvent.click(screen.getByTestId('files-range-unsat'));
    result = await screen.findByTestId('files-range-result', {}, { timeout: 14000 });
    expect(result).toHaveTextContent('416');
    expect(result).toHaveTextContent('range_not_satisfiable');
    expect(result).toHaveTextContent('bytes */2048');
  });

  it('pipeline panel reports chunks + drainEvents from the summary line', async () => {
    vi.stubGlobal('fetch', stubFilesServer());
    render(<FilesWorkbenchDemo />);
    await screen.findByTestId('files-library');

    fireEvent.click(screen.getByTestId('files-pipeline-button'));
    const result = await screen.findByTestId('files-pipeline-result');
    expect(result).toHaveTextContent('chunks: 200');
    expect(result).toHaveTextContent('drainEvents: 0');
    expect(result).toHaveTextContent('pausedMs: 0');
    expect(result).toHaveTextContent('honest 0');
  });

  it('path guard rejects the traversal prefills and allows the safe path', async () => {
    vi.stubGlobal('fetch', stubFilesServer());
    render(<FilesWorkbenchDemo />);
    // Same class of fix as the range-buttons test: three sequential
    // fetch→render rounds, 10s budget under heavy ambient load.
    await screen.findByTestId('files-library', {}, { timeout: 14000 });

    // Prefilled with plain ../ — one click, one rejection:
    fireEvent.click(screen.getByTestId('files-guard-button'));
    let verdict = await screen.findByTestId('files-guard-verdict', {}, { timeout: 14000 });
    expect(verdict).toHaveTextContent('REJECTED');
    expect(screen.getByTestId('files-guard-resolved')).toHaveTextContent('/etc/passwd');
    expect(verdict).toHaveTextContent('escapes the upload root');

    // The URL-encoded spelling — decoded server-side, same attack:
    fireEvent.click(screen.getByTestId('files-guard-preset-encoded'));
    fireEvent.click(screen.getByTestId('files-guard-button'));
    verdict = await screen.findByTestId('files-guard-verdict', {}, { timeout: 14000 });
    expect(verdict).toHaveTextContent('REJECTED');

    // A contained path passes:
    fireEvent.click(screen.getByTestId('files-guard-preset-safe'));
    fireEvent.click(screen.getByTestId('files-guard-button'));
    verdict = await screen.findByTestId('files-guard-verdict', {}, { timeout: 14000 });
    expect(verdict).toHaveTextContent('ALLOWED');
    expect(screen.getByTestId('files-guard-resolved')).toHaveTextContent('/tmp/express_guide_uploads/session-1/reports/2026/q3.csv');
  });

  it('degrades to reachable-server messages per panel, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<FilesWorkbenchDemo />);

    expect(await screen.findByTestId('files-library-failed')).toHaveTextContent(
      'could not reach the server',
    );

    const file = new File(['x'], 'pixel.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('files-upload-input'), { target: { files: [file] } });
    expect(await screen.findByTestId('files-upload-error')).toHaveTextContent(
      'could not reach the server',
    );

    fireEvent.click(screen.getByTestId('files-pipeline-button'));
    expect(await screen.findByTestId('files-pipeline-failed')).toHaveTextContent(
      'could not reach the server',
    );

    fireEvent.click(screen.getByTestId('files-guard-button'));
    expect(await screen.findByTestId('files-guard-failed')).toHaveTextContent(
      'could not reach the server',
    );
  });
});
