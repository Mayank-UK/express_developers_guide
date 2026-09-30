import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { VALIDATION_DEMO_MOUNT_PATH } from './validation_demo_routes.js';
import { UUID_RE } from '../../test_support/index.js';

/** The slice of supertest's Response these assertions read (structural). */
interface ApiResponse {
  status: number;
  body: any;
}

const MOUNT = VALIDATION_DEMO_MOUNT_PATH; // /api/demo/validation

/** The canonical valid payload — satisfies every rule, includes the optional field. */
const VALID_PAYLOAD = {
  title: 'Ship the three-validators demo',
  email: 'ada@example.com',
  age: 36,
  website: 'https://example.com',
  tags: ['express', 'validation'],
};

/** Breaks four rules at once: title > 80, bad email, age < 18, six tags. */
const INVALID_PAYLOAD = {
  title:
    'This title is intentionally longer than the eighty-character maximum allowed by design',
  email: 'not-an-email',
  age: 5,
  website: 'https://example.com', // valid on purpose — only the four fields above fail
  tags: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
};

const ENDPOINTS = [
  { validator: 'zod', path: `${MOUNT}/zod` },
  { validator: 'express-validator', path: `${MOUNT}/express-validator` },
  { validator: 'joi', path: `${MOUNT}/joi` },
] as const;

function postJson(path: string, payload: unknown): Promise<ApiResponse> {
  // supertest's send() wants string | object — every payload here is an object.
  return request(createApp()).post(path).set('content-type', 'application/json').send(payload as object);
}

interface NormalizedError {
  field: string;
  message: string;
}

/** Sorted unique field names from a response's normalized error list. */
function fieldSet(res: ApiResponse): string[] {
  const errors = (res.body.error?.errors ?? []) as NormalizedError[];
  return [...new Set(errors.map((error) => error.field))].sort();
}

describe('GET /api/demo/validation/schema — the canonical rules', () => {
  it('serves the field spec, the three endpoints, and both sample payloads', async () => {
    const res = await request(createApp()).get(`${MOUNT}/schema`);

    expect(res.status).toBe(200);
    expect(res.body.mountPath).toBe(MOUNT);
    expect(res.body.fields.map((field: { field: string }) => field.field)).toEqual([
      'title',
      'email',
      'age',
      'website',
      'tags',
    ]);
    for (const field of res.body.fields as Array<{ rule: string; type: string }>) {
      expect(field.rule).toMatch(/./);
      expect(field.type).toMatch(/./);
    }
    const website = (res.body.fields as Array<{ field: string; required: boolean }>).find(
      (field) => field.field === 'website',
    );
    expect(website?.required).toBe(false);

    expect(res.body.endpoints).toEqual(
      ENDPOINTS.map((endpoint) => ({ ...endpoint, method: 'POST' })),
    );

    expect(res.body.sampleValid).toEqual(VALID_PAYLOAD);
    // The invalid sample breaks exactly the four rules the demo promises.
    expect(res.body.sampleInvalid.title.length).toBeGreaterThan(80);
    expect(res.body.sampleInvalid.email).toBe('not-an-email');
    expect(res.body.sampleInvalid.age).toBe(5);
    expect(res.body.sampleInvalid.tags).toHaveLength(6);
  });
});

describe('the same VALID payload through all three validators', () => {
  it.each(ENDPOINTS.map((endpoint) => [endpoint.validator, endpoint.path] as const))(
    '%s answers 200 with valid, the parsed payload, and library notes',
    async (_validator, path) => {
      const res = await postJson(path, VALID_PAYLOAD);

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.validator).toBe(_validator);
      expect(res.body.payload).toEqual(VALID_PAYLOAD);
      expect(Array.isArray(res.body.notes)).toBe(true);
      expect(res.body.notes.length).toBeGreaterThan(0);
      for (const note of res.body.notes as string[]) {
        expect(typeof note).toBe('string');
      }
    },
  );

  it('normalizes to the IDENTICAL parsed payload across all three', async () => {
    const payloads = await Promise.all(
      ENDPOINTS.map(async (endpoint) => (await postJson(endpoint.path, VALID_PAYLOAD)).body.payload),
    );
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[1]).toEqual(payloads[2]);
  });

  it('accepts a payload WITHOUT the optional website, identically', async () => {
    const noWebsite = { ...VALID_PAYLOAD } as Partial<typeof VALID_PAYLOAD>;
    delete noWebsite.website;

    const responses = await Promise.all(
      ENDPOINTS.map((endpoint) => postJson(endpoint.path, noWebsite)),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.payload).toEqual(noWebsite);
    }
  });
});

