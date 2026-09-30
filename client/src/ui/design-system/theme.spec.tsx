import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getInitialMode, STORAGE_KEY, useTheme } from './theme';
import { ThemeProvider } from './theme-provider';
import { ThemeToggle } from '../components/theme-toggle';

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('getInitialMode', () => {
  it('defaults to dark when nothing is stored', () => {
    expect(getInitialMode()).toBe('dark');
  });

  it('returns a valid stored value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');
    expect(getInitialMode()).toBe('light');

    window.localStorage.setItem(STORAGE_KEY, 'dark');
    expect(getInitialMode()).toBe('dark');
  });

  it('falls back to dark on a garbage stored value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'neon');
    expect(getInitialMode()).toBe('dark');
  });
});

describe('ThemeProvider', () => {
  it('applies and persists dark by default', async () => {
    render(
      <ThemeProvider>
        <p>themed</p>
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark'),
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('respects a stored light preference across a "reload" (no dark flash)', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');

    render(
      <ThemeProvider>
        <p>themed</p>
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('light'),
    );
  });

  it('toggle flips the attribute and the persisted value', async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark'),
    );

    const toggle = screen.getByRole('button', { name: 'Switch to light theme' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('light'),
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(
      screen.getByRole('button', { name: 'Switch to dark theme' }),
    ).toBeInTheDocument();
  });

  it('useTheme throws outside a provider', () => {
    function Orphan() {
      useTheme();
      return null;
    }

    // Silence the expected console noise from the thrown render error.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Orphan />)).toThrow(/ThemeProvider/);
    } finally {
      spy.mockRestore();
    }
  });
});
