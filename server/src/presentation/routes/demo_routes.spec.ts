import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { scenarioStore } from '../../core/scenario/scenario.js';
import { appConfig } from '../../core/config/app_config.js';
import {
  FAILURE_ERROR_CODE,
  FAILURE_HTTP_STATUS,
  FAILURE_KINDS,
} from '../../core/error_handling/failures.js';
import { UUID_RE } from '../../test_support/index.js';

beforeEach(() => {
  // Hermetic defaults regardless of ambient SCENARIO_* environment values.
  scenarioStore.set({ dataMode: 'fake', injectFailure: false });
});

afterEach(() => {
  scenarioStore.reset();
});

describe('GET /api/demo/scenario', () => {
  it('returns the current scenario state with a request id header', async () => {
    const res = await request(createApp()).get('/api/demo/scenario');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dataMode: 'fake', injectFailure: false });
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });

  it('reflects runtime scenario changes', async () => {
    scenarioStore.set({ dataMode: 'live', injectFailure: true });
    const res = await request(createApp()).get('/api/demo/scenario');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dataMode: 'live', injectFailure: true });
  });
});

describe('GET /api/demo/status', () => {
  it('maps the domain Result onto a 200 payload', async () => {
    const res = await request(createApp()).get('/api/demo/status');

    expect(res.status).toBe(200);
    expect(res.body.app).toBe('express_developers_guide');
    expect(res.body.scenario).toEqual({ dataMode: 'fake', injectFailure: false });
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });

  it('maps the injected failure onto the 503 error envelope with a real request id', async () => {
    scenarioStore.set({ injectFailure: true });
    const res = await request(createApp()).get('/api/demo/status');

    expect(res.status).toBe(503);
    expect(res.body.error).toEqual({
      code: 'service_unavailable',
      message: 'failure injection is ON',
      requestId: expect.stringMatching(UUID_RE),
    });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('GET /api/demo/app-info', () => {
  it('reports runtime facts, config, the express version, and the current scenario', async () => {
    const res = await request(createApp()).get('/api/demo/app-info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      app: 'express_developers_guide',
      nodeVersion: process.version,
      expressVersion: expect.stringMatching(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
      env: appConfig.nodeEnv,
      uptimeSeconds: expect.any(Number),
      pid: process.pid,
      scenario: { dataMode: 'fake', injectFailure: false },
    });
    expect(Number.isInteger(res.body.uptimeSeconds)).toBe(true);
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });

  it('reflects runtime scenario changes through the container', async () => {
    scenarioStore.set({ dataMode: 'live', injectFailure: true });
    const res = await request(createApp()).get('/api/demo/app-info');

    expect(res.status).toBe(200);
    expect(res.body.scenario).toEqual({ dataMode: 'live', injectFailure: true });
  });
});

describe('GET /api/demo/error', () => {
  it('maps every failure kind to its HTTP status and machine code', async () => {
    for (const kind of FAILURE_KINDS) {
      const res = await request(createApp()).get('/api/demo/error').query({ failure: kind });

      expect(res.status, `kind ${kind}`).toBe(FAILURE_HTTP_STATUS[kind]);
      expect(res.body.error, `kind ${kind}`).toEqual({
        code: FAILURE_ERROR_CODE[kind],
        message: expect.any(String),
        requestId: expect.stringMatching(UUID_RE),
      });
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    }
  });

  it('rejects a missing or unknown failure kind with a validation envelope listing valid values', async () => {
    for (const query of [{}, { failure: 'bogus' }, { failure: '' }]) {
      const res = await request(createApp()).get('/api/demo/error').query(query);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      // Details from the failure are merged into the envelope.
      expect(res.body.error.parameter).toBe('failure');
      expect(res.body.error.validValues).toEqual([...FAILURE_KINDS]);
      expect(res.body.error.requestId).toMatch(UUID_RE);
    }
  });
});

describe('GET /api/demo/errors/taxonomy', () => {
  it('serves all 8 kinds sourced FROM the real maps — statuses and codes cannot drift', async () => {
    const res = await request(createApp()).get('/api/demo/errors/taxonomy');

    expect(res.status).toBe(200);
    // Equality with the IMPORTED maps is the whole point: if failures.ts
    // changes, this endpoint's output changes with it — no restated table.
    expect(res.body).toEqual({
      source: expect.stringContaining('failures.ts'),
      kinds: FAILURE_KINDS.map((kind) => ({
        kind,
        httpStatus: FAILURE_HTTP_STATUS[kind],
        errorCode: FAILURE_ERROR_CODE[kind],
      })),
    });
    expect(res.body.kinds).toHaveLength(8);

    // Spot-check the contract the client demo renders:
    const byKind = new Map(
      (res.body.kinds as { kind: string; httpStatus: number; errorCode: string }[]).map(
        (row) => [row.kind, row],
      ),
    );
    expect(byKind.get('validation')).toEqual({
      kind: 'validation',
      httpStatus: 400,
      errorCode: 'validation_failed',
    });
    expect(byKind.get('unavailable')).toEqual({
      kind: 'unavailable',
      httpStatus: 503,
      errorCode: 'service_unavailable',
    });
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });
});

describe('GET /api/demo/ts/types', () => {
  it('returns a serialized Result value and a runtime narrowing trace', async () => {
    const res = await request(createApp()).get('/api/demo/ts/types');

    expect(res.status).toBe(200);
    // The Result is produced by the real ok(): { ok: true, value }.
    expect(res.body.result).toMatchObject({
      ok: true,
      value: {
        language: 'TypeScript',
        compiledTo: expect.stringContaining('erased'),
        checkedBy: expect.stringContaining('compile time'),
        runtimeKnows: expect.stringContaining('Array.isArray'),
      },
    });
    // The trace runs real runtime checks, one step per probed value.
    expect(res.body.narrowing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: '"authentication"',
          check: "typeof value === 'string'",
          narrowedTo: 'string',
        }),
        expect.objectContaining({
          value: '42',
          check: "typeof value === 'number'",
          narrowedTo: 'number',
        }),
        expect.objectContaining({ check: 'Array.isArray(value)', narrowedTo: 'unknown[]' }),
        expect.objectContaining({ value: 'null', check: 'value === null', narrowedTo: 'null' }),
      ]),
    );
    expect(res.body.narrowing).toHaveLength(5);
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });
});

