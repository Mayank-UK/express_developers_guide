import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ThemeContext,
  getInitialMode,
  STORAGE_KEY,
  type ThemeContextValue,
  type ThemeMode,
} from './theme';

/**
 * ThemeProvider owns light/dark mode. The active theme is written as
 * `data-theme` on <html>, which tokens.css keys off of, and persisted to
 * localStorage under 'edg-theme'. Default is dark (see theme.ts).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(getInitialMode);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode);
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      setMode,
      toggle: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')),
    }),
    [mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
