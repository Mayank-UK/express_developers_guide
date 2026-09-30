import { createHash } from 'node:crypto';
import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';

/**
 * The security topic's PII / GDPR-style ERASURE POLICY — extracted from the
 * demo routes on purpose: crypto-shred, placeholder shape, idempotency, and
 * the erasure log are BUSINESS RULES (what must hold about a deletion), not
 * HTTP concerns. The route file (security_pii_demo_routes.ts) only parses
 * input, calls this service, and maps the Result onto responses — business
 * logic belongs in the domain, and that layering IS part of the lesson.
 *
 * The store is an injected PORT (PiiErasureStore): the seeded in-memory
 * implementation below serves the demo; a SQL-backed implementation would
 * satisfy the same interface with one UPDATE + one INSERT, and this policy
 * would not change by a line.
 */

// --- the demo's data shapes --------------------------------------------------------

export interface DemoCustomer {
  readonly id: string;
  name: string;
  email: string;
  phone: string;
  address: Record<'line1' | 'city' | 'postalCode' | 'country', string>;
  readonly createdAt: string;
  anonymizedAt: string | null;
}

export interface DemoOrder {
  readonly id: string;
  /** The FK that must SURVIVE erasure — orders outlive identities. */
  readonly customerId: string;
  readonly totalCents: number;
  readonly placedAt: string;
}

export interface ErasureLogEntry {
  readonly customerId: string;
  readonly anonymizedAt: string;
  readonly performedBy: string;
  readonly scope: readonly string[];
  readonly method: string;
  readonly linkedOrdersKept: number;
}

/** The PII-bearing fields the anonymizer overwrites (scope, stated up front). */
const PII_FIELDS = [
  'name',
  'email',
  'phone',
  'address.line1',
  'address.city',
  'address.postalCode',
  'address.country',
] as const;

/** Deterministic, clearly-fake placeholder: anon_<first 8 hex of sha256(id:field)>. */
function anonPlaceholder(customerId: string, field: string): string {
  return `anon_${createHash('sha256').update(`${customerId}:${field}`, 'utf8').digest('hex').slice(0, 8)}`;
}

// --- the port ----------------------------------------------------------------------

/**
 * Everything the erasure policy needs from persistence. `findCustomer`
 * returns the LIVE row (the in-memory demo store hands out its own object)
 * so the shred below overwrites it in place — a SQL implementation would
 * issue one UPDATE instead, and the policy would read the same.
 */
export interface PiiErasureStore {
  findCustomer(customerId: string): DemoCustomer | undefined;
  countLinkedOrders(customerId: string): number;
  recordErasure(entry: ErasureLogEntry): void;
}

// --- the use case ------------------------------------------------------------------

/** What an erasure request produced: a fresh shred, or proof one already held. */
export type ErasureOutcome =
  | { readonly alreadyAnonymized: true; readonly anonymizedAt: string; readonly customerId: string }
  | {
      readonly alreadyAnonymized: false;
      readonly customer: DemoCustomer;
      readonly linkedOrdersKept: number;
    };

export class PiiErasureService {
  private readonly store: PiiErasureStore;

  constructor(store: PiiErasureStore) {
    this.store = store;
  }

  /**
   * The right-of-erasure use case: crypto-shred every PII field, KEEP the row
   * and its foreign keys (order history survives), and account for the act in
   * the erasure log. Idempotent-friendly — a second erasure of an
   * already-anonymous row is not an error, and does not log twice.
   */
  anonymizeCustomer(customerId: string): Result<ErasureOutcome, Failure> {
    const customer = this.store.findCustomer(customerId);
    if (customer === undefined) {
      return fail(failure('not_found', `no customer with id "${customerId}"`, { customerId }));
    }

    if (customer.anonymizedAt !== null) {
      return ok({
        alreadyAnonymized: true,
        anonymizedAt: customer.anonymizedAt,
        customerId: customer.id,
      });
    }

    // CRYPTO-SHRED: overwrite every PII field with its one-way placeholder.
    customer.name = anonPlaceholder(customer.id, 'name');
    customer.email = `${anonPlaceholder(customer.id, 'email')}@erased.invalid`;
    customer.phone = anonPlaceholder(customer.id, 'phone');
    customer.address = {
      line1: anonPlaceholder(customer.id, 'address.line1'),
      city: anonPlaceholder(customer.id, 'address.city'),
      postalCode: anonPlaceholder(customer.id, 'address.postalCode'),
      country: anonPlaceholder(customer.id, 'address.country'),
    };
    const anonymizedAt = new Date().toISOString();
    customer.anonymizedAt = anonymizedAt;

    const linkedOrdersKept = this.store.countLinkedOrders(customer.id);
    this.store.recordErasure({
      customerId: customer.id,
      anonymizedAt,
      performedBy: 'gdpr-erasure-demo',
      scope: [...PII_FIELDS],
      method: 'crypto-shred placeholders; row + foreign keys kept (order history survives)',
      linkedOrdersKept,
    });

    return ok({ alreadyAnonymized: false, customer, linkedOrdersKept });
  }
}

