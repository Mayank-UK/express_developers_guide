import { describe, expect, it } from 'vitest';
import { fail, mapResult, ok, unwrapOr } from './result.js';
import { failure } from '../error_handling/failures.js';

describe('result helpers', () => {
  it('ok wraps a value', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('fail wraps a failure', () => {
    expect(fail(failure('internal', 'boom'))).toEqual({
      ok: false,
      error: { kind: 'internal', message: 'boom' },
    });
  });

  it('mapResult transforms success values and passes failures through untouched', () => {
    expect(mapResult(ok(2), (n) => n * 10)).toEqual({ ok: true, value: 20 });

    const failed = fail(failure('not_found', 'missing'));
    expect(mapResult(failed, (n: number) => n * 10)).toBe(failed);
  });

  it('unwrapOr returns the success value or the fallback', () => {
    expect(unwrapOr(ok('value'), 'fallback')).toBe('value');
    expect(unwrapOr(fail(failure('conflict', 'duplicate')), 'fallback')).toBe('fallback');
  });
});
