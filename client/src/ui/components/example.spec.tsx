import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Example } from './example';

describe('Example', () => {
  it('renders the demo panel with title, description, and children', () => {
    render(
      <Example title="Route explorer" description="Inspect how middleware orders itself">
        <button type="button">run demo</button>
      </Example>,
    );

    expect(
      screen.getByRole('heading', { level: 3, name: 'Route explorer' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Inspect how middleware orders itself')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'run demo' })).toBeInTheDocument();
  });

  it('omits the description when not provided', () => {
    render(<Example title="Bare demo">body</Example>);

    expect(screen.getByRole('heading', { level: 3, name: 'Bare demo' })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });
});
