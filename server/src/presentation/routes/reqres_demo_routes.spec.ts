import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { REQRES_DEMO_MOUNT_PATH } from './reqres_demo_routes.js';
import { UUID_RE } from '../../test_support/index.js';

const MOUNT = REQRES_DEMO_MOUNT_PATH; // /api/demo/reqres
const INSPECT = `${MOUNT}/inspect`;
const ECHO_HEADERS = `${MOUNT}/echo-custom-headers`;
const RESPOND = `${MOUNT}/respond`;

describe('ANY /api/demo/reqres/inspect — the request inspector', () => {
  it('reflects the GET shape: request line, query, headers, no body of any kind', async () => {
    const res = await request(createApp()).get(`${INSPECT}?via=spec&flavor=vanilla`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      method: 'GET',
      path: INSPECT,
      query: { via: 'spec', flavor: 'vanilla' },
      headers: expect.any(Object),
      body: null, // no parser matched and no bytes arrived
      bodyRaw: null,
      bodyRawTruncated: false,
      requestId: expect.any(String),
    });

    // Names are lowercase and sorted for a stable read; custom headers echo.
    const names = Object.keys(res.body.headers);
    expect(names.every((name: string) => name === name.toLowerCase())).toBe(true);
    expect([...names].sort()).toEqual(names);

    // The correlation id rides the body, the response header, AND the
    // proxy-style forwarded request-header view.
    expect(res.body.headers['x-request-id']).toBe(res.body.requestId);
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    expect(res.body.requestId).toMatch(UUID_RE);
  });

  it('accepts every one of the five inspector methods', async () => {
    const app = createApp();
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method](INSPECT);
      expect(res.status, method).toBe(200);
      expect(res.body.method, method).toBe(method.toUpperCase());
      expect(res.body.path, method).toBe(INSPECT);
    }
  });

  it('shows the parser effect: application/json arrives PARSED, no raw copy', async () => {
    const res = await request(createApp())
      .post(INSPECT)
      .set('content-type', 'application/json')
      .send({ hello: 'inspector', nested: { works: true } });

    expect(res.status).toBe(200);
    expect(res.body.method).toBe('POST');
    expect(res.body.body).toEqual({ hello: 'inspector', nested: { works: true } });
    expect(res.body.bodyRaw).toBeNull(); // express.json() consumed the stream
    expect(res.body.bodyRawTruncated).toBe(false);
  });

  it('shows the parser effect: text/plain is NOT parsed — the raw bytes are read from the stream', async () => {
    const res = await request(createApp())
      .post(INSPECT)
      .set('content-type', 'text/plain')
      .send('still just bytes');

    expect(res.status).toBe(200);
    expect(res.body.body).toBeNull(); // no parser matched → req.body was undefined
    expect(res.body.bodyRaw).toBe('still just bytes');
    expect(res.body.bodyRawTruncated).toBe(false);
  });

  it('echoes custom x- request headers in the reflected map', async () => {
    const res = await request(createApp()).get(INSPECT).set('X-Demo-Custom', 'round-trip-probe');

    expect(res.status).toBe(200);
    expect(res.body.headers['x-demo-custom']).toBe('round-trip-probe');
    expect(res.body.headers.host).toBeTruthy();
  });

  it('caps bodyRaw at the limit and reports the truncation', async () => {
    const oversized = 'x'.repeat(5000);
    const res = await request(createApp())
      .post(INSPECT)
      .set('content-type', 'text/plain')
      .send(oversized);

    expect(res.status).toBe(200);
    expect(res.body.body).toBeNull();
    expect(res.body.bodyRaw).toHaveLength(2048);
    expect(res.body.bodyRawTruncated).toBe(true);
  });
});

describe('PUT /api/demo/reqres/echo-custom-headers', () => {
  it('echoes back ONLY the x- prefixed headers, as a map', async () => {
    const res = await request(createApp())
      .put(ECHO_HEADERS)
      .set('x-teaching-one', 'a')
      .set('x-teaching-two', 'b');

    expect(res.status).toBe(200);
    expect(res.body.method).toBe('PUT');
    // Exactly the x- headers that were sent — accept and host are filtered out.
    expect(res.body.customHeaders).toEqual({
      'x-teaching-one': 'a',
      'x-teaching-two': 'b',
    });
    expect(Object.keys(res.body.customHeaders).every((name: string) => name.startsWith('x-'))).toBe(
      true,
    );
  });

  it('answers an empty map when no custom headers were sent', async () => {
    const res = await request(createApp()).put(ECHO_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.customHeaders).toEqual({});
  });
});

