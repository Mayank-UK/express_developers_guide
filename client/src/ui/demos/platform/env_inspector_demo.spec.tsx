import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import EnvInspectorDemo from './env_inspector_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * jsdom talks to a stub of GET /api/demo/env/inspect shaped like the real
 * endpoint's payload (mirroring what a dev run actually reports: nodeEnv
 * development after the vitest mapping, .env.development derived, mongo on,
 * redis off, one hidden secret-shaped name). The server spec pins the real
 * endpoint against the imported appConfig and attacks the masking contract.
 */

const INSPECT_URL = '/api/demo/env/inspect';

const INSPECT = {
  nodeEnv: 'development',
  port: 4000,
  grpcPort: 50051,
  logLevel: 'debug',
  dbPath: 'data/guide.db',
  mongoConfigured: true,
  redisConfigured: false,
  nodeVersion: 'v22.11.0',
  pid: 4242,
  cwd: '/repo/server',
  envFileLoaded: '.env.development',
  envFileExists: true,
  maskedEnv: {
    NODE_ENV: 'development',
    PORT: '4000',
    GRPC_PORT: 'unset',
    LOG_LEVEL: 'debug',
    SQLITE_PATH: 'data/guide.db',
    MONGO_URI: 'set (hidden)',
    REDIS_URL: 'unset',
  },
  hiddenSecretNames: ['DEMO_API_TOKEN'],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EnvInspectorDemo — the config inspector', () => {
  it('renders the config grid from the payload: config values, process facts, derived file', async () => {
    stubApiFetch([{ url: INSPECT_URL, body: INSPECT }]);

    render(<EnvInspectorDemo />);

    const grid = await screen.findByTestId('env-config-grid');
    expect(screen.queryByTestId('env-loading')).toBeNull();
    const cards = screen.getAllByTestId('env-config-card');
    expect(cards.length).toBeGreaterThanOrEqual(8);
    expect(grid).toHaveTextContent('development');
    expect(grid).toHaveTextContent('4000');
    expect(grid).toHaveTextContent('v22.11.0');
    expect(grid).toHaveTextContent('.env.development');
    expect(grid).toHaveTextContent('found on disk');
    // The optional-service chips agree with the flags.
    expect(grid.parentElement).toHaveTextContent('mongo: configured');
    expect(grid.parentElement).toHaveTextContent('redis: off');
  });

  it('the masked table shows config values but NEVER a service URI value', async () => {
    stubApiFetch([{ url: INSPECT_URL, body: INSPECT }]);

    render(<EnvInspectorDemo />);

    const table = await screen.findByTestId('env-masked-table');
    const rows = screen.getAllByTestId('env-masked-row');
    expect(rows.length).toBe(7);
    // Configuration is shown.
    expect(table).toHaveTextContent('NODE_ENV');
    expect(table).toHaveTextContent('development');
    // Service URIs are set-hidden or unset — and never a value.
    expect(table).toHaveTextContent('MONGO_URI');
    expect(table).toHaveTextContent('set (hidden)');
    expect(table).toHaveTextContent('REDIS_URL');
    expect(table).toHaveTextContent('unset');
    expect(table.textContent ?? '').not.toContain('mongodb://');
    expect(table.textContent ?? '').not.toContain('redis://');
  });

  it('secret-shaped names are counted by NAME only — values never rendered', async () => {
    stubApiFetch([{ url: INSPECT_URL, body: INSPECT }]);

    render(<EnvInspectorDemo />);

    const secrets = await screen.findByTestId('env-secrets');
    expect(secrets).toHaveTextContent('DEMO_API_TOKEN');
    expect(secrets).toHaveTextContent('names only');
  });

  it('renders the static what-differs strip: dev vs staging vs production from the real files', async () => {
    stubApiFetch([{ url: INSPECT_URL, body: INSPECT }]);

    render(<EnvInspectorDemo />);

    const differs = await screen.findByTestId('env-differs');
    expect(differs).toHaveTextContent('.env.development');
    expect(differs).toHaveTextContent('.env.staging');
    expect(differs).toHaveTextContent('.env.production');
    expect(differs).toHaveTextContent('LOG_LEVEL=debug');
    expect(differs).toHaveTextContent('both features boot OFF');
    expect(differs).toHaveTextContent('deliberately unset');
    // The strip renders even before the fetch resolves (it is static), and it
    // carries the one-artifact argument.
    expect(differs).toHaveTextContent('only variables differ');
  });

  it('a malformed payload degrades to the error strip; the static strip survives', async () => {
    stubApiFetch([{ url: INSPECT_URL, body: { nonsense: true } }]);

    render(<EnvInspectorDemo />);

    await screen.findByTestId('env-error');
    expect(screen.getByTestId('env-summary')).toBeDefined();
    expect(screen.queryByTestId('env-config-grid')).toBeNull();
    expect(screen.getByTestId('env-differs')).toBeDefined();
  });

  it('an unreachable API shows the error strip without crashing', async () => {
    stubNetworkFailure();

    render(<EnvInspectorDemo />);

    await screen.findByTestId('env-error');
    expect(screen.getByTestId('env-error')).toHaveTextContent('unreachable');
  });
});
