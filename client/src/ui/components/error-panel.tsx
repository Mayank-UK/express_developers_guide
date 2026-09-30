import type { Failure } from '../../core/error-handling/failures';

interface ErrorPanelProps {
  /** What the user was trying to load, e.g. "topic map" or "this topic". */
  subject: string;
  failure: Failure;
}

/**
 * ErrorPanel — the friendly failure state for expected API errors: shows the
 * failure's user message plus the machine code and HTTP status for diagnosis.
 * Used wherever a screen's data fetch resolved to a Failed Result.
 */
export function ErrorPanel({ subject, failure }: ErrorPanelProps) {
  return (
    <section
      role="alert"
      className="flex w-full flex-col gap-xs rounded-lg border border-outline bg-surface-tint p-md shadow-button-card"
    >
      <h3 className="font-display text-title-sm text-error">
        Could not load {subject}
      </h3>
      <p className="text-body-sm text-on-surface-variant">{failure.message}</p>
      <p className="font-mono text-caption text-on-surface-variant">
        {failure.code} · status {failure.status}
      </p>
    </section>
  );
}
