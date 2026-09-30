import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { UUID_RE } from '../../test_support/index.js';

describe('GET /api/demo/http/inspect', () => {
  it('echoes the request line, parsed query, and a custom header round-trip', async () => {
    const res = await request(createApp())
      .get('/api/demo/http/inspect?via=spec&flavor=vanilla')
      .set('X-Demo-Custom', 'round-trip-probe');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      method: 'GET',
      httpVersion: '1.1',
      path: '/api/demo/http/inspect',
      query: { via: 'spec', flavor: 'vanilla' },
      headers: expect.any(Object),
      requestId: expect.any(String),
    });

    // A custom header coming back proves echo, not canned data — and the
    // transport-level headers a browser/proxy contributes are present too.
    expect(res.body.headers['x-demo-custom']).toBe('round-trip-probe');
    expect(res.body.headers.host).toBeTruthy();

    // Names are lowercase and sorted for a stable read.
    const names = Object.keys(res.body.headers);
    expect(names.every((name: string) => name === name.toLowerCase())).toBe(true);
    expect([...names].sort()).toEqual(names);

    // The correlation id: body field, response header, and the forwarded
    // (proxy-style) request-header view all agree.
    expect(res.body.headers['x-request-id']).toBe(res.body.requestId);
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    expect(res.headers['x-request-id']).toMatch(UUID_RE);
  });

  it('answers with the teaching response headers, echoing the Accept header', async () => {
    const res = await request(createApp())
      .get('/api/demo/http/inspect')
      .set('Accept', 'application/json, */*;q=0.5');

    expect(res.status).toBe(200);
    expect(res.headers['x-teaching-header']).toBe('set-by-the-server');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toBe('Accept');
    expect(res.headers['x-your-accept']).toBe('application/json, */*;q=0.5');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('reports (none sent) when Accept is empty', async () => {
    const res = await request(createApp()).get('/api/demo/http/inspect').set('Accept', '');

    expect(res.status).toBe(200);
    expect(res.headers['x-your-accept']).toBe('(none sent)');
  });
});

describe('GET /api/demo/http/negotiate', () => {
  it('serves JSON for Accept: application/json', async () => {
    const res = await request(createApp())
      .get('/api/demo/http/negotiate')
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['vary']).toBe('Accept');

    expect(res.body.resource).toBe('/api/demo/http/negotiate');
    expect(res.body.acceptHeader).toBe('application/json');
    expect(res.body.chosenRepresentation).toBe('application/json; charset=utf-8');
    expect(res.body.available).toHaveLength(3);
    // The three branches all carry the SAME facts — only the shape differs.
    expect(res.body.available.map((entry: { contentType: string }) => entry.contentType)).toEqual(
      ['application/json; charset=utf-8', 'text/plain; charset=utf-8', 'text/html; charset=utf-8'],
    );
  });

  it('serves flattened key: value lines for Accept: text/plain', async () => {
    const res = await request(createApp())
      .get('/api/demo/http/negotiate')
      .set('Accept', 'text/plain');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['vary']).toBe('Accept');
    expect(res.text).toContain('resource: /api/demo/http/negotiate');
    expect(res.text).toContain('accept: text/plain');
    expect(res.text).toContain('chosen representation: text/plain; charset=utf-8');
    expect(res.text).toContain('  - application/json; charset=utf-8 (structured object)');
  });

  it('serves the tiny <dl> document for Accept: text/html (header values escaped)', async () => {
    const res = await request(createApp())
      .get('/api/demo/http/negotiate')
      .set('Accept', 'text/html;q=1.0, text/plain;q=0.8');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['vary']).toBe('Accept');
    expect(res.text).toContain('<dl>');
    expect(res.text).toContain('<dt>accept</dt><dd>text/html;q=1.0, text/plain;q=0.8</dd>');
    expect(res.text).toContain(
      '<dt>chosen representation</dt><dd>text/html; charset=utf-8</dd>',
    );
    // The Accept header lands inside an attribute-free text node, but escaping
    // still must not corrupt ordinary values:
    expect(res.text).not.toContain('&amp;amp;');
  });

  it('honors q-values: the higher quality representation wins', async () => {
    const res = await request(createApp())
      .get('/api/demo/http/negotiate')
      .set('Accept', 'application/json;q=0.1, text/plain;q=0.9');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).toContain('accept: application/json;q=0.1, text/plain;q=0.9');
    expect(res.text).toContain('chosen representation: text/plain; charset=utf-8');
  });

  it('breaks q-value ties with the earlier Accept entry', async () => {
    const res = await request(createApp())
      .get('/api/demo/http/negotiate')
      .set('Accept', 'text/html, text/plain');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('excludes entries with q=0 and matches */* and text/* wildcards', async () => {
    const excluded = await request(createApp())
      .get('/api/demo/http/negotiate')
      .set('Accept', 'text/html;q=0, text/plain');
    expect(excluded.headers['content-type']).toBe('text/plain; charset=utf-8');

    const star = await request(createApp())
      .get('/api/demo/http/negotiate')
      .set('Accept', '*/*');
    expect(star.headers['content-type']).toBe('application/json; charset=utf-8');

    const subtype = await request(createApp())
      .get('/api/demo/http/negotiate')
      .set('Accept', 'text/*');
    expect(subtype.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('falls back to JSON for unknown or absent Accept headers', async () => {
    for (const accept of ['application/xml', '']) {
      const res = await request(createApp())
        .get('/api/demo/http/negotiate')
        .set('Accept', accept);

      expect(res.status, `accept="${accept}"`).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.body.acceptHeader).toBe(accept === '' ? '(none sent)' : accept);
    }
  });
});
