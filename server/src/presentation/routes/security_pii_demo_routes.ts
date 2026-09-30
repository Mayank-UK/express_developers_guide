import { Router, type Request, type Response } from 'express';
import { failureToException, NotFoundException } from '../../core/error_handling/exceptions.js';
import {
  createSeededPiiDemoStore,
  PiiErasureService,
  type DemoCustomer,
} from '../../domain/demo/pii_erasure_service.js';

/**
 * The security topic's PII / GDPR-style erasure lab — a sibling of
 * security_demo_routes.ts (same mount path, its own file so both stay
 * readable). In-memory store, seeded like every demo fixture: the LESSON is
 * the data lifecycle, not the database.
 *
 * The erasure POLICY (crypto-shred placeholders, idempotency, the erasure
 * log) lives in domain/demo/pii_erasure_service.ts — business logic belongs
 * in the domain layer; these controllers stay thin (parse → call the service
 * → map Result → HTTP) and keep no rule of their own.
 *
 * The four rights this exhibit makes watchable:
 * - ACCESS:      GET  /export/:id      → everything the store holds about one
 *                                       customer, linked records included.
 * - ERASURE:     POST /anonymize/:id   → crypto-shred: PII fields overwritten
 *                                       with anon_<hash> placeholders, the ROW
 *                                       and its order links KEPT — deleting the
 *                                       row would orphan order history (and
 *                                       break totals, and the auditor's trail).
 * - READ AFTER:  GET  /customers/:id   → the post-erasure state (honest: the
 *                                       account exists, the identity does not).
 * - ACCOUNTING:  GET  /erasure-log     → who was erased, when, what scope.
 */

export const SECURITY_PII_DEMO_MOUNT_PATH = '/api/demo/security';

/** Kept for the spec's typed assertions — the shape itself lives in the domain. */
export type { DemoCustomer } from '../../domain/demo/pii_erasure_service.js';

// --- the exhibit's composition point ---------------------------------------------------

// One seeded store + one service over it. Presentation → domain only: the
// store implementation is demo fixture state, rebuilt by the reset hook below.
let piiStore = createSeededPiiDemoStore();
let erasureService = new PiiErasureService(piiStore);

/** Test hook (and the reset controller's body): reseed to the fixture state. */
export function resetPiiStoreForTests(): void {
  piiStore = createSeededPiiDemoStore();
  erasureService = new PiiErasureService(piiStore);
}

/**
 * Test hook: the raw store, JSON-stringified — so specs can deep-scan EVERY
 * stored byte for surviving PII (nested fields and derived copies included).
 */
export function rawPiiStoreForTests(): string {
  return JSON.stringify(piiStore.snapshot());
}

/** Read-side 404: the GET controllers' only branch — the writes go through the service. */
function requireCustomer(id: string): DemoCustomer {
  const customer = piiStore.findCustomer(id);
  if (customer === undefined) {
    throw new NotFoundException(`no customer with id "${id}"`, { customerId: id });
  }
  return customer;
}

// --- controllers ----------------------------------------------------------------------

function listCustomersController(_req: Request, res: Response): void {
  res.json({
    customers: piiStore.listCustomers().map((customer) => ({
      id: customer.id,
      name: customer.name,
      email: customer.email,
      anonymized: customer.anonymizedAt !== null,
    })),
    erasureCount: piiStore.erasureEntries().length,
    note: 'the fixture population — anonymize one, then watch its row stay while its PII goes',
  });
}

function readCustomerController(req: Request, res: Response): void {
  const customer = requireCustomer(String(req.params.id));
  res.json({
    customer: { ...customer, address: { ...customer.address } },
    orders: piiStore.ordersFor(customer.id),
    note:
      customer.anonymizedAt === null
        ? 'PII present — this is the pre-erasure state'
        : `erased ${customer.anonymizedAt} — the row and its order links survive; the identity does not`,
  });
}

function exportCustomerController(req: Request, res: Response): void {
  // RIGHT OF ACCESS: everything the store can produce about one person, in
  // one machine-readable document. "Everything" is the compliance bar — an
  // export that forgets the orders table fails the audit.
  const customer = requireCustomer(String(req.params.id));
  res.json({
    exportedAt: new Date().toISOString(),
    subject: { ...customer, address: { ...customer.address } },
    linkedOrders: piiStore.ordersFor(customer.id),
    erasureRecord: piiStore.erasureEntryFor(customer.id) ?? null,
    note: 'the right-of-access dump: one person, every record, both states shown honestly',
  });
}

function anonymizeCustomerController(req: Request, res: Response): void {
  // RIGHT OF ERASURE: thin on purpose — the shred, the idempotency call, and
  // the erasure-log entry are the domain service's policy; this controller
  // only maps the Result onto HTTP.
  const result = erasureService.anonymizeCustomer(String(req.params.id));
  if (!result.ok) {
    throw failureToException(result.error);
  }
  if (result.value.alreadyAnonymized) {
    res.json({
      alreadyAnonymized: true,
      anonymizedAt: result.value.anonymizedAt,
      customerId: result.value.customerId,
      note: 'this row is already shredded — erasure is idempotent, and the log keeps exactly one entry',
    });
    return;
  }
  const { customer, linkedOrdersKept } = result.value;
  res.json({
    anonymized: true,
    customer: { ...customer, address: { ...customer.address } },
    linkedOrdersKept,
    note: 'the ROW stays (orders still resolve, totals still add up); the PII is gone — deletion would have orphaned history',
  });
}

function erasureLogController(_req: Request, res: Response): void {
  res.json({
    entries: [...piiStore.erasureEntries()].reverse(),
    note: 'the accounting record: who was erased, when, and what scope — regulators ask for exactly this',
  });
}

function resetPiiStoreController(_req: Request, res: Response): void {
  resetPiiStoreForTests();
  res.json({ reset: true });
}

export const securityPiiDemoRouter = Router();
securityPiiDemoRouter.get('/demo/security/pii/customers', listCustomersController);
securityPiiDemoRouter.get('/demo/security/pii/customers/:id', readCustomerController);
securityPiiDemoRouter.get('/demo/security/pii/export/:id', exportCustomerController);
securityPiiDemoRouter.post('/demo/security/pii/anonymize/:id', anonymizeCustomerController);
securityPiiDemoRouter.get('/demo/security/pii/erasure-log', erasureLogController);
// Unauthenticated wipe of shared demo state — a deliberate DEMO affordance so
// any visitor can restore the fixture; a production endpoint that mutates
// state demands credentials (and an audit trail). Never copy this into prod.
securityPiiDemoRouter.post('/demo/security/pii/reset', resetPiiStoreController);
