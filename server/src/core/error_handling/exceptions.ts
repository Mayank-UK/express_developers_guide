import {
  FAILURE_ERROR_CODE,
  FAILURE_HTTP_STATUS,
  failure,
  type Failure,
  type FailureKind,
} from './failures.js';

/**
 * Typed exceptions that carry a Failure. Use cases return Result<_, Failure>;
 * the presentation edge converts those failures into one of these exceptions
 * (see failureToException) so Express's error pipeline can render them.
 */
export class AppException extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
    // new.target keeps each subclass's own name in stack traces.
    this.name = new.target.name;
  }

  get statusCode(): number {
    return FAILURE_HTTP_STATUS[this.failure.kind];
  }

  get code(): string {
    return FAILURE_ERROR_CODE[this.failure.kind];
  }
}

export class ValidationException extends AppException {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(failure('validation', message, details, cause));
  }
}

export class UnauthorizedException extends AppException {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(failure('unauthorized', message, details, cause));
  }
}

export class ForbiddenException extends AppException {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(failure('forbidden', message, details, cause));
  }
}

export class NotFoundException extends AppException {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(failure('not_found', message, details, cause));
  }
}

export class ConflictException extends AppException {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(failure('conflict', message, details, cause));
  }
}

export class RateLimitException extends AppException {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(failure('rate_limited', message, details, cause));
  }
}

export class UnavailableException extends AppException {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(failure('unavailable', message, details, cause));
  }
}

export class InternalException extends AppException {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(failure('internal', message, details, cause));
  }
}

const EXCEPTION_BY_KIND: Readonly<
  Record<
    FailureKind,
    new (message: string, details?: Record<string, unknown>, cause?: unknown) => AppException
  >
> = {
  validation: ValidationException,
  unauthorized: UnauthorizedException,
  forbidden: ForbiddenException,
  not_found: NotFoundException,
  conflict: ConflictException,
  rate_limited: RateLimitException,
  unavailable: UnavailableException,
  internal: InternalException,
};

/** Converts any Failure into the matching exception, for throwing at the HTTP edge. */
export function failureToException(source: Failure): AppException {
  return new EXCEPTION_BY_KIND[source.kind](source.message, source.details, source.cause);
}
