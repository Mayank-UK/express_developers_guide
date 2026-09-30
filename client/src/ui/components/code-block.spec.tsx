import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CodeBlock } from './code-block';

const CODE = 'const app = express();\n\napp.get("/health", (req, res) => {\n  res.json({ status: "ok" });\n});';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CodeBlock', () => {
  it('renders collapsed by default: label visible, code and caption hidden', () => {
    const { container } = render(
      <CodeBlock code={CODE} language="ts" caption="The health route from this guide's server." />,
    );

    const toggle = screen.getByRole('button', { name: 'ts' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('code')).toBeNull();
    expect(container.querySelector('figcaption')).toBeNull();
    expect(screen.queryByText(/health route/)).toBeNull();
  });

  it('defaults the language label and omits the caption when absent', () => {
    const { container } = render(<CodeBlock code={CODE} />);

    expect(screen.getByRole('button', { name: 'code' })).toBeInTheDocument();
    expect(container.querySelector('figcaption')).toBeNull();
  });

  it('expands on toggle to render the code verbatim with its caption, and collapses again', () => {
    const { container } = render(
      <CodeBlock code={CODE} language="ts" caption="The health route from this guide's server." />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'ts' }));

    const toggle = screen.getByRole('button', { name: 'ts' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('code')?.textContent).toBe(CODE);
    expect(screen.getByText(/health route/)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('code')).toBeNull();
  });

  it('starts expanded when defaultOpen is set', () => {
    const { container } = render(<CodeBlock code={CODE} language="ts" defaultOpen />);

    expect(screen.getByRole('button', { name: 'ts' })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('code')?.textContent).toBe(CODE);
  });

  it('copies via the async clipboard while collapsed and shows copied feedback', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const { container } = render(<CodeBlock code={CODE} language="ts" />);

    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument(),
    );
    expect(writeText).toHaveBeenCalledWith(CODE);
    // Copying never expands the block.
    expect(screen.getByRole('button', { name: 'ts' })).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('code')).toBeNull();
  });

  it('falls back to the legacy copy path when the async clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const originalExecCommand = document.execCommand;
    document.execCommand = () => true;

    try {
      render(<CodeBlock code={CODE} />);

      fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument(),
      );
    } finally {
      document.execCommand = originalExecCommand;
    }
  });
});
