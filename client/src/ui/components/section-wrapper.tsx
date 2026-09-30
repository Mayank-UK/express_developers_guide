import type { ReactNode } from 'react';

interface SectionWrapperProps {
  id: string;
  title: string;
  lead?: string;
  children: ReactNode;
}

/**
 * SectionWrapper — the top-level anatomy unit of every screen: an
 * anchor-addressable section carrying a titled header, an optional lead
 * paragraph, and the section's content blocks. The accent bar marks section
 * titles so long pages stay scannable; scroll-mt-xl (64px) makes in-page
 * anchors land below the sticky header.
 */
export function SectionWrapper({ id, title, lead, children }: SectionWrapperProps) {
  return (
    <section
      id={id}
      className="flex w-full scroll-mt-xl flex-col gap-md rounded-lg border border-outline bg-surface-tint p-lg shadow-button-card"
    >
      <h2 className="flex items-center gap-sm font-display text-title-lg text-on-surface">
        <span
          aria-hidden
          className="w-xs shrink-0 self-stretch rounded-pill bg-primary"
        />
        {title}
      </h2>
      {lead !== undefined && (
        <p className="text-body text-on-surface-variant">{lead}</p>
      )}
      {children}
    </section>
  );
}