describe('the same INVALID payload through all three validators', () => {
  it.each(ENDPOINTS.map((endpoint) => [endpoint.validator, endpoint.path] as const))(
    '%s answers 400 with the canonical envelope and normalized errors',
    async (validator, path) => {
      const res = await postJson(path, INVALID_PAYLOAD);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.requestId).toMatch(UUID_RE);
      expect(res.body.error.validator).toBe(validator);
      expect(Array.isArray(res.body.error.errors)).toBe(true);
      for (const error of res.body.error.errors as NormalizedError[]) {
        expect(typeof error.field).toBe('string');
        expect(typeof error.message).toBe('string');
        expect(error.message).toMatch(/./);
      }
    },
  );

  it('reports the SAME normalized field set {title, email, age, tags} everywhere', async () => {
    const responses = await Promise.all(
      ENDPOINTS.map((endpoint) => postJson(endpoint.path, INVALID_PAYLOAD)),
    );
    for (const res of responses) {
      expect(fieldSet(res)).toEqual(['age', 'email', 'tags', 'title']);
    }
  });

  it('joi returns MULTIPLE errors (abortEarly: false) and exposes details under raw', async () => {
    const res = await postJson(`${MOUNT}/joi`, INVALID_PAYLOAD);

    expect((res.body.error.errors as NormalizedError[]).length).toBeGreaterThanOrEqual(4);
    const types = (res.body.error.raw.details as Array<{ type: string }>).map(
      (detail) => detail.type,
    );
    expect(types).toEqual(expect.arrayContaining(['string.max', 'string.email', 'number.min', 'array.max']));
  });

  it('express-validator returns one error per failed check and exposes the array under raw', async () => {
    const res = await postJson(`${MOUNT}/express-validator`, INVALID_PAYLOAD);

    const errors = res.body.error.errors as NormalizedError[];
    // Four failed checks (title, email, age, tags) — and NOT doubled: checkExact
    // runs each chain exactly once.
    expect(errors).toHaveLength(4);
    const rawErrors = res.body.error.raw.errors as Array<{ type: string; path: string; msg: string }>;
    expect(rawErrors).toHaveLength(4);
    for (const raw of rawErrors) {
      expect(raw.type).toBe('field');
      expect(typeof raw.path).toBe('string');
      expect(raw.msg).toMatch(/./);
    }
  });

  it('zod reports issues under raw, with machine-readable codes', async () => {
    const res = await postJson(`${MOUNT}/zod`, INVALID_PAYLOAD);

    const issues = res.body.error.raw.issues as Array<{ code: string; path: (string | number)[] }>;
    expect(issues.length).toBeGreaterThanOrEqual(4);
    const codes = issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(['too_big', 'too_small', 'invalid_format']),
    );
    // Array item errors carry the index in the path — the normalizer joins it.
    expect(issues.every((issue) => Array.isArray(issue.path))).toBe(true);
  });
});

describe('library-native differences, surfaced not hidden', () => {
  it('age as the STRING "42": zod rejects, joi coerces to the number 42, express-validator keeps the string', async () => {
    const payload = { ...VALID_PAYLOAD, age: '42' };

    const zodRes = await postJson(`${MOUNT}/zod`, payload);
    expect(zodRes.status).toBe(400);
    expect(fieldSet(zodRes)).toEqual(['age']);

    const joiRes = await postJson(`${MOUNT}/joi`, payload);
    expect(joiRes.status).toBe(200);
    expect(joiRes.body.payload.age).toBe(42);
    expect(typeof joiRes.body.payload.age).toBe('number');

    const evRes = await postJson(`${MOUNT}/express-validator`, payload);
    expect(evRes.status).toBe(200);
    expect(evRes.body.payload.age).toBe('42');
    expect(typeof evRes.body.payload.age).toBe('string');
  });

  it('an unknown field is rejected by ALL THREE — each by its own mechanism', async () => {
    const payload = { ...VALID_PAYLOAD, nickname: 'ada' };

    const responses = await Promise.all(
      ENDPOINTS.map((endpoint) => postJson(endpoint.path, payload)),
    );
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(fieldSet(res)).toContain('nickname');
    }
  });

  it('an array body (and no body at all) fails at (root) in all three', async () => {
    for (const body of [[1, 2], undefined] as unknown[]) {
      const responses = await Promise.all(
        ENDPOINTS.map((endpoint) =>
          body === undefined
            ? request(createApp()).post(endpoint.path)
            : postJson(endpoint.path, body),
        ),
      );
      for (const res of responses) {
        expect(res.status).toBe(400);
        expect(fieldSet(res)).toEqual(['(root)']);
      }
    }
  });

  it('an http (non-https) website is rejected by all three, and only that field', async () => {
    const payload = { ...VALID_PAYLOAD, website: 'http://insecure.example.com' };

    const responses = await Promise.all(
      ENDPOINTS.map((endpoint) => postJson(endpoint.path, payload)),
    );
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(fieldSet(res)).toEqual(['website']);
    }
  });

  it('an empty-string tag is flagged as tags.0 by ALL THREE (indexes normalized)', async () => {
    const payload = { ...VALID_PAYLOAD, tags: ['', 'ok-tag'] };

    const responses = await Promise.all(
      ENDPOINTS.map((endpoint) => postJson(endpoint.path, payload)),
    );
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(fieldSet(res)).toEqual(['tags.0']);
    }
  });

  it('the rule tables agree at the exact boundaries (no off-by-one between libraries)', async () => {
    // Everything at its inclusive limit: title exactly 80, age exactly 120,
    // five tags of exactly 20 characters — passes everywhere.
    const atLimits = {
      title: 'x'.repeat(80),
      email: 'ada@example.com',
      age: 120,
      tags: ['y'.repeat(20), 'a', 'b', 'c', 'd'],
    };
    for (const endpoint of ENDPOINTS) {
      const res = await postJson(endpoint.path, atLimits);
      expect(res.status, `${endpoint.validator} at limits`).toBe(200);
      expect(res.body.payload).toEqual(atLimits);
    }

    // One step past each limit fails everywhere: age 121, age 17, a 21-char tag.
    for (const [label, payload] of [
      ['age 121', { ...VALID_PAYLOAD, age: 121 }],
      ['age 17', { ...VALID_PAYLOAD, age: 17 }],
      ['21-char tag', { ...VALID_PAYLOAD, tags: ['z'.repeat(21)] }],
      ['81-char title', { ...VALID_PAYLOAD, title: 'x'.repeat(81) }],
      ['six tags', { ...VALID_PAYLOAD, tags: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ] as const) {
      const responses = await Promise.all(
        ENDPOINTS.map((endpoint) => postJson(endpoint.path, payload)),
      );
      for (const res of responses) {
        expect(res.status, `${label} via ${res.body.error?.validator ?? 'unknown'}`).toBe(400);
      }
    }
  });
});
