import { describe, expect, it } from 'vitest';
import { FAILURE_ERROR_CODE, FAILURE_HTTP_STATUS, FAILURE_KINDS, failure } from './failures.js';

describe('failure taxonomy', () => {
  it('maps every failure kind to an HTTP status and a machine code', () => {
    expect(FAILURE_KINDS).toHaveLength(8);

    const statuses = new Set<number>();
    for (const kind of FAILURE_KINDS) {
      const status = FAILURE_HTTP_STATUS[kind];
      const code = FAILURE_ERROR_CODE[kind];
      expect(typeof status).toBe('number');
      expect(typeof code).toBe('string');
      statuses.add(status);
    }
    // Distinct enough that kinds are not silently conflated.
    expect(statuses.size).toBe(8);
  });

  it('failure() omits optional keys unless they are provided', () => {
    const bare = failure('conflict', 'duplicate email');
    expect(bare).toEqual({ kind: 'conflict', message: 'duplicate email' });
    expect(Object.hasOwn(bare, 'details')).toBe(false);
    expect(Object.hasOwn(bare, 'cause')).toBe(false);

    expect(failure('validation', 'bad input', { field: 'email' })).toEqual({
      kind: 'validation',
      message: 'bad input',
      details: { field: 'email' },
    });

    const cause = new Error('root cause');
    expect(failure('internal', 'wrapped', undefined, cause).cause).toBe(cause);
  });
});
