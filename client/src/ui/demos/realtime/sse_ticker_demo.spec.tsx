import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SseTickerDemo from './sse_ticker_demo';

/**
 * jsdom has no EventSource — this spec installs a FAITHFUL fake: the same
 * constructor/onopen/onerror/addEventListener('tick') surface, the same
 * readyState transitions (0 on construction → 1 on open → 0 again if an
 * error puts the browser into auto-reconnect), and a close() the unmount
 * test can spy on.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  url: string;
  readyState = 0;
  closed = false;
  onopen: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
    // The browser opens asynchronously — so does the fake.
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  addEventListener(type: string, callback: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(callback);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.readyState = 2;
    this.closed = true;
  }

  // ---- test-side controls -----------------------------------------------
  emitTick(payload: { seq: number; time: string; value: number; change: number }): void {
    for (const callback of this.listeners.get('tick') ?? []) {
      callback({ data: JSON.stringify(payload), lastEventId: String(payload.seq) });
    }
  }

  emitError(): void {
    // A real EventSource that intends to reconnect drops to CONNECTING.
    this.readyState = 0;
    this.onerror?.({});
  }
}

function tick(seq: number, value: number, change: number) {
  return { seq, time: `2026-09-28T09:00:${String(seq).padStart(2, '0')}Z`, value, change };
}

function mount(): FakeEventSource {
  const count = FakeEventSource.instances.length;
  render(<SseTickerDemo />);
  const source = FakeEventSource.instances[count];
  if (source === undefined) throw new Error('EventSource was not constructed by the demo');
  return source;
}

function lastSource(): FakeEventSource {
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (source === undefined) throw new Error('no EventSource instance recorded');
  return source;
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe('SseTickerDemo — EventSource against the real ticker shape', () => {
  it('connects with intervalMs, opens, and renders ticks: value, change, seq', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const source = mount();

    // Default speed is 500ms; the connection URL carries the clamp-able param.
    expect(source.url).toContain('/api/demo/realtime/ticker?intervalMs=500');
    // Opening is asynchronous (the fake defers like the browser does).
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-status')).toHaveTextContent('open · readyState 1');
    });

    source.emitTick(tick(1, 100.5, 0.5));
    source.emitTick(tick(2, 101.25, 0.75));
    source.emitTick(tick(3, 99.75, -1.5));

    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-value')).toHaveTextContent('99.75');
    });
    expect(screen.getByTestId('sse-change')).toHaveTextContent('-1.50');
    expect(screen.getByTestId('sse-seq')).toHaveTextContent('seq 3');
    expect(screen.getByTestId('sse-seq')).toHaveTextContent('id 3');
    expect(screen.getByTestId('sse-count')).toHaveTextContent('3 events received');
    // A falling tick renders in the error tone; the count rides the badge row.
    expect(screen.getByTestId('sse-value').className).toContain('text-error');
  });

  it('grows the sparkline polyline as ticks arrive', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const source = mount();
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-status')).toHaveTextContent('open');
    });

    const line = screen.getByTestId('sse-sparkline-line');
    expect(line.getAttribute('points')).toBe('');

    source.emitTick(tick(1, 100, 0));
    source.emitTick(tick(2, 101, 1));
    await vi.waitFor(() => {
      expect((line.getAttribute('points') ?? '').split(' ')).toHaveLength(2);
    });

    source.emitTick(tick(3, 100.5, -0.5));
    source.emitTick(tick(4, 102, 1.5));
    await vi.waitFor(() => {
      expect((line.getAttribute('points') ?? '').split(' ')).toHaveLength(4);
    });
    // x grows left→right, y stays inside the 0–64 viewBox.
    for (const point of (line.getAttribute('points') ?? '').split(' ')) {
      const [x, y] = point.split(',').map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(300);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(64);
    }
  });

  it('onerror flips the badge to reconnecting — the browser auto-reconnects', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const source = mount();
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-status')).toHaveTextContent('open');
    });

    source.emitError();
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-status')).toHaveTextContent('reconnecting · readyState 0');
    });
    expect(screen.getByTestId('sse-error-count')).toHaveTextContent('1 onerror event');
  });

  it('the speed strip closes the old source and opens a new one with the new intervalMs', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const first = mount();
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-status')).toHaveTextContent('open');
    });

    fireEvent.click(screen.getByTestId('sse-speed-200'));

    expect(first.closed).toBe(true);
    expect(first.readyState).toBe(2);
    const second = lastSource();
    expect(second.url).toContain('intervalMs=200');
    expect(second).not.toBe(first);
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-status')).toHaveTextContent('connecting');
    });
  });

  it('the reconnect button opens a FRESH stream and marks the skipped seqs', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const first = mount();
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-status')).toHaveTextContent('open');
    });
    for (let seq = 1; seq <= 3; seq += 1) first.emitTick(tick(seq, 100 + seq, 1));
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-count')).toHaveTextContent('3 events');
    });

    fireEvent.click(screen.getByTestId('sse-reconnect'));

    // The manual reopen: old source explicitly closed, a NEW EventSource,
    // and the honest note about Last-Event-ID is on the page.
    expect(first.closed).toBe(true);
    const second = lastSource();
    expect(second.url).toContain('intervalMs=500');
    expect(screen.getByTestId('sse-manual-reconnects')).toHaveTextContent('1 manual reopen');
    expect(screen.getByTestId('sse-note')).toHaveTextContent('Last-Event-ID');

    // The fresh stream resumes at "now" — a seq the old stream never saw:
    second.emitTick(tick(12, 105, 0.5));
    await vi.waitFor(() => {
      expect(screen.getByTestId('sse-seq')).toHaveTextContent('seq 12');
    });
    // And the gap between the retained ticks is surfaced as skipped seqs.
    expect(screen.getByTestId('sse-gap')).toHaveTextContent('skipped');
  });

  it('closes the EventSource on unmount — no leaked streams', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const { unmount } = render(<SseTickerDemo />);
    const source = lastSource();
    expect(source.closed).toBe(false);

    unmount();
    // The effect's cleanup ran: the stream is closed, readyState CLOSED.
    expect(source.closed).toBe(true);
    expect(source.readyState).toBe(2);
  });
});
