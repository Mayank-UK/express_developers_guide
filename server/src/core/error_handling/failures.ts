/**
 * The canonical Failure taxonomy: one discriminated shape for every error the
 * app can produce, plus the single place mapping each kind to its HTTP status
 * and machine-readable error code. Layers below HTTP speak ONLY in Failure
 * values; nothing else in the codebase invents status codes or error codes.
 */

export const FAILURE_KINDS = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'unavailable',
  'internal',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface Failure {
  readonly kind: FailureKind;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export const FAILURE_HTTP_STATUS: Readonly<Record<FailureKind, number>> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

export const FAILURE_ERROR_CODE: Readonly<Record<FailureKind, string>> = {
  validation: 'validation_failed',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  rate_limited: 'rate_limited',
  unavailable: 'service_unavailable',
  internal: 'internal_error',
};

/**
 * Builds a Failure. Optional keys are omitted entirely (not set to undefined),
 * so a failure's own keys describe exactly what it carries.
 */
export function failure(
  kind: FailureKind,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): Failure {
  return {
    kind,
    message,
    ...(details !== undefined && { details }),
    ...(cause !== undefined && { cause }),
  };
}
