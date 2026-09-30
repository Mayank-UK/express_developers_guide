import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import StreamingDemo from './streaming_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BUFFERED_URL = '/api/demo/node/stream?mode=buffered&chunks=100';
const STREAM_URL = '/api/demo/node/stream?mode=stream&chunks=100';

/** Deterministic telemetry lines, matching the server generator's shape. */
const LINES = ['{"seq":1,"sensor":"cpu-package","valueC":47,"unit":"celsius","status":"ok","host":"guide-node-1"}\n'];
const BODY = LINES.join('');

const bufferedRoute = {
  url: BUFFERED_URL,
  text: BODY,
  headers: { 'content-length': '98', 'x-stream-mode': 'buffered', 'x-elapsed-ms': '0.8' },
};

const streamRoute = {
  url: STREAM_URL,
  text: BODY,
  headers: { 'x-stream-mode': 'stream', 'x-elapsed-ms': '0.2' },
};

describe('StreamingDemo', () => {
  it('renders both idle panels and fetches nothing', () => {
    const fetchMock = (() => {
      stubApiFetch([bufferedRoute, streamRoute]);
      return vi.mocked(fetch);
    })();

    render(<StreamingDemo />);

    expect(screen.getByTestId('streaming-run-buffered')).toHaveTextContent('download 100 lines');
    expect(screen.getByTestId('streaming-run-stream')).toHaveTextContent('download 100 lines');
    expect(screen.queryByTestId('streaming-verdict')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('buffered run shows the declared size, headers, and body stats', async () => {
    const fetchMock = (() => {
      stubApiFetch([bufferedRoute, streamRoute]);
      return vi.mocked(fetch);
    })();

    render(<StreamingDemo />);
    fireEvent.click(screen.getByTestId('streaming-run-buffered'));

    const result = await screen.findByTestId('streaming-result-buffered');
    expect(result).toHaveTextContent('buffered');
    // content-length header value from the stub, declared in bytes.
    expect(result).toHaveTextContent('98 bytes');
    expect(result).toHaveTextContent('x-stream-mode');
    expect(result).toHaveTextContent('buffered');
    expect(result).toHaveTextContent('1 lines ≈ 98 bytes');
    // Client-observed elapsed is rendered as a number of ms.
    expect(screen.getByTestId('streaming-elapsed')).toHaveTextContent(/ms$/);
    // No verdict until both modes have run.
    expect(screen.queryByTestId('streaming-verdict')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([BUFFERED_URL]);
  });

  it('stream run shows no content-length, then the verdict once both ran', async () => {
    stubApiFetch([bufferedRoute, streamRoute]);

    render(<StreamingDemo />);
    fireEvent.click(screen.getByTestId('streaming-run-buffered'));
    await screen.findByTestId('streaming-result-buffered');

    fireEvent.click(screen.getByTestId('streaming-run-stream'));
    const streamResult = await screen.findByTestId('streaming-result-stream');
    expect(streamResult).toHaveTextContent('not sent'); // no content-length header
    expect(streamResult).toHaveTextContent('x-stream-mode');
    expect(streamResult).toHaveTextContent('stream');

    const verdict = screen.getByTestId('streaming-verdict');
    expect(verdict).toHaveTextContent('Same 1 lines');
    expect(verdict).toHaveTextContent('98 bytes');
    expect(verdict).toHaveTextContent('declared its full size up front');
    expect(verdict).toHaveTextContent('no content-length');
  });

  it('shows the server error message when an endpoint fails', async () => {
    stubApiFetch([
      bufferedRoute,
      {
        url: STREAM_URL,
        status: 400,
        text: JSON.stringify({
          error: { code: 'validation_failed', message: 'unknown mode', requestId: 'r-2' },
        }),
      },
    ]);

    render(<StreamingDemo />);
    fireEvent.click(screen.getByTestId('streaming-run-stream'));

    const alert = await screen.findByTestId('streaming-error-stream');
    expect(alert).toHaveTextContent('unknown mode');
    expect(screen.queryByTestId('streaming-result-stream')).not.toBeInTheDocument();
  });

  it('shows a friendly error when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<StreamingDemo />);
    fireEvent.click(screen.getByTestId('streaming-run-buffered'));

    const alert = await screen.findByTestId('streaming-error-buffered');
    expect(alert).toHaveTextContent('Could not reach the server.');
  });
});
