import type { ReactNode } from 'react';

interface ContentGroupWrapperProps {
  title?: string;
  children: ReactNode;
}

/**
 * ContentGroupWrapper — one run of related blocks inside a section, with
 * consistent vertical rhythm between them. The optional overline label keeps
 * the hierarchy readable: section title → overline → body/code/example.
 */
export function ContentGroupWrapper({ title, children }: ContentGroupWrapperProps) {
  return (
    <div className="flex flex-col gap-md">
      {title !== undefined && (
        <p className="text-overline font-semibold uppercase tracking-[0.08em] text-on-surface-variant">
          {title}
        </p>
      )}
      {children}
    </div>
  );
}
