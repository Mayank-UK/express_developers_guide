import { describe, expect, it } from 'vitest';
import {
  AppException,
  ConflictException,
  ForbiddenException,
  InternalException,
  NotFoundException,
  RateLimitException,
  UnauthorizedException,
  UnavailableException,
  ValidationException,
  failureToException,
} from './exceptions.js';
import { FAILURE_HTTP_STATUS, failure } from './failures.js';

const EXCEPTIONS_BY_KIND = {
  validation: ValidationException,
  unauthorized: UnauthorizedException,
  forbidden: ForbiddenException,
  not_found: NotFoundException,
  conflict: ConflictException,
  rate_limited: RateLimitException,
  unavailable: UnavailableException,
  internal: InternalException,
} as const;

describe('typed exceptions', () => {
  it('subclasses carry the matching failure, status, and code', () => {
    const err = new NotFoundException('no such post', { postId: 'p_1' });

    expect(err).toBeInstanceOf(AppException);
    expect(err.name).toBe('NotFoundException');
    expect(err.message).toBe('no such post');
    expect(err.failure).toEqual({
      kind: 'not_found',
      message: 'no such post',
      details: { postId: 'p_1' },
    });
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('not_found');
  });

  it('failureToException maps every kind to its exception with details preserved', () => {
    for (const [kind, ExceptionClass] of Object.entries(EXCEPTIONS_BY_KIND)) {
      const source = failure(kind as keyof typeof EXCEPTIONS_BY_KIND, `demo ${kind}`, {
        marker: kind,
      });
      const err = failureToException(source);

      expect(err).toBeInstanceOf(ExceptionClass);
      expect(err).toBeInstanceOf(AppException);
      expect(err.failure).toEqual(source);
      expect(err.statusCode).toBe(FAILURE_HTTP_STATUS[source.kind]);
    }
  });
});
