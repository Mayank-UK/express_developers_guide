import type { ReactNode } from 'react';

interface ExampleProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/**
 * Example — the live-demo panel, where every screen's interactive demo lives.
 * Deliberately distinct from text and code: dashed border + accent mark signal
 * "something you can operate, not just read".
 */
export function Example({ title, description, children }: ExampleProps) {
  return (
    <section className="flex w-full flex-col gap-sm rounded-lg border border-dashed border-secondary bg-surface p-md shadow-button-card">
      <div className="flex items-baseline gap-sm">
        <span
          aria-hidden
          className="font-mono text-overline font-semibold uppercase tracking-[0.08em] text-secondary"
        >
          live
        </span>
        <h3 className="font-display text-title-sm text-on-surface">{title}</h3>
      </div>
      {description !== undefined && (
        <p className="text-body-sm text-on-surface-variant">{description}</p>
      )}
      <div className="flex flex-col gap-sm pt-xs">{children}</div>
    </section>
  );
}
