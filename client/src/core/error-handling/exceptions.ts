/**
 * AppException — raw, low-level, technical errors thrown from the data layer
 * (fetch pipeline, JSON parsing). Mirrors the react guide's `AppException`
 * (sealed `AppException` in the Flutter guide), trimmed to this client's needs.
 *
 * These are *not* shown to users. The guards convert them into user-facing
 * Failures (see failures.ts). They live strictly inside the data layer.
 *
 * In addition to `cause` (the original error, so the full chain can be
 * reconstructed), every exception carries the machine diagnostics the failure
 * layer preserves for the UI: `status` (HTTP status; 0 = the request never
 * completed) and `code` (the error envelope's machine code).
 *
 * `cause` is assigned in the constructor body (not via super options) because,
 * with `useDefineForClassFields`, redeclaring `cause` as a field would otherwise
 * reset it to undefined after `super()` runs.
 */

export type AppExceptionCause = unknown;

export interface AppExceptionOptions {
  cause?: AppExceptionCause;
  /** HTTP status of the response; 0 means the request never completed. */
  status?: number;
  /** Machine code from the server's error envelope (e.g. 'not_found'). */
  code?: string;
}

export abstract class AppException extends Error {
  override readonly cause?: AppExceptionCause;
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: AppExceptionOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    // Assigned after the field initializer stage so it survives construction.
    this.cause = options.cause;
    this.status = options.status ?? 0;
    this.code = options.code ?? 'unknown_error';
  }
}

/** Network-level failure: the fetch itself rejected (offline, CORS, DNS…). */
export class NetworkException extends AppException {
  constructor(
    message = 'Could not reach the server.',
    options: AppExceptionOptions = {},
  ) {
    super(message, { code: 'network_error', status: 0, ...options });
  }
}

/** The server answered with a non-2xx status or an unusable body. */
export class ServerException extends AppException {
  constructor(
    message = 'Server error',
    options: AppExceptionOptions = {},
  ) {
    super(message, { code: 'unknown_error', status: 0, ...options });
  }
}

/**
 * The request succeeded at the HTTP level but the payload did not match the
 * expected shape (client-side validation threw).
 */
export class InvalidResponseException extends ServerException {
  constructor(status: number, options: AppExceptionOptions = {}) {
    super('The server response did not match the expected shape.', {
      code: 'invalid_response',
      status,
      ...options,
    });
  }
}
