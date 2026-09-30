import { describe, expect, it } from 'vitest';
import { validatePostDraft } from './post.js';

/**
 * The entity's invariants, proven with zero machinery: no use case, no
 * scenario store, no repository, no HTTP — just the rules and the failure
 * they produce. The use-case spec covers orchestration; this file proves the
 * ENTITY itself decides what a valid post draft is.
 */
const validDraft = {
  title: 'Unit-tested title',
  body: 'A body of reasonable length.',
  author: 'vitest',
};

describe('validatePostDraft', () => {
  it('accepts a well-formed draft unchanged', () => {
    const result = validatePostDraft(validDraft);
    expect(result).toEqual({ ok: true, value: validDraft });
  });

  it('rejects non-object payloads with a body field error', () => {
    for (const raw of [null, undefined, 42, 'a string', [], [{ title: 'x' }]]) {
      const result = validatePostDraft(raw);
      expect(result.ok, `raw ${JSON.stringify(raw)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('validation');
        expect(result.error.details?.fields).toHaveProperty('body');
      }
    }
  });

  it('reports each length or type violation under its field name', () => {
    const cases: ReadonlyArray<{ raw: unknown; field: string }> = [
      { raw: { body: 'b', author: 'a' }, field: 'title' },
      { raw: { title: '', body: 'b', author: 'a' }, field: 'title' },
      { raw: { title: 't'.repeat(121), body: 'b', author: 'a' }, field: 'title' },
      { raw: { title: 't', body: '', author: 'a' }, field: 'body' },
      { raw: { title: 't', body: 'x'.repeat(5001), author: 'a' }, field: 'body' },
      { raw: { title: 't', body: 'b', author: '' }, field: 'author' },
      { raw: { title: 't', body: 'b', author: 'y'.repeat(81) }, field: 'author' },
      { raw: { title: 7, body: 'b', author: 'a' }, field: 'title' },
      { raw: { title: 't', body: 'b', author: 'a', surprise: 1 }, field: 'surprise' },
    ];
    for (const { raw, field } of cases) {
      const result = validatePostDraft(raw);
      expect(result.ok, `field ${field}`).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('validation');
        expect(Object.keys(result.error.details?.fields ?? {}), `field ${field}`).toContain(field);
      }
    }
  });

  it('lists every offending field at once, including unknown fields', () => {
    const result = validatePostDraft({
      title: '',
      body: 'b',
      author: 'a',
      nope: true,
      alsoNope: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.error.details?.fields ?? {}).sort()).toEqual([
        'alsoNope',
        'nope',
        'title',
      ]);
    }
  });

  it('rejects an invalid draft directly, with the exact failure the route renders', () => {
    // Entity-level proof, no use case in sight: an empty title produces the
    // same validation failure (kind, message, field reason) the posts route
    // later maps onto the 400 envelope's error.fields.
    const result = validatePostDraft({ title: '', body: 'b', author: 'a' });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'validation',
        message: 'post payload is invalid',
        details: { fields: { title: 'must be a string of 1 to 120 characters (got 0)' } },
      },
    });
  });
});
