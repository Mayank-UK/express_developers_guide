import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SectionWrapper } from './section-wrapper';

describe('SectionWrapper', () => {
  it('renders an anchorable section with title, lead, and children', () => {
    const { container } = render(
      <SectionWrapper id="routing" title="Routing" lead="How URLs meet handlers">
        <p>section body</p>
      </SectionWrapper>,
    );

    const heading = screen.getByRole('heading', { level: 2, name: 'Routing' });
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    expect(section?.getAttribute('id')).toBe('routing');
    expect(container.querySelector('#routing')).toBe(section);
    expect(screen.getByText('How URLs meet handlers')).toBeInTheDocument();
    expect(screen.getByText('section body')).toBeInTheDocument();
  });

  it('omits the lead paragraph when no lead is provided', () => {
    const { container } = render(<SectionWrapper id="bare" title="Bare">content</SectionWrapper>);

    expect(screen.getByRole('heading', { level: 2, name: 'Bare' })).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });
});
