import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DepsManifestDemo from './deps_manifest_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * jsdom talks to a stub of GET /api/demo/deps/manifest shaped like the real
 * endpoint's payload (a trimmed manifest — three of the eighteen dependencies,
 * carrying the real express fact: wanted ^5.1.0, resolved 5.2.1). The server
 * spec pins the real endpoint against the real files; this spec proves the
 * console renders the contract and degrades honestly.
 */

const MANIFEST_URL = '/api/demo/deps/manifest';

const MANIFEST = {
  name: 'express_developers_guide_server',
  version: '0.0.0',
  nodeVersion: 'v22.11.0',
  dependencies: [
    { name: '@grpc/proto-loader', wanted: '^0.8.1', resolved: '0.8.1' },
    { name: 'express', wanted: '^5.1.0', resolved: '5.2.1' },
    { name: 'vitest-like-exact-pin', wanted: '4.1.10', resolved: '4.1.10' },
  ],
  devDependencyCount: 12,
  lockfile: { lockfileVersion: 3, packageCount: 345, generator: 'npm@12 (decision log)' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DepsManifestDemo — the manifest inspector', () => {
  it('renders the manifest table: wanted beside resolved, express telling the semver story', async () => {
    stubApiFetch([{ url: MANIFEST_URL, body: MANIFEST }]);

    render(<DepsManifestDemo />);

    const table = await screen.findByTestId('deps-table');
    expect(screen.queryByTestId('deps-loading')).toBeNull();
    const rows = screen.getAllByTestId('deps-row');
    expect(rows).toHaveLength(3);

    // The caret's real meaning: the range admitted a newer version.
    expect(table).toHaveTextContent('express');
    expect(table).toHaveTextContent('^5.1.0');
    expect(table).toHaveTextContent('5.2.1');
    // The 0.x row resolves to the typed version (caret collapses to patches).
    expect(table).toHaveTextContent('^0.8.1');
    expect(table).toHaveTextContent('0.8.1');
    // The header strip carries the manifest facts.
    expect(table.parentElement).toHaveTextContent('express_developers_guide_server@0.0.0');
    expect(table.parentElement).toHaveTextContent('12 devDependencies');
  });

  it('renders the lockfile stats with the transitive gap as the lesson', async () => {
    stubApiFetch([{ url: MANIFEST_URL, body: MANIFEST }]);

    render(<DepsManifestDemo />);

    const lockfile = await screen.findByTestId('deps-lockfile');
    expect(lockfile).toHaveTextContent('lockfileVersion: 3');
    expect(lockfile).toHaveTextContent('lockfile packages: 345');
    expect(lockfile).toHaveTextContent('direct dependencies: 3');
    // 345 - 3 = 342 packages nobody chose directly.
    expect(lockfile).toHaveTextContent('transitive gap: +342');
  });

  it('renders the npm@12 decision-log callout', async () => {
    stubApiFetch([{ url: MANIFEST_URL, body: MANIFEST }]);

    render(<DepsManifestDemo />);

    const callout = await screen.findByTestId('deps-npm12');
    expect(callout).toHaveTextContent('npm@12');
    expect(callout).toHaveTextContent('arborist');
    expect(callout).toHaveTextContent('npm ci');
  });

  it('a malformed payload degrades to the error strip without crashing', async () => {
    stubApiFetch([{ url: MANIFEST_URL, body: { nonsense: true } }]);

    render(<DepsManifestDemo />);

    await screen.findByTestId('deps-error');
    expect(screen.getByTestId('deps-summary')).toBeDefined();
    expect(screen.queryByTestId('deps-table')).toBeNull();
  });

  it('an unreachable API shows the error strip without crashing', async () => {
    stubNetworkFailure();

    render(<DepsManifestDemo />);

    await screen.findByTestId('deps-error');
    expect(screen.getByTestId('deps-error')).toHaveTextContent('unreachable');
  });
});
