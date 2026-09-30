import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ArchTracerDemo from './arch_tracer_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * jsdom talks to stubs of the two arch endpoints shaped like the real
 * payloads. The server spec pins the LIVE contract: six layers in order,
 * honest notes, totalMs ≥ max bar, requestId === x-request-id, and the real
 * folder walk — including failure-injection and live-mode variants. Here we
 * prove the console renders what the tracer reports and that the tree's
 * expand toggles work.
 */

const TRACE_URL = '/api/demo/arch/trace';
const FOLDERS_URL = '/api/demo/arch/folders';

const LAYERS = [
  { layer: 'request-id middleware', ms: 0.412, note: 'pre-route chain' },
  { layer: 'route + controller (parse)', ms: 0.021, note: 'translation only' },
  { layer: 'use case (validation + scenario check)', ms: 1.8, note: 'INCLUDES THE REPOSITORY call' },
  { layer: 'repository selector (fake | live)', ms: 0.004, note: 'Current mode: fake' },
  { layer: 'repository / dao', ms: 1.796, note: 'DERIVED (use-case total minus the measured selector read)' },
  { layer: 'response serialization', ms: 0.05, note: 'JSON.stringify({ posts })' },
];

const TRACE = {
  trace: LAYERS,
  totalMs: 2.4,
  mode: 'fake',
  injectFailure: false,
  postCount: 4,
  requestId: '7a4f2c1e-9b3d-4e8a-a1c2-3d4e5f6a7b8c',
};

