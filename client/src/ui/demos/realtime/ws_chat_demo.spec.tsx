import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import WsChatDemo from './ws_chat_demo';

/**
 * jsdom cannot reach a real socket — this spec installs a FAITHFUL fake
 * WebSocket: constructor(url), readyState 0→1 on open, onmessage carrying
 * {data: string}, close() settling at 3, and a sent[] log the assertions
 * read. The hub's real protocol ({type, payload} envelopes) is exercised
 * end-to-end in the SERVER spec against real ws clients.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = 0;
  closed = false;
  sent: string[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  // ---- test-side controls -----------------------------------------------
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverMessage(envelope: unknown): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

function jsonLike(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
  };
}

function stubStatus(status: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonLike(status)),
  );
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (socket === undefined) throw new Error('no fake socket was created');
  return socket;
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe('WsChatDemo — a real-shaped WebSocket client for the chat hub', () => {
  it('fills a guest username and connects to the hub path with it', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    stubStatus({ attached: true, connections: 0, messagesSent: 0, historySize: 0 });
    render(<WsChatDemo />);

    expect((screen.getByTestId('chat-username') as HTMLInputElement).value).toMatch(/^guest-/);
    expect(screen.getByTestId('chat-status')).toHaveTextContent('not connected');

    const before = FakeWebSocket.instances.length;
    fireEvent.click(screen.getByTestId('chat-connect'));
    const socket = FakeWebSocket.instances[before];
    if (socket === undefined) throw new Error('connect did not construct a WebSocket');
    expect(socket.url).toContain('ws://');
    expect(socket.url).toContain('/api/demo/realtime/chat?username=');
    expect(screen.getByTestId('chat-status')).toHaveTextContent('connecting · readyState 0');
  });

  it('history replay renders muted and tagged, then the chip goes open', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    stubStatus({ attached: true, connections: 1, messagesSent: 2, historySize: 2 });
    render(<WsChatDemo />);
    fireEvent.click(screen.getByTestId('chat-connect'));
    const socket = lastSocket();

    socket.serverOpen();
    await waitFor(() => {
      expect(screen.getByTestId('chat-status')).toHaveTextContent('open · readyState 1');
    });

    socket.serverMessage({
      type: 'history',
      payload: {
        messages: [
          { id: 'msg-0', from: 'alice', text: 'earlier wisdom', at: '2026-09-28T09:00:00Z' },
          { id: 'msg-1', from: 'bob', text: 'even earlier', at: '2026-09-28T09:00:01Z' },
        ],
      },
    });

    const historyRows = await screen.findAllByTestId('chat-row-history');
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0]).toHaveTextContent('alice (history): earlier wisdom');
    expect(screen.getByText(/history replay: 2 retained/)).toBeDefined();

    // The stats sidecar renders the hub counters.
    await waitFor(() => {
      expect(screen.getByTestId('chat-stats')).toHaveTextContent('attached');
    });
    expect(screen.getByTestId('chat-stats')).toHaveTextContent('1 connection(s)');
    expect(screen.getByTestId('chat-stats')).toHaveTextContent('2 broadcast');
  });

  it('sending rides the {type:"chat"} envelope; broadcasts append with a name', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    stubStatus({ attached: true, connections: 1, messagesSent: 0, historySize: 0 });
    render(<WsChatDemo />);
    fireEvent.click(screen.getByTestId('chat-connect'));
    const socket = lastSocket();
    socket.serverOpen();
    await waitFor(() => {
      expect(screen.getByTestId('chat-status')).toHaveTextContent('open');
    });

    fireEvent.change(screen.getByTestId('chat-draft'), { target: { value: 'hello room' } });
    fireEvent.click(screen.getByTestId('chat-send'));

    expect(socket.sent).toHaveLength(1);
    const frame = socket.sent[0];
    if (frame === undefined) throw new Error('send was not called with the draft');
    expect(JSON.parse(frame)).toEqual({ type: 'chat', text: 'hello room' });
    expect(screen.getByTestId('chat-draft')).toHaveValue('');

    // The broadcast comes back (the hub echoes to the sender too):
    socket.serverMessage({
      type: 'chat',
      payload: { id: 'msg-9', from: 'guest-aa11', text: 'hello room', at: '2026-09-28T09:00:09Z' },
    });
    const chatRow = await screen.findByTestId('chat-row-chat');
    expect(chatRow).toHaveTextContent('guest-aa11: hello room');

    // A system message renders in its own tone:
    socket.serverMessage({ type: 'system', payload: { kind: 'join', text: 'bob joined', at: 'x' } });
    expect(await screen.findByTestId('chat-row-system')).toHaveTextContent('bob joined');

    // And the hub's error envelopes (garbage frames get answered, not fatal):
    socket.serverMessage({ type: 'error', payload: { message: 'frames must be JSON objects' } });
    expect(await screen.findByTestId('chat-row-error')).toHaveTextContent('frames must be JSON');
  });

  it('disconnect closes the socket and the chip settles at closed', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    stubStatus({ attached: true, connections: 1, messagesSent: 0, historySize: 0 });
    render(<WsChatDemo />);
    fireEvent.click(screen.getByTestId('chat-connect'));
    const socket = lastSocket();
    socket.serverOpen();
    await waitFor(() => {
      expect(screen.getByTestId('chat-status')).toHaveTextContent('open');
    });

    fireEvent.click(screen.getByTestId('chat-disconnect'));

    expect(socket.closed).toBe(true);
    await waitFor(() => {
      expect(screen.getByTestId('chat-status')).toHaveTextContent('closed · readyState 3');
    });
    expect(screen.getByText('— connection closed —')).toBeDefined();
  });

  it('unmount closes the socket — no leaked connections', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    stubStatus({ attached: true, connections: 1, messagesSent: 0, historySize: 0 });
    const { unmount } = render(<WsChatDemo />);
    fireEvent.click(screen.getByTestId('chat-connect'));
    const socket = lastSocket();
    socket.serverOpen();
    await waitFor(() => {
      expect(screen.getByTestId('chat-status')).toHaveTextContent('open');
    });

    unmount();
    expect(socket.closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  it('an unreachable status sidecar degrades to ellipsis, never a crash', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<WsChatDemo />);

    expect(screen.getByTestId('chat-stats')).toHaveTextContent('…');
    expect(screen.getByTestId('chat-summary')).toBeDefined();
  });
});