describe('GET /api/demo/reqres/respond — the response-methods playground', () => {
  it('mode=json: res.json sets the content type and serializes the object', async () => {
    const res = await request(createApp()).get(`${RESPOND}?mode=json`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.mode).toBe('json');
    expect(res.body.producedBy).toBe('res.json(object)');
  });

  it('mode=text: res.type("text/plain").send leaves the body as the exact string', async () => {
    const res = await request(createApp()).get(`${RESPOND}?mode=text`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).toContain('res.type("text/plain").send(string)');
  });

  it('mode=status: defaults to 409 and reflects the chosen code in the body', async () => {
    const res = await request(createApp()).get(`${RESPOND}?mode=status`);

    expect(res.status).toBe(409);
    expect(res.body.chosen).toBe(409);
    expect(res.body.producedBy).toBe('res.status(409).json(object)');
  });

  it('mode=status&status=: honors every code on the safe list', async () => {
    const app = createApp();
    for (const code of [200, 201, 400, 401, 403, 404, 409, 418, 500, 503]) {
      const res = await request(app).get(`${RESPOND}?mode=status&status=${String(code)}`);
      expect(res.status, `status=${String(code)}`).toBe(code);
      expect(res.body.chosen, `status=${String(code)}`).toBe(code);
    }
  });

  it('mode=status&status=204: 204 carries NO body at all', async () => {
    const res = await request(createApp()).get(`${RESPOND}?mode=status&status=204`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('mode=status&status=: rejects codes off the safe list with a 400 envelope', async () => {
    for (const raw of ['999', '100', '418.5', 'teapot']) {
      const res = await request(createApp()).get(`${RESPOND}?mode=status&status=${raw}`);
      expect(res.status, `status=${raw}`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.parameter).toBe('status');
      expect(res.body.error.requestId).toMatch(UUID_RE);
    }
  });

  it('mode=redirect: answers 307 with the Location header', async () => {
    const res = await request(createApp()).get(`${RESPOND}?mode=redirect`);

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe(`${MOUNT}/redirect-target`);
  });

  it('mode=cookie: Set-Cookie carries the security attributes', async () => {
    const res = await request(createApp()).get(`${RESPOND}?mode=cookie`);

    expect(res.status).toBe(200);
    expect(res.body.set).toBe(true);

    const setCookie: string | string[] = res.headers['set-cookie'];
    const cookie = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
    expect(cookie).toContain('teaching_cookie=baked');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=60');
    expect(cookie).toContain('Path=/');
  });

  it('mode=stream: five ndjson lines, chunked, no Content-Length', async () => {
    const res = await request(createApp()).get(`${RESPOND}?mode=stream`);

    expect(res.status).toBe(200);
    // res.type sets the header verbatim (no charset appended — that is
    // res.send's habit, and this mode writes chunks itself).
    expect(res.headers['content-type']).toBe('application/x-ndjson');
    expect(res.headers['transfer-encoding']).toBe('chunked');
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['x-stream-lines']).toBe('5');

    const lines = res.text.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('{"seq":1,"of":5,"mode":"stream"}');
    expect(lines[4]).toBe('{"seq":5,"of":5,"mode":"stream"}');
  });

  it('mode=download: Content-Disposition marks the body as an attachment', async () => {
    const res = await request(createApp()).get(`${RESPOND}?mode=download`);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="teaching.txt"');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).toContain('arrives as a download');
  });

  it('unknown or missing mode: 400 envelope naming the valid families', async () => {
    for (const query of ['mode=bogus', '']) {
      const res = await request(createApp()).get(`${RESPOND}${query === '' ? '' : `?${query}`}`);
      expect(res.status, `query="${query}"`).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(res.body.error.parameter).toBe('mode');
      expect(res.body.error.validValues).toEqual([
        'json',
        'text',
        'status',
        'redirect',
        'cookie',
        'stream',
        'download',
      ]);
      expect(res.body.error.requestId).toMatch(UUID_RE);
    }
  });
});

describe('GET /api/demo/reqres/redirect-target — where the 307 lands', () => {
  it('answers the small JSON body the followed response shows', async () => {
    const res = await request(createApp()).get(`${MOUNT}/redirect-target`);

    expect(res.status).toBe(200);
    expect(res.body.arrived).toBe(true);
    expect(res.body.at).toBe(`${MOUNT}/redirect-target`);
    expect(res.body.note).toMatch(/307/);
  });
});
