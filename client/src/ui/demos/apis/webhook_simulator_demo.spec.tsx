import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import WebhookSimulatorDemo from './webhook_simulator_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DELIVERIES_URL = '/api/demo/webhooks/deliveries';
const SEND_URL = '/api/demo/webhooks/send';
const SEND_TAMPER_URL = '/api/demo/webhooks/send?tamper=1';

const SIGNATURE = 'be686a7bdc3043bdac918f9bc9c02561bc59663e44627b923b16b4a15a091cbf';

function sendResponseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: { id: '7c9e6679-7425-40de-944b-e07fc7f90ae7', type: 'post.created', created: '2026-09-28T19:00:00.000Z', data: {} },
    signature: SIGNATURE,
    signatureAlgorithm: 'hmac-sha256, hex-encoded, over the exact request body bytes',
    tampered: false,
    wouldDeliver: {
      url: 'http://127.0.0.1:4000/api/demo/webhooks/receive',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': SIGNATURE, 'x-webhook-timestamp': '1798848000' },
      body: '{"id":"7c9e6679-7425-40de-944b-e07fc7f90ae7","type":"post.created"}',
    },
    delivered: true,
    outcome: { status: 202, body: '{"accepted":true}' },
    ...overrides,
  };
}

function deliveryBody(index: number): Record<string, unknown> {
  return {
    id: `del_${String(index)}`,
    receivedAt: '2026-09-28T19:00:0' + String(index) + '.000Z',
    type: 'post.created',
    signatureVerified: true,
    payload: { id: `evt_${String(index)}`, type: 'post.created', data: { post: { title: 'Webhooks are reversed APIs' } } },
  };
}

interface MethodRoute {
  method: string;
  url: string;
  body?: unknown;
}

/**
 * Method-aware fetch double with per-route sequencing (the inbox GET must
 * answer differently before and after a send): duplicate (method, url) routes
 * are consumed in order, the last one is sticky — same shape the posts
 * workbench spec uses.
 */
function stubMethodFetch(routes: readonly MethodRoute[]): ReturnType<typeof vi.fn> {
  const remaining = routes.map((route) => ({ ...route, consumed: false }));
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const matches = remaining.filter((route) => route.method === method && route.url === url);
    if (matches.length === 0) {
      return jsonResponse({ error: { code: 'not_found', message: `no fetch stub for ${method} ${url}` } }, 404);
    }
    const route = matches.find((candidate) => !candidate.consumed) ?? matches[matches.length - 1]!;
    route.consumed = true;
    return jsonResponse(route.body, 200);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function jsonResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('WebhookSimulatorDemo — the happy flight', () => {
  it('sends an event, renders the flight (event + signature + delivery), and refreshes the verified inbox', async () => {
    const fetchMock = (() => {
      stubMethodFetch([
        { method: 'GET', url: DELIVERIES_URL, body: { deliveries: [] } }, // mount: empty
        { method: 'POST', url: SEND_URL, body: sendResponseBody() },
        { method: 'GET', url: DELIVERIES_URL, body: { deliveries: [deliveryBody(1)] } }, // after send
      ]);
      return vi.mocked(fetch);
    })();

    render(<WebhookSimulatorDemo />);

    // Inbox loads empty first.
    expect(await screen.findByTestId('webhook-simulator-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('webhook-simulator-send'));

    const flight = await screen.findByTestId('webhook-simulator-flight');
    expect(flight).toHaveTextContent('post.created');
    expect(screen.getByTestId('webhook-simulator-signature')).toHaveTextContent(SIGNATURE);
    expect(screen.getByTestId('webhook-simulator-outcome-status')).toHaveTextContent('202');
    expect(flight).toHaveTextContent('delivered');

    // The POST went out bare (no query params for the default type).
    const sendCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).startsWith(SEND_URL),
    );
    expect(sendCall?.[0]).toBe(SEND_URL);
    expect((sendCall?.[1] as RequestInit | undefined)?.method).toBe('POST');

    // After the send, the inbox refreshed and shows the verified delivery.
    const deliveries = await screen.findAllByTestId('webhook-simulator-delivery');
    expect(deliveries).toHaveLength(1);
    expect(screen.getAllByTestId('webhook-simulator-verified-badge')[0]).toHaveTextContent('signature verified');
    expect(deliveries[0]).toHaveTextContent('Webhooks are reversed APIs');

    // The default (post.created) flight carries no tamper note.
    expect(screen.queryByTestId('webhook-simulator-tamper-note')).not.toBeInTheDocument();
  });

  it('honours the event-type select by sending ?type=post.updated', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: DELIVERIES_URL, body: { deliveries: [deliveryBody(1)] } },
        {
          url: '/api/demo/webhooks/send?type=post.updated',
          body: sendResponseBody({ event: { id: 'evt-2', type: 'post.updated' } }),
        },
      ]);
      return vi.mocked(fetch);
    })();

    render(<WebhookSimulatorDemo />);
    await screen.findByTestId('webhook-simulator-delivery');

    fireEvent.change(screen.getByTestId('webhook-simulator-type'), { target: { value: 'post.updated' } });
    fireEvent.click(screen.getByTestId('webhook-simulator-send'));

    const flight = await screen.findByTestId('webhook-simulator-flight');
    expect(flight).toHaveTextContent('post.updated');
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/demo/webhooks/send?type=post.updated')).toBe(true);
  });
});

