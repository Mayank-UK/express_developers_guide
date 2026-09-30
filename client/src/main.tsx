import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import './index.css';
import { router } from './ui/routing/router';
import { ThemeProvider } from './ui/design-system/theme-provider';
import { getInitialMode } from './ui/design-system/theme';
import { container } from './core/container';
import { createAppConfig } from './core/config';

/**
 * Initialize the dependency container from the active Vite environment before
 * rendering — the composition root. This is where every singleton (http
 * client, repositories, use cases) gets wired; screens then resolve use cases
 * from the container instead of constructing dependencies themselves.
 */
container.initialize(createAppConfig());

// Apply the theme BEFORE the first React render so the correct tokens paint
// immediately (dark is the default; a stored light preference must not flash
// dark after hydration). ThemeProvider keeps the attribute in sync from here.
document.documentElement.setAttribute('data-theme', getInitialMode());

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
);
