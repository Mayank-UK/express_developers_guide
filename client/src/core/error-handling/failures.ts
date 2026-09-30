/**
 * Failure — clean, predictable domain-level error states the UI understands.
 * Mirrors the react guide's `Failure` (sealed `Failure` in the Flutter guide),
 * trimmed to this client's needs.
 *
 * A Failure has:
 *  - a user-friendly `message`,
 *  - a `kind` + `severity` the UI can branch on,
 *  - the machine diagnostics from the transport layer: `code` (the error
 *    envelope's machine code, e.g. 'not_found') and `status` (HTTP status;
 *    0 = the request never completed) — shown by the error panel for diagnosis,
 *    exactly like the old `ApiError` shape.
 *
 * They live in the domain/presentation layers and are what the UI switches on.
 *
 * `FailureSeverity` is a const object + literal union (not an `enum`).
 */

export const FailureSeverity = {
  /** Gentle, dismissible (toast). Data is still usable. */
  Info: 'info',
  /** Non-blocking notice (toast). e.g. showing stale cache. */
  Warning: 'warning',
  /** Blocking — the screen has no data and must show a full-screen error. */
  Critical: 'critical',
} as const;

export type FailureSeverity = (typeof FailureSeverity)[keyof typeof FailureSeverity];

export type FailureKind = 'network' | 'server' | 'unknown';

/** Machine diagnostics preserved from the transport layer for the UI. */
export interface FailureDiagnostics {
  /** Machine code from the error envelope ('network_error', 'not_found', …). */
  code: string;
  /** HTTP status; 0 means the request never completed. */
  status: number;
}

export abstract class Failure {
  abstract readonly kind: FailureKind;
  abstract readonly severity: FailureSeverity;
  readonly code: string;
  readonly status: number;
  private readonly rawMessage: string;

  constructor(message: string, diagnostics: FailureDiagnostics) {
    this.rawMessage = message;
    this.code = diagnostics.code;
    this.status = diagnostics.status;
  }

  get message(): string {
    return this.rawMessage;
  }
}

export class NetworkFailure extends Failure {
  readonly kind = 'network' as const;
  readonly severity = FailureSeverity.Critical;
  constructor(
    message = 'Could not reach the server.',
    diagnostics: FailureDiagnostics = { code: 'network_error', status: 0 },
  ) {
    super(message, diagnostics);
  }
}

export class ServerFailure extends Failure {
  readonly kind = 'server' as const;
  readonly severity = FailureSeverity.Critical;
  constructor(
    message = 'Server error',
    diagnostics: FailureDiagnostics = { code: 'unknown_error', status: 0 },
  ) {
    super(message, diagnostics);
  }
}

export class UnknownFailure extends Failure {
  readonly kind = 'unknown' as const;
  readonly severity = FailureSeverity.Critical;
  constructor(
    message = 'Something went wrong',
    diagnostics: FailureDiagnostics = { code: 'unknown_error', status: 0 },
  ) {
    super(message, diagnostics);
  }
}