describe('WebhookSimulatorDemo — the tampered flight', () => {
  it('shows the 401 rejection and the tamper note, and the inbox does not grow', async () => {
    stubApiFetch([
      { url: DELIVERIES_URL, body: { deliveries: [deliveryBody(1)] } },
      {
        url: SEND_TAMPER_URL,
        body: sendResponseBody({
          tampered: true,
          signature: 'a'.repeat(64),
          tamperNote: 'signed with the WRONG secret on purpose — expect the receiver to answer 401',
          outcome: { status: 401, body: '{"error":{"code":"unauthorized","reason":"invalid_signature"}}' },
        }),
      },
    ]);

    render(<WebhookSimulatorDemo />);
    await screen.findByTestId('webhook-simulator-delivery');

    fireEvent.click(screen.getByTestId('webhook-simulator-tamper'));
    fireEvent.click(screen.getByTestId('webhook-simulator-send'));

    const flight = await screen.findByTestId('webhook-simulator-flight');
    expect(flight).toHaveTextContent('rejected 401');
    expect(screen.getByTestId('webhook-simulator-outcome-status')).toHaveTextContent('401');
    expect(screen.getByTestId('webhook-simulator-tamper-note')).toHaveTextContent('WRONG secret');
    expect(screen.getByTestId('webhook-simulator-signature')).toHaveTextContent(/^a{64}$/);

    // The inbox refresh ran but still holds exactly the pre-tamper delivery.
    expect(await screen.findAllByTestId('webhook-simulator-delivery')).toHaveLength(1);
  });
});

describe('WebhookSimulatorDemo — failure and recovery states', () => {
  it('renders an inbox failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<WebhookSimulatorDemo />);

    const failed = await screen.findByTestId('webhook-simulator-inbox-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });

  it('renders a send failure state when the send endpoint is unreachable', async () => {
    stubApiFetch([{ url: DELIVERIES_URL, body: { deliveries: [] } }]);

    render(<WebhookSimulatorDemo />);
    await screen.findByTestId('webhook-simulator-empty');

    fireEvent.click(screen.getByTestId('webhook-simulator-send'));

    const failed = await screen.findByTestId('webhook-simulator-send-failed');
    expect(failed).toHaveTextContent('no fetch stub for /api/demo/webhooks/send');
  });

  it('re-renders the inbox from the refresh button', async () => {
    stubApiFetch([{ url: DELIVERIES_URL, body: { deliveries: [deliveryBody(1), deliveryBody(2)] } }]);

    render(<WebhookSimulatorDemo />);
    await screen.findAllByTestId('webhook-simulator-delivery');

    fireEvent.click(screen.getByTestId('webhook-simulator-refresh'));
    expect(await screen.findAllByTestId('webhook-simulator-delivery')).toHaveLength(2);
  });
});
