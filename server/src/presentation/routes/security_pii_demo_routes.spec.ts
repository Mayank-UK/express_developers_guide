import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  rawPiiStoreForTests,
  resetPiiStoreForTests,
  type DemoCustomer,
} from './security_pii_demo_routes.js';

/**
 * The GDPR-lab endpoints end-to-end through the real app. The load-bearing
 * assertions: the export is COMPLETE (person + linked orders), the anonymizer
 * leaves NO original PII anywhere in the store (deep scan of the raw JSON),
 * the row and its foreign keys SURVIVE, and the erasure log records the act.
 */

const MOUNT = '/api/demo/security/pii';

const ORIGINAL_PII: Record<string, string[]> = {
  cust_1: ['Fatima Nasser', 'fatima.nasser@example.com', '+1-555-0101', '17 Rosewood Lane', 'Springfield', '62704'],
  cust_2: ['Kenji Watanabe', 'kenji.w@example.com', '+81-3-1234-5678', '2-14-1 Shibuya', 'Tokyo', '150-0002'],
};

beforeEach(() => {
  resetPiiStoreForTests();
});

describe('the fixture + GET /customers', () => {
  it('seeds four customers with PII and none anonymized', async () => {
    const res = await request(createApp()).get(`${MOUNT}/customers`);

    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(4);
    expect(res.body.customers[0]).toMatchObject({
      id: 'cust_1',
      name: 'Fatima Nasser',
      email: 'fatima.nasser@example.com',
      anonymized: false,
    });
    expect(res.body.erasureCount).toBe(0);
  });
});

describe('GET /export/:id — the right-of-access dump', () => {
  it('exports the person AND the linked orders (completeness is the bar)', async () => {
    const res = await request(createApp()).get(`${MOUNT}/export/cust_1`);

    expect(res.status).toBe(200);
    expect(res.body.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(res.body.subject).toMatchObject({
      id: 'cust_1',
      name: 'Fatima Nasser',
      email: 'fatima.nasser@example.com',
      phone: '+1-555-0101',
      address: { line1: '17 Rosewood Lane', city: 'Springfield', postalCode: '62704', country: 'US' },
    });
    expect(res.body.linkedOrders).toHaveLength(2);
    expect(res.body.linkedOrders.map((order: { id: string }) => order.id)).toEqual(['ord_1001', 'ord_1002']);
    expect(res.body.erasureRecord).toBeNull(); // not erased yet
  });

  it('the export reflects post-erasure state honestly once anonymized', async () => {
    await request(createApp()).post(`${MOUNT}/anonymize/cust_1`);
    const res = await request(createApp()).get(`${MOUNT}/export/cust_1`);

    expect(res.status).toBe(200);
    expect(String(res.body.subject.name)).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(res.body.linkedOrders).toHaveLength(2); // history outlives identity
    expect(res.body.erasureRecord).toMatchObject({ customerId: 'cust_1' });
  });

  it('answers the 404 envelope for unknown customers', async () => {
    for (const path of ['export/cust_999', 'customers/cust_999']) {
      const res = await request(createApp()).get(`${MOUNT}/${path}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'not_found' });
    }
  });
});

describe('POST /anonymize/:id — crypto-shred, keep the row and its links', () => {
  it('replaces every PII field with anon_ placeholders; NOTHING original survives in the store', async () => {
    const res = await request(createApp()).post(`${MOUNT}/anonymize/cust_1`);
    expect(res.status).toBe(200);
    expect(res.body.anonymized).toBe(true);
    expect(res.body.linkedOrdersKept).toBe(2);

    const customer = res.body.customer as DemoCustomer;
    expect(customer.name).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(customer.email).toMatch(/^anon_[0-9a-f]{8}@erased\.invalid$/);
    expect(customer.phone).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(customer.address.line1).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(customer.address.city).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(customer.address.postalCode).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(customer.address.country).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(customer.anonymizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    // THE DEEP SCAN: every original PII fragment is gone from the ENTIRE
    // store — nested fields, other tables, no derived copies left behind.
    const storeJson = rawPiiStoreForTests();
    for (const fragment of ORIGINAL_PII['cust_1']!) {
      expect(storeJson, `fragment "${fragment}"`).not.toContain(fragment);
    }
    // Bystanders untouched: cust_2's PII is still there, intact.
    for (const fragment of ORIGINAL_PII['cust_2']!) {
      expect(storeJson).toContain(fragment);
    }
  });

  it('the ROW survives: orders still resolve to the anonymized customer (FK integrity)', async () => {
    await request(createApp()).post(`${MOUNT}/anonymize/cust_1`);

    const read = await request(createApp()).get(`${MOUNT}/customers/cust_1`);
    expect(read.status).toBe(200);
    expect(read.body.customer.id).toBe('cust_1'); // same row — not deleted
    expect(String(read.body.customer.name)).toMatch(/^anon_[0-9a-f]{8}$/);
    expect(read.body.orders).toHaveLength(2); // the links still resolve
    expect(read.body.note).toContain('survive');
  });

  it('writes exactly ONE erasure-log entry with who/when/scope', async () => {
    await request(createApp()).post(`${MOUNT}/anonymize/cust_1`);

    const log = await request(createApp()).get(`${MOUNT}/erasure-log`);
    expect(log.status).toBe(200);
    expect(log.body.entries).toHaveLength(1);
    expect(log.body.entries[0]).toMatchObject({
      customerId: 'cust_1',
      performedBy: 'gdpr-erasure-demo',
      linkedOrdersKept: 2,
    });
    const entry = log.body.entries[0] as { anonymizedAt: string; scope: string[] };
    expect(entry.anonymizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(entry.scope).toEqual(
      expect.arrayContaining(['name', 'email', 'phone', 'address.line1', 'address.city', 'address.postalCode', 'address.country']),
    );
  });

  it('double-anonymize is idempotent-friendly: 200, no second log entry, no crash', async () => {
    const app = createApp();
    await request(app).post(`${MOUNT}/anonymize/cust_1`);
    const before = String(rawPiiStoreForTests());

    const second = await request(app).post(`${MOUNT}/anonymize/cust_1`);
    expect(second.status).toBe(200);
    expect(second.body.alreadyAnonymized).toBe(true);
    expect(second.body.anonymized).toBeUndefined();

    const log = await request(app).get(`${MOUNT}/erasure-log`);
    expect(log.body.entries).toHaveLength(1);
    // The placeholders are deterministic — the store did not even change.
    expect(rawPiiStoreForTests()).toBe(before);
  });

  it('answers the 404 envelope for an unknown customer', async () => {
    const res = await request(createApp()).post(`${MOUNT}/anonymize/cust_999`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found', customerId: 'cust_999' });
  });
});

describe('POST /reset — the fixture again', () => {
  it('restores the seeded PII after an erasure', async () => {
    const app = createApp();
    await request(app).post(`${MOUNT}/anonymize/cust_1`);
    expect(rawPiiStoreForTests()).not.toContain('Fatima Nasser');

    const reset = await request(app).post(`${MOUNT}/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ reset: true });

    const read = await request(app).get(`${MOUNT}/customers/cust_1`);
    expect(read.body.customer.name).toBe('Fatima Nasser');
    expect(read.body.customer.anonymizedAt).toBeNull();
  });
});
