import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AboutView } from './about_view';

function renderAbout() {
  return render(
    <MemoryRouter>
      <AboutView />
    </MemoryRouter>,
  );
}

describe('AboutView', () => {
  it('renders the three sections', () => {
    renderAbout();

    expect(
      screen.getByRole('heading', { level: 1, name: 'About this guide' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'How this app is built' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'The guide family' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Explore' })).toBeInTheDocument();

    // Truthful claims only: the content API and the layering are described.
    expect(screen.getByText(/typed, versioned JSON/)).toBeInTheDocument();
    expect(screen.getByText(/routes accept HTTP and stay thin/)).toBeInTheDocument();
  });

  it('links to the topic map and the express fundamentals topic', () => {
    renderAbout();

    expect(screen.getByRole('link', { name: /^Topic map/ })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /^Express fundamentals/ })).toHaveAttribute(
      'href',
      '/topics/express-fundamentals',
    );
  });
});
