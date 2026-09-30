import { useEffect, useRef, useState } from 'react';

interface CodeBlockProps {
  code: string;
  language?: string;
  caption?: string;
  /** Start expanded instead of collapsed. Defaults to collapsed. */
  defaultOpen?: boolean;
}

/**
 * CodeBlock — a dark, monospace, copyable code listing that collapses by
 * default (react-guide behavior). Pages full of examples don't become a wall
 * of code: the language label + chevron toggle stay visible, the source is one
 * click away, and the copy button works whether open or closed.
 *
 * The code string is rendered as text content (never dangerouslySetInnerHTML)
 * so it appears verbatim: whitespace-pre + horizontal scroll, no reformatting.
 * The panel inverts the surface pair (bg-on-surface / text-surface) so code
 * reads as a distinct dark slab in light mode; in dark mode it falls back to
 * the surface-variant panel via the `dark:` variant.
 */
export function CodeBlock({ code, language, caption, defaultOpen = false }: CodeBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!(await copyToClipboard(code))) return;
    setCopied(true);
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <figure className="w-full overflow-hidden rounded-md border border-outline bg-on-surface shadow-button-card dark:bg-surface-variant">
      <div className="flex items-center justify-between gap-sm border-b border-surface/10 px-md py-xs dark:border-outline">
        <button
          type="button"
          onClick={() => setOpen((isOpen) => !isOpen)}
          aria-expanded={open}
          className="flex cursor-pointer items-center gap-xs rounded-pill border border-surface/20 px-sm font-mono text-overline uppercase tracking-wide text-surface/80 hover:text-surface dark:border-outline dark:text-on-surface-variant dark:hover:text-on-surface"
        >
          <span aria-hidden className="inline-block w-[10px] text-center">
            {open ? '▾' : '▸'}
          </span>
          {language ?? 'code'}
        </button>
        <button
          type="button"
          onClick={(event) => {
            void handleCopy(event);
          }}
          aria-live="polite"
          className="rounded-sm px-xs py-xxs font-mono text-caption text-surface/70 hover:bg-surface/10 hover:text-surface dark:text-on-surface-variant dark:hover:bg-on-surface/10 dark:hover:text-on-surface"
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      {open && (
        <>
          <pre className="overflow-x-auto whitespace-pre px-md py-md font-mono text-body-sm leading-relaxed text-surface dark:text-on-surface">
            <code>{code}</code>
          </pre>
          {caption !== undefined && (
            <figcaption className="border-t border-surface/10 px-md py-xs text-caption text-surface/70 dark:border-outline dark:text-on-surface-variant">
              {caption}
            </figcaption>
          )}
        </>
      )}
    </figure>
  );
}

/**
 * Copy via the async clipboard API when available, falling back to a hidden
 * textarea + execCommand for non-secure contexts. Returns whether the copy
 * definitely succeeded; failures stay silent (the button simply keeps its
 * "copy" label).
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