// --- the seeded in-memory store (the exhibit's fixture) -----------------------------

/**
 * The demo store: the erasure PORT plus the read surface the exhibit's GET
 * endpoints (customers / read / export / erasure-log) present. In-memory,
 * seeded like every demo fixture — the LESSON is the data lifecycle, not the
 * database.
 */
export interface PiiDemoStore extends PiiErasureStore {
  listCustomers(): readonly DemoCustomer[];
  ordersFor(customerId: string): readonly DemoOrder[];
  erasureEntries(): readonly ErasureLogEntry[];
  erasureEntryFor(customerId: string): ErasureLogEntry | undefined;
  /** Live arrays for the raw deep-scan test hook (JSON-stringified by the caller). */
  snapshot(): {
    customers: readonly DemoCustomer[];
    orders: readonly DemoOrder[];
    erasureLog: readonly ErasureLogEntry[];
  };
}

export function createSeededPiiDemoStore(): PiiDemoStore {
  const customers = seedCustomers();
  const orders = seedOrders();
  const erasureLog: ErasureLogEntry[] = [];

  return {
    findCustomer: (customerId) => customers.find((candidate) => candidate.id === customerId),
    countLinkedOrders: (customerId) => orders.filter((order) => order.customerId === customerId).length,
    recordErasure: (entry) => {
      erasureLog.push(entry);
    },
    listCustomers: () => customers,
    ordersFor: (customerId) => orders.filter((order) => order.customerId === customerId),
    erasureEntries: () => erasureLog,
    erasureEntryFor: (customerId) => erasureLog.find((entry) => entry.customerId === customerId),
    snapshot: () => ({ customers, orders, erasureLog }),
  };
}

function seedCustomers(): DemoCustomer[] {
  const createdAt = '2026-09-01T09:00:00.000Z';
  return [
    {
      id: 'cust_1',
      name: 'Fatima Nasser',
      email: 'fatima.nasser@example.com',
      phone: '+1-555-0101',
      address: { line1: '17 Rosewood Lane', city: 'Springfield', postalCode: '62704', country: 'US' },
      createdAt,
      anonymizedAt: null,
    },
    {
      id: 'cust_2',
      name: 'Kenji Watanabe',
      email: 'kenji.w@example.com',
      phone: '+81-3-1234-5678',
      address: { line1: '2-14-1 Shibuya', city: 'Tokyo', postalCode: '150-0002', country: 'JP' },
      createdAt,
      anonymizedAt: null,
    },
    {
      id: 'cust_3',
      name: 'Priya Sharma',
      email: 'priya.sharma@example.com',
      phone: '+91-98765-43210',
      address: { line1: '44 MG Road', city: 'Bengaluru', postalCode: '560001', country: 'IN' },
      createdAt,
      anonymizedAt: null,
    },
    {
      id: 'cust_4',
      name: 'Lukas Weber',
      email: 'lukas.weber@example.com',
      phone: '+49-30-123456',
      address: { line1: 'Kastanienallee 8', city: 'Berlin', postalCode: '10435', country: 'DE' },
      createdAt,
      anonymizedAt: null,
    },
  ];
}

function seedOrders(): DemoOrder[] {
  return [
    { id: 'ord_1001', customerId: 'cust_1', totalCents: 4999, placedAt: '2026-09-03T10:15:00.000Z' },
    { id: 'ord_1002', customerId: 'cust_1', totalCents: 12900, placedAt: '2026-09-10T08:41:00.000Z' },
    { id: 'ord_1003', customerId: 'cust_2', totalCents: 7550, placedAt: '2026-09-05T16:02:00.000Z' },
    { id: 'ord_1004', customerId: 'cust_3', totalCents: 2100, placedAt: '2026-09-12T11:30:00.000Z' },
    { id: 'ord_1005', customerId: 'cust_3', totalCents: 6800, placedAt: '2026-09-18T19:05:00.000Z' },
    { id: 'ord_1006', customerId: 'cust_4', totalCents: 15250, placedAt: '2026-09-21T12:00:00.000Z' },
  ];
}
