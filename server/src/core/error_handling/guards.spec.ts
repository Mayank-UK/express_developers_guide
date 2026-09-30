import { describe, expect, it } from 'vitest';
import { assert, assertDefined, withGuards } from './guards.js';
import { failure } from './failures.js';
import { AppException, ForbiddenException } from './exceptions.js';

describe('runtime guards', () => {
  it('assert passes when the condition holds and throws the matching exception otherwise', () => {
    expect(() => assert(true, failure('internal', 'never thrown'))).not.toThrow();
    expect(() => assert(1 > 2, failure('forbidden', 'nope'))).toThrow(ForbiddenException);
  });

  it('assertDefined lets defined values through and throws on null/undefined', () => {
    const maybe: string | undefined = 'value';
    assertDefined(maybe, failure('not_found', 'missing'));
    expect(maybe).toBe('value');

    expect(() => assertDefined(null, failure('not_found', 'missing'))).toThrow(AppException);
    expect(() => assertDefined(undefined, failure('not_found', 'missing'))).toThrow(AppException);
  });

  it('withGuards rethrows AppExceptions untouched', async () => {
    const original = new AppException(failure('conflict', 'already exists'));
    await expect(
      withGuards(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it('withGuards wraps unknown errors in an InternalException with the cause preserved', async () => {
    const cause = new Error('disk on fire');
    await expect(
      withGuards(async () => {
        throw cause;
      }),
    ).rejects.toMatchObject({
      failure: { kind: 'internal', cause },
    });
  });
});
