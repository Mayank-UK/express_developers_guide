import { useTheme } from '../design-system/theme';

/**
 * ThemeToggle — switches between light and dark design-system themes.
 * Always visible in the header.
 */
export function ThemeToggle() {
  const { mode, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-md px-sm py-xxs text-body text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
      aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${mode === 'dark' ? 'light' : 'dark'} theme`}
    >
      {mode === 'dark' ? '☀︎' : '☾'}
    </button>
  );
}