describe('POST /api/demo/ts/echo', () => {
  it('reports the runtime types of every top-level key of an object body', async () => {
    const res = await request(createApp())
      .post('/api/demo/ts/echo')
      .send({ title: 42, tags: ['a', null] });

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ title: 42, tags: ['a', null] });
    expect(res.body.typeReport.typeof).toBe('object');
    expect(res.body.typeReport.isArray).toBe(false);
    expect(res.body.typeReport.isNull).toBe(false);
    expect(res.body.typeReport.entries).toEqual([
      expect.objectContaining({ key: 'title', typeof: 'number', isArray: false, isNull: false }),
      expect.objectContaining({
        key: 'tags',
        typeof: 'object', // typeof never says "array" — isArray is the real check
        isArray: true,
        isNull: false,
        elements: [
          expect.objectContaining({ index: 0, typeof: 'string', isNull: false }),
          expect.objectContaining({ index: 1, typeof: 'object', isNull: true }), // typeof null === 'object'
        ],
      }),
    ]);
    expect(res.body.typeReport.nullsPresent).toBe(true);
    expect(res.headers['x-request-id'] ?? '').toMatch(UUID_RE);
  });

  it('reports array bodies entry by entry, including nested nulls', async () => {
    const res = await request(createApp()).post('/api/demo/ts/echo').send([1, 'two', null]);

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual([1, 'two', null]);
    expect(res.body.typeReport.typeof).toBe('object');
    expect(res.body.typeReport.isArray).toBe(true);
    expect(
      res.body.typeReport.entries.map((entry: { key: string; typeof: string }) => [
        entry.key,
        entry.typeof,
      ]),
    ).toEqual([
      ['0', 'number'],
      ['1', 'string'],
      ['2', 'object'],
    ]);
    expect(res.body.typeReport.entries[2].isNull).toBe(true);
    expect(res.body.typeReport.nullsPresent).toBe(true);
  });

  it('reports an empty object body with no entries and no nulls', async () => {
    const res = await request(createApp()).post('/api/demo/ts/echo').send({});

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({});
    expect(res.body.typeReport.entries).toEqual([]);
    expect(res.body.typeReport.nullsPresent).toBe(false);
  });
});
