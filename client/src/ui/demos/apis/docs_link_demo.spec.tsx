import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import DocsLinkDemo from './docs_link_demo';

describe('DocsLinkDemo', () => {
  it('renders a prominent link to the Swagger UI at /docs, opening safely in a new tab', () => {
    render(<DocsLinkDemo />);

    const open = screen.getByTestId('docs-link-open');
    expect(open).toHaveAttribute('href', expect.stringMatching(/\/docs\/$/));
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(open).toHaveTextContent('/docs');
  });

  it('renders the raw spec link beside it, same safety attributes', () => {
    render(<DocsLinkDemo />);

    const spec = screen.getByTestId('docs-link-spec');
    expect(spec).toHaveAttribute('href', expect.stringMatching(/\/docs\/openapi\.json$/));
    expect(spec).toHaveAttribute('target', '_blank');
    expect(spec).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(spec).toHaveTextContent('openapi.json');
  });

  it('says what the reader will find there — the real paths, the envelope, try-it-out', () => {
    render(<DocsLinkDemo />);

    const notes = screen.getByTestId('docs-link-notes');
    expect(notes).toHaveTextContent('GET /api/posts');
    expect(notes).toHaveTextContent('error envelope');
    expect(notes).toHaveTextContent('try it out');
  });
});
