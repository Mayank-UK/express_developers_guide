import http from 'node:http';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { attachChatHub, CHAT_WS_PATH, type ChatHub } from './chat_hub.js';

/**
 * The chat hub exercised with REAL ws clients: a bare http server on an
 * ephemeral port serving createApp() (so the chat-status sidecar works),
 * with attachChatHub wiring the upgrade router — exactly the production
 * wiring from server.ts. Upgrades bypass Express entirely; these tests
 * prove that split works.
 */

interface ChatEnvelope {
  type: 'chat' | 'system' | 'history' | 'error';
  payload: Record<string, unknown>;
}

let server: http.Server;
let hub: ChatHub;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  server = http.createServer(createApp());
  hub = attachChatHub(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected ephemeral port');
  const port = String(address.port);
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await hub.close().catch(() => undefined);
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** One connected client recording every envelope the hub sends it. */
class Client {
  readonly socket: WebSocket;
  readonly envelopes: ChatEnvelope[] = [];
  private readonly opened: Promise<void>;
  /** Resolves with the close code + reason when the server closes the socket. */
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(username: string) {
    this.socket = new WebSocket(`${wsUrl}${CHAT_WS_PATH}?username=${encodeURIComponent(username)}`);
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.closed = new Promise((resolve) => {
      this.socket.once('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString() }),
      );
    });
    this.socket.on('message', (raw: WebSocket.RawData) => {
      this.envelopes.push(JSON.parse(raw.toString()) as ChatEnvelope);
    });
  }

  async join(): Promise<void> {
    await this.opened;
    // The history envelope is the first frame every new client receives.
    await this.waitFor((envelope) => envelope.type === 'history');
  }

  send(raw: string): void {
    this.socket.send(raw);
  }

  sendChat(text: string): void {
    this.send(JSON.stringify({ type: 'chat', text }));
  }

  waitFor(predicate: (envelope: ChatEnvelope) => boolean, timeoutMs = 3000): Promise<ChatEnvelope> {
    const found = this.envelopes.find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = (): void => {
        const match = this.envelopes.find(predicate);
        if (match !== undefined) {
          resolve(match);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`envelope not received within ${String(timeoutMs)}ms — got: ${JSON.stringify(this.envelopes)}`));
          return;
        }
        setTimeout(tick, 25);
      };
      setTimeout(tick, 25);
    });
  }

  close(): Promise<{ code: number; reason: string }> {
    this.socket.close();
    return this.closed;
  }
}

