import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PiiErasureDemo from './pii_erasure_demo';
import { stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * jsdom talks to a stateful stand-in for the PII store that mirrors
 * security_pii_demo_routes.ts: the seeded customers/orders, the export
 * document, crypto-shred anonymization (row kept, PII replaced by anon_
 * placeholders), the idempotent second erasure, and the erasure log. The
 * server spec pins the LIVE contract (no PII byte survives in the raw store);
 * here we prove the workflow renders it, confirmation and all.
 */

const CUSTOMERS_URL = '/api/demo/security/pii/customers';
const ERASURE_LOG_URL = '/api/demo/security/pii/erasure-log';

interface StubCustomer {
  id: string;
  name: string;
  email: string;
  anonymizedAt: string | null;
}

interface StubOrder {
  id: string;
  customerId: string;
  totalCents: number;
}

function jsonLike(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (): string | null => null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

const SEED_CUSTOMERS: StubCustomer[] = [
  { id: 'cust_1', name: 'Fatima Nasser', email: 'fatima.nasser@example.com', anonymizedAt: null },
  { id: 'cust_2', name: 'Kenji Watanabe', email: 'kenji.w@example.com', anonymizedAt: null },
  { id: 'cust_3', name: 'Priya Sharma', email: 'priya.sharma@example.com', anonymizedAt: null },
  { id: 'cust_4', name: 'Lukas Weber', email: 'lukas.weber@example.com', anonymizedAt: null },
];

const SEED_ORDERS: StubOrder[] = [
  { id: 'ord_1001', customerId: 'cust_1', totalCents: 4999 },
  { id: 'ord_1002', customerId: 'cust_1', totalCents: 12900 },
  { id: 'ord_1003', customerId: 'cust_2', totalCents: 7550 },
  { id: 'ord_1004', customerId: 'cust_3', totalCents: 2100 },
  { id: 'ord_1005', customerId: 'cust_3', totalCents: 6800 },
  { id: 'ord_1006', customerId: 'cust_4', totalCents: 15250 },
];

const PII_FIELDS = [
  'name',
  'email',
  'phone',
  'address.line1',
  'address.city',
  'address.postalCode',
  'address.country',
];

/** The store: seeded fresh per stub, mutated by anonymize (like the route). */
function stubPiiServer() {
  const customers = SEED_CUSTOMERS.map((customer) => ({ ...customer }));
  const orders = SEED_ORDERS.map((order) => ({ ...order }));
  const erasureLog: Array<{
    customerId: string;
    anonymizedAt: string;
    performedBy: string;
    scope: string[];
    method: string;
    linkedOrdersKept: number;
  }> = [];

  const anon = (customerId: string, field: string): string => {
    let hash = 0;
    const input = `${customerId}:${field}`;
    for (let index = 0; index < input.length; index += 1) hash = (hash * 31 + input.charCodeAt(index)) % 0xffffffff;
    return `anon_${(hash >>> 0).toString(16).padStart(8, '0')}`;
  };

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === CUSTOMERS_URL && method === 'GET') {
      return jsonLike({
        customers: customers.map((customer) => ({
          id: customer.id,
          name: customer.name,
          email: customer.email,
          anonymized: customer.anonymizedAt !== null,
        })),
        erasureCount: erasureLog.length,
        note: 'the fixture population',
      });
    }
    if (url === ERASURE_LOG_URL && method === 'GET') {
      return jsonLike({ entries: [...erasureLog].reverse(), note: 'the accounting record' });
    }
    const exportMatch = /^\/api\/demo\/security\/pii\/export\/(.+)$/.exec(url);
    if (exportMatch !== null && method === 'GET') {
      const customer = customers.find((candidate) => candidate.id === exportMatch[1]);
      if (customer === undefined) {
        return jsonLike({ error: { code: 'not_found', message: `no customer with id "${exportMatch[1]!}"`, requestId: 't' } }, 404);
      }
      return jsonLike({
        exportedAt: '2026-09-29T09:30:00.000Z',
        subject: { id: customer.id, name: customer.name, email: customer.email, anonymizedAt: customer.anonymizedAt },
        linkedOrders: orders.filter((order) => order.customerId === customer.id),
        erasureRecord: erasureLog.find((entry) => entry.customerId === customer.id) ?? null,
        note: 'the right-of-access dump',
      });
    }
    const anonymizeMatch = /^\/api\/demo\/security\/pii\/anonymize\/(.+)$/.exec(url);
    if (anonymizeMatch !== null && method === 'POST') {
      const customer = customers.find((candidate) => candidate.id === anonymizeMatch[1]);
      if (customer === undefined) {
        return jsonLike({ error: { code: 'not_found', message: `no customer with id "${anonymizeMatch[1]!}"`, requestId: 't' } }, 404);
      }
      if (customer.anonymizedAt !== null) {
        return jsonLike({
          alreadyAnonymized: true,
          anonymizedAt: customer.anonymizedAt,
          customerId: customer.id,
          note: 'this row is already shredded — erasure is idempotent',
        });
      }
      customer.name = anon(customer.id, 'name');
      customer.email = `${anon(customer.id, 'email')}@erased.invalid`;
      customer.anonymizedAt = '2026-09-29T09:31:00.000Z';
      const linkedOrdersKept = orders.filter((order) => order.customerId === customer.id).length;
      erasureLog.push({
        customerId: customer.id,
        anonymizedAt: customer.anonymizedAt,
        performedBy: 'gdpr-erasure-demo',
        scope: [...PII_FIELDS],
        method: 'crypto-shred placeholders; row + foreign keys kept (order history survives)',
        linkedOrdersKept,
      });
      return jsonLike({
        anonymized: true,
        customer: { id: customer.id, name: customer.name, email: customer.email, anonymizedAt: customer.anonymizedAt },
        linkedOrdersKept,
        note: 'the ROW stays (orders still resolve, totals still add up); the PII is gone',
      });
    }
    const readMatch = /^\/api\/demo\/security\/pii\/customers\/(.+)$/.exec(url);
    if (readMatch !== null && method === 'GET') {
      const customer = customers.find((candidate) => candidate.id === readMatch[1]);
      if (customer === undefined) {
        return jsonLike({ error: { code: 'not_found', message: `no customer with id "${readMatch[1]!}"`, requestId: 't' } }, 404);
      }
      return jsonLike({
        customer: { id: customer.id, name: customer.name, email: customer.email, anonymizedAt: customer.anonymizedAt },
        orders: orders.filter((order) => order.customerId === customer.id),
        note:
          customer.anonymizedAt === null
            ? 'PII present — this is the pre-erasure state'
            : 'erased 2026-09-29T09:31:00.000Z — the row and its order links survive; the identity does not',
      });
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${method} ${url}` } }, 404);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const postCalls = (fetchMock: ReturnType<typeof stubPiiServer>): number =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length;

describe('PiiErasureDemo — access, erasure, accounting', () => {
  it('renders the four fixture customers with a zeroed erasure count and the empty log state', async () => {
    vi.stubGlobal('fetch', stubPiiServer());
    render(<PiiErasureDemo />);

    const rows = await screen.findAllByTestId('pii-customer-row');
    expect(rows.length).toBe(4);
    expect(screen.getByTestId('pii-erasure-count')).toHaveTextContent('erasures logged: 0');
    expect(screen.getByText('Fatima Nasser')).toBeDefined();
    expect(screen.getByText('kenji.w@example.com')).toBeDefined();

    await screen.findByTestId('pii-erasure-log');
    expect(screen.getByTestId('pii-log-empty')).toHaveTextContent('no erasures yet');
  });

  it('EXPORT renders the right-of-access document: subject, linked orders, erasure record', async () => {
    vi.stubGlobal('fetch', stubPiiServer());
    render(<PiiErasureDemo />);

    await screen.findAllByTestId('pii-customer-row');
    fireEvent.click(screen.getByTestId('pii-export-cust_1'));

    const result = await screen.findByTestId('pii-export-result');
    expect(result).toHaveTextContent('fatima.nasser@example.com');
    expect(result).toHaveTextContent('ord_1001');
    expect(result).toHaveTextContent('ord_1002');
    // "Everything" includes the other tables — an export that forgets the
    // orders fails the audit.
    expect(result).toHaveTextContent('linkedOrders');
    expect(result).toHaveTextContent('"erasureRecord": null');
  });

  it('anonymize needs the confirmation click; then the row survives with anon_ PII, orders kept, and the log gains the entry', async () => {
    const fetchMock = stubPiiServer();
    vi.stubGlobal('fetch', fetchMock);
    render(<PiiErasureDemo />);

    await screen.findAllByTestId('pii-customer-row');

    // Step 1: the first click only arms the confirmation — no POST leaves.
    fireEvent.click(screen.getByTestId('pii-anonymize-cust_1'));
    expect(screen.getByTestId('pii-confirm-cust_1')).toHaveTextContent('CONFIRM ERASURE');
    expect(screen.getByTestId('pii-cancel-cust_1')).toBeDefined();
    expect(postCalls(fetchMock)).toBe(0);

    // Cancel disarms it without side effects.
    fireEvent.click(screen.getByTestId('pii-cancel-cust_1'));
    expect(screen.queryByTestId('pii-confirm-cust_1')).toBeNull();
    expect(postCalls(fetchMock)).toBe(0);

    // Step 2: arm again, then CONFIRM — the POST fires.
    fireEvent.click(screen.getByTestId('pii-anonymize-cust_1'));
    fireEvent.click(screen.getByTestId('pii-confirm-cust_1'));
    expect(postCalls(fetchMock)).toBe(1);

    const result = await screen.findByTestId('pii-anonymize-result');
    expect(result).toHaveTextContent('ANONYMIZED');
    expect(screen.getByTestId('pii-anon-name').textContent).toMatch(/^name → anon_[0-9a-f]{8}$/);
    expect(screen.getByTestId('pii-anon-email').textContent).toMatch(/@erased\.invalid$/);
    expect(screen.getByTestId('pii-orders-kept')).toHaveTextContent('2 order links kept');

    // Read-after: the anonymized row still resolves its order links.
    expect(await screen.findByTestId('pii-read-after-orders')).toHaveTextContent('2 orders still resolve');
    expect(screen.getByTestId('pii-read-after')).toHaveTextContent('the row and its order links survive');

    // The erasure log gains exactly one accounting entry for cust_1.
    const entries = await screen.findAllByTestId('pii-erasure-entry');
    expect(entries.length).toBe(1);
    expect(entries[0]).toHaveTextContent('cust_1');
    expect(entries[0]).toHaveTextContent('gdpr-erasure-demo');
    expect(entries[0]).toHaveTextContent('7 fields');
    expect(screen.getByTestId('pii-entry-orders')).toHaveTextContent('2 links kept');

    // The list refresh: the ROW survived, its PII state flipped.
    await waitFor(() => {
      expect(screen.getByTestId('pii-anonymized-chip-cust_1')).toHaveTextContent('anonymized');
    });
    expect(screen.getByTestId('pii-erasure-count')).toHaveTextContent('erasures logged: 1');
    expect(screen.getByText('Kenji Watanabe')).toBeDefined();
  });

  it('degrades to the reachable-server message, never a crash', async () => {
    stubNetworkFailure();
    render(<PiiErasureDemo />);

    expect(await screen.findByTestId('pii-customers-failed')).toHaveTextContent(
      'could not reach the server',
    );
    expect(screen.getByTestId('pii-summary')).toBeDefined();
  });
});
