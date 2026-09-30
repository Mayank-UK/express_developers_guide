import { createContext, useContext } from 'react';

/**
 * Theme context + hook, split from <ThemeProvider/> so the provider file only
 * exports a component (keeps React Fast Refresh happy). Ported from the react
 * guide with one deliberate divergence: DARK is the default (user review) — a
 * backend guide reads best on a dark slab, so an unknown preference means
 * dark, not the OS preference.
 */

export type ThemeMode = 'light' | 'dark';

export interface ThemeContextValue {
  mode: ThemeMode;
  toggle: () => void;
  setMode: (mode: ThemeMode) => void;
}

export const STORAGE_KEY = 'edg-theme';

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Stored value wins when it is one of the two valid modes; anything else
 * (including "never visited") falls back to dark. The window guard keeps this
 * safe if it is ever called during SSR/prerender.
 */
export function getInitialMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return 'dark';
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