async function chatStatus(): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/demo/realtime/chat-status`);
  return (await response.json()) as Record<string, unknown>;
}

/** Poll the sidecar until the predicate holds — disconnects settle asynchronously. */
async function waitStatus(predicate: (status: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  for (;;) {
    const status = await chatStatus();
    if (predicate(status)) return status;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`chat-status condition not met — last: ${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the chat hub over real WebSocket clients', () => {
  it('two clients join: history replay, join notices, and a broadcast both receive', async () => {
    const alice = new Client('alice');
    await alice.join();
    // The room was empty: alice's history replay is an empty list.
    expect(alice.envelopes[0]).toMatchObject({ type: 'history', payload: { messages: [] } });

    const bob = new Client('bob');
    await bob.join();
    // bob's join notice goes to everyone EXCEPT bob (he got history instead).
    const joinNotice = await alice.waitFor((envelope) => envelope.type === 'system');
    expect(joinNotice.payload).toMatchObject({ kind: 'join', text: 'bob joined' });

    // One chat frame in → the SAME {type:'chat'} envelope out to every client.
    alice.sendChat('hello bob');
    const alicesEcho = await alice.waitFor((envelope) => envelope.type === 'chat');
    const bobsCopy = await bob.waitFor((envelope) => envelope.type === 'chat');
    expect(alicesEcho.payload).toMatchObject({ from: 'alice', text: 'hello bob' });
    expect(bobsCopy.payload).toEqual(alicesEcho.payload);
    expect(typeof bobsCopy.payload.id).toBe('string');
    expect(typeof bobsCopy.payload.at).toBe('string');

    const status = await chatStatus();
    expect(status).toMatchObject({ attached: true, connections: 2, messagesSent: 1 });

    // Leave: everyone remaining sees the notice, the counter drops.
    await bob.close();
    const leaveNotice = await alice.waitFor(
      (envelope) => envelope.type === 'system' && envelope.payload.kind === 'leave',
    );
    expect(leaveNotice.payload).toMatchObject({ text: 'bob left' });
    const settled = await waitStatus((s) => s.connections === 1);
    expect(settled.connections).toBe(1);

    // A THIRD client gets the earlier chat replayed as history.
    const carol = new Client('carol');
    await carol.join();
    const history = carol.envelopes[0];
    expect(history.type).toBe('history');
    const messages = (history.payload as { messages: Array<{ from: string; text: string }> }).messages;
    expect(messages.some((message) => message.from === 'alice' && message.text === 'hello bob')).toBe(true);

    await carol.close();
    await alice.close();
    await waitStatus((s) => s.connections === 0);
  }, 10_000);

  it('a garbage frame never kills the hub — the sender gets an error envelope, chat continues', async () => {
    const alice = new Client('alice');
    await alice.join();
    const bob = new Client('bob');
    await bob.join();

    // Not JSON at all:
    alice.send('this is not json');
    // JSON but not an object:
    alice.send('"still wrong"');
    // An object, but a type the hub does not speak:
    alice.send(JSON.stringify({ type: 'shout', text: 'HELLO' }));
    // A chat with no text:
    alice.send(JSON.stringify({ type: 'chat', text: '   ' }));

    // Every failure answers the SENDER with an error envelope (four frames),
    // each carrying a human message — never a crash, never a broadcast.
    await alice.waitFor((envelope) => envelope.type === 'error');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const errorEnvelopes = alice.envelopes.filter((envelope) => envelope.type === 'error');
    expect(errorEnvelopes.length).toBeGreaterThanOrEqual(4);
    for (const error of errorEnvelopes) {
      expect(typeof (error.payload as { message: string }).message).toBe('string');
    }

    // …and the hub is still fully alive for everyone:
    alice.sendChat('still here');
    await bob.waitFor((envelope) => envelope.type === 'chat' && (envelope.payload as { text: string }).text === 'still here');

    await alice.close();
    await bob.close();
    await waitStatus((s) => s.connections === 0);
  }, 10_000);

  it('sanitizes usernames: control characters stripped, length capped, guests generated', async () => {
    const longName = 'x'.repeat(200);
    const alice = new Client(longName);
    await alice.join();

    const bob = new Client(''); // empty username → the guest-… fallback
    await bob.join();

    alice.sendChat('from the capped one');
    const received = await bob.waitFor((envelope) => envelope.type === 'chat');
    expect((received.payload as { from: string }).from.length).toBeLessThanOrEqual(32);

    // The guest name is non-empty and prefixed:
    bob.sendChat('guest here');
    const guestMessage = await alice.waitFor(
      (envelope) =>
        envelope.type === 'chat' && (envelope.payload as { text: string }).text === 'guest here',
    );
    expect((guestMessage.payload as { from: string }).from).toMatch(/^guest-/);

    await alice.close();
    await bob.close();
    await waitStatus((s) => s.connections === 0);
  }, 10_000);

  it('caps chat text at 500 characters (trimmed first)', async () => {
    const alice = new Client('alice');
    await alice.join();
    const bob = new Client('bob');
    await bob.join();

    alice.sendChat(`${'y'.repeat(600)}`);
    const received = await bob.waitFor((envelope) => envelope.type === 'chat');
    expect((received.payload as { text: string }).text.length).toBe(500);

    await alice.close();
    await bob.close();
    await waitStatus((s) => s.connections === 0);
  }, 10_000);

  it('declines upgrades to any path that is not the chat endpoint', async () => {
    await new Promise<void>((resolve, reject) => {
      const stray = new WebSocket(`${wsUrl}/api/demo/realtime/some-other-socket`);
      stray.once('open', () => reject(new Error('non-chat upgrade must not open')));
      stray.once('error', (err: Error) => {
        expect(err.message).toContain('404');
        resolve();
      });
      setTimeout(() => reject(new Error('no error arrived for the stray upgrade')), 3000);
    });
    // The hub registry is untouched by the declined upgrade:
    expect((await chatStatus()).connections).toBe(0);
  }, 10_000);

  it('hub.close() closes every connected client with a going-away code', async () => {
    const alice = new Client('alice');
    await alice.join();
    const bob = new Client('bob');
    await bob.join();

    const [aliceClosed, bobClosed] = await Promise.all([alice.closed, bob.closed, hub.close()]);

    expect(aliceClosed.code).toBe(1001);
    expect(bobClosed.code).toBe(1001);
    expect(hub.stats()).toMatchObject({ connections: 0 });
  }, 10_000);
});