const FOLDERS = {
  root: 'server/src',
  truncated: false,
  purposes: {
    presentation: 'HTTP concerns: routes + thin controllers, middleware',
    domain: 'business rules: use cases, entities and PORTS',
    data: 'persistence implementations of the domain\u2019s ports',
    core: 'cross-cutting primitives: config, Result, error taxonomy',
    di: 'the composition root',
    content: 'the guide\u2019s own payload',
  },
  tree: [
    { name: 'app.ts', kind: 'file' },
    { name: 'core', kind: 'dir', children: [{ name: 'config', kind: 'dir', children: [{ name: 'app_config.ts', kind: 'file' }] }] },
    { name: 'data', kind: 'dir', children: [{ name: 'posts', kind: 'dir', children: [] }] },
    { name: 'di', kind: 'dir', children: [{ name: 'container.ts', kind: 'file' }] },
    {
      name: 'domain',
      kind: 'dir',
      children: [
        { name: 'posts', kind: 'dir', children: [{ name: 'post_repository.ts', kind: 'file' }] },
        { name: 'post.ts', kind: 'file' },
      ],
    },
    { name: 'content', kind: 'dir', children: [{ name: 'topics', kind: 'dir', children: [] }] },
    {
      name: 'presentation',
      kind: 'dir',
      children: [
        { name: 'routes', kind: 'dir', children: [{ name: 'index.ts', kind: 'file' }] },
        { name: 'middleware', kind: 'dir', children: [] },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArchTracerDemo — panel 1: the request-flow tracer', () => {
  it('renders all six layers in order with mode + requestId chips and the total after a run', async () => {
    stubApiFetch([
      { url: TRACE_URL, body: TRACE },
      { url: FOLDERS_URL, body: FOLDERS },
    ]);

    render(<ArchTracerDemo />);
    fireEvent.click(screen.getByTestId('arch-run-button'));

    const layers = await screen.findByTestId('arch-layers');
    const cards = await waitFor(() => screen.getAllByTestId('arch-layer-card'));
    expect(cards.length).toBe(6);
    expect(cards[0]).toHaveTextContent('request-id middleware');
    expect(cards[5]).toHaveTextContent('response serialization');
    // The honesty notes ride along on every card.
    expect(cards[2]).toHaveTextContent('INCLUDES THE REPOSITORY');
    expect(cards[4]).toHaveTextContent('DERIVED');

    const modeChip = screen.getByTestId('arch-mode-chip');
    expect(modeChip).toHaveTextContent('mode: fake');
    expect(screen.getByTestId('arch-request-chip')).toHaveTextContent('7a4f2c1e-9b3d');
    const total = screen.getByTestId('arch-total');
    expect(total).toHaveTextContent('total: 2.4ms');
    expect(total).toHaveTextContent('x-request-id');
    expect(layers).toBeDefined();
  });

  it('bars scale against the slowest layer: the max layer spans full width, a zero-ish layer does not', async () => {
    stubApiFetch([
      { url: TRACE_URL, body: TRACE },
      { url: FOLDERS_URL, body: FOLDERS },
    ]);

    render(<ArchTracerDemo />);
    fireEvent.click(screen.getByTestId('arch-run-button'));

    await screen.findByTestId('arch-layers');
    const bars = screen.getAllByTestId('arch-layer-bar');
    expect(bars.length).toBe(6);
    const widths = bars.map((bar) => (bar as HTMLElement).style.width);
    // The use-case layer (1.8ms, the max) is the fullest bar; the selector
    // (0.004ms) is clamped to the 2% visibility floor.
    expect(widths[2]).toBe('100%');
    expect(widths[3]).toBe('2%');
  });

  it('a failure-injection trace renders the domain-gate strip and the failure chips', async () => {
    stubApiFetch([
      {
        url: TRACE_URL,
        body: {
          ...TRACE,
          mode: 'live',
          injectFailure: true,
          postCount: 0,
          failure: { kind: 'unavailable', message: 'Failure injection is ON — this is the demo 503' },
        },
      },
      { url: FOLDERS_URL, body: FOLDERS },
    ]);

    render(<ArchTracerDemo />);
    fireEvent.click(screen.getByTestId('arch-run-button'));

    const failure = await screen.findByTestId('arch-failure');
    expect(failure).toHaveTextContent('unavailable');
    expect(failure).toHaveTextContent('Failure injection is ON');
    expect(screen.getByTestId('arch-mode-chip')).toHaveTextContent('mode: live');
  });

  it('degrades to the error strip on a network failure without crashing', async () => {
    stubNetworkFailure();

    render(<ArchTracerDemo />);
    fireEvent.click(screen.getByTestId('arch-run-button'));

    await screen.findByTestId('arch-error');
    expect(screen.getByTestId('arch-summary')).toBeDefined();
  });
});

describe('ArchTracerDemo — panel 2: the live folder map', () => {
  it('renders the six directories with their purpose lines from the payload', async () => {
    stubApiFetch([
      { url: TRACE_URL, body: TRACE },
      { url: FOLDERS_URL, body: FOLDERS },
    ]);

    render(<ArchTracerDemo />);

    const tree = await screen.findByTestId('arch-tree');
    const dirs = screen.getAllByTestId('arch-tree-dir');
    const names = dirs.map((dir) => dir.textContent ?? '');
    for (const expected of ['core/', 'data/', 'di/', 'domain/', 'content/', 'presentation/']) {
      expect(names).toContain(expected);
    }
    // Files at the root are not expandable rows.
    expect(tree).toHaveTextContent('server/src');
    expect(screen.queryByText('app.ts')).toBeNull();
    // Purposes render beside their dirs.
    const purposes = screen.getAllByTestId('arch-purpose');
    expect(purposes.length).toBe(6);
    expect(tree).toHaveTextContent('HTTP concerns');
    expect(tree).toHaveTextContent('composition root');
  });

  it('expand toggles work: a top-level dir opens one level and closes again', async () => {
    stubApiFetch([
      { url: TRACE_URL, body: TRACE },
      { url: FOLDERS_URL, body: FOLDERS },
    ]);

    render(<ArchTracerDemo />);
    await screen.findByTestId('arch-tree');

    const domainToggle = screen
      .getAllByTestId('arch-tree-expand')
      .find((button) => button.parentElement?.textContent?.includes('domain/'));
    expect(domainToggle).toBeDefined();
    fireEvent.click(domainToggle as HTMLElement);

    const children = await screen.findByTestId('arch-tree-children');
    expect(children).toHaveTextContent('posts/');
    expect(children).toHaveTextContent('post.ts');
    // Sub-directories report their own entry count; deeper expansion is
    // capped (the live walk serves three levels).
    expect(children).toHaveTextContent('1 entries');
    expect(children).toHaveTextContent('depth capped');

    fireEvent.click(domainToggle as HTMLElement);
    expect(screen.queryByTestId('arch-tree-children')).toBeNull();
  });

  it('a malformed folders payload degrades to the folder error strip; the tracer keeps working', async () => {
    stubApiFetch([
      { url: TRACE_URL, body: TRACE },
      { url: FOLDERS_URL, body: { nonsense: true } },
    ]);

    render(<ArchTracerDemo />);
    await screen.findByTestId('arch-folders-error');

    fireEvent.click(screen.getByTestId('arch-run-button'));
    await screen.findByTestId('arch-layers');
    expect(screen.getAllByTestId('arch-layer-card').length).toBe(6);
  });
});
