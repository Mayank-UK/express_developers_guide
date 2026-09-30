import type { ReactNode } from 'react';

interface TextBlockProps {
  children: ReactNode;
}

/**
 * TextBlock — a paragraph of body copy. `pre-line` preserves explicit
 * newlines in served text (the content API sends plain strings) while still
 * wrapping normally.
 */
export function TextBlock({ children }: TextBlockProps) {
  return (
    <p className="w-full text-body leading-[1.7] text-on-surface-variant [white-space:pre-line]">
      {children}
    </p>
  );
}
