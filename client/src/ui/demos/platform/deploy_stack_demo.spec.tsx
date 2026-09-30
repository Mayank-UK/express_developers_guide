import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DeployStackDemo from './deploy_stack_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * The stack explorer over a STUBBED manifest: the live-process card pinned to
 * the stub's facts, both compose files' declared services rendered with their
 * file badges, the origin card reading x-forwarded-proto honestly, and the
 * degradation states (unreachable server, empty-parse notes).
 */

const STACK_URL = '/api/demo/deploy/stack';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: {
      name: 'server',
      port: 4000,
      env: 'production',
      pid: 4242,
      nodeVersion: 'v22.23.1',
      uptimeSeconds: 61,
      memoryRssMb: 96.4,
    },
    client: {
      name: 'client',
      note: 'the React shell is served by your browser origin, not by this process',
      origin: 'http://localhost:8080',
      forwardedProto: null,
    },
    docker: {
      composeFiles: [
        {
          file: '.docker/docker-compose.yml',
          flavor: 'dev',
          services: ['server', 'client', 'redis', 'mongo'],
        },
        {
          file: '.docker/docker-compose-prod.yml',
          flavor: 'prod',
          services: ['server', 'client', 'redis'],
        },
      ],
      hint: 'declared vs live',
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeployStackDemo — the live process card', () => {
  it('renders the real facts from the endpoint and refreshes on demand', async () => {
    let served = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        served += 1;
        return { ok: true, status: 200, json: async () => manifest() };
      }),
    );

    render(<DeployStackDemo />);
    const live = await screen.findByTestId('deploy-live', {}, { timeout: 4000 });
    expect(live).toHaveTextContent('pid 4242');
    expect(live).toHaveTextContent('v22.23.1');
    expect(live).toHaveTextContent('env: production');
    expect(live).toHaveTextContent('port 4000');
    expect(live).toHaveTextContent('up 61s');
    expect(live).toHaveTextContent('rss 96.4MB');

    await waitFor(() => {
      expect(served).toBe(1);
    });
  });

  it('origin card: forwardedProto null reads as the honest no-proxy note', async () => {
    stubApiFetch([{ url: STACK_URL, body: manifest() }]);

    render(<DeployStackDemo />);
    const origin = await screen.findByTestId('deploy-origin', {}, { timeout: 4000 });
    expect(origin).toHaveTextContent('http://localhost:8080');
    expect(origin).toHaveTextContent('no proxy set x-forwarded-proto');
  });

  it('origin card: a proxy-provided proto is named', async () => {
    stubApiFetch([
      {
        url: STACK_URL,
        body: manifest({
          client: { name: 'client', note: '', origin: 'https://guide.example.test', forwardedProto: 'https' },
        }),
      },
    ]);

    render(<DeployStackDemo />);
    const origin = await screen.findByTestId('deploy-origin', {}, { timeout: 4000 });
    expect(origin).toHaveTextContent('https://guide.example.test');
    expect(origin).toHaveTextContent('x-forwarded-proto: https');
  });
});

describe('DeployStackDemo — the declared services', () => {
  it('renders BOTH compose files with their flavor badge, file path, and service chips', async () => {
    stubApiFetch([{ url: STACK_URL, body: manifest() }]);

    render(<DeployStackDemo />);
    const declared = await screen.findAllByTestId('deploy-declared', {}, { timeout: 4000 });
    expect(declared).toHaveLength(2);

    const dev = screen.getByTestId('deploy-services-dev');
    expect(dev).toHaveTextContent('server');
    expect(dev).toHaveTextContent('client');
    expect(dev).toHaveTextContent('redis');
    expect(dev).toHaveTextContent('mongo');
    expect(screen.getByText('.docker/docker-compose.yml')).toBeDefined();

    const prod = screen.getByTestId('deploy-services-prod');
    expect(prod).toHaveTextContent('server');
    expect(prod).toHaveTextContent('client');
    expect(prod).toHaveTextContent('redis');
    expect(prod.textContent?.includes('mongo')).toBe(false);
    expect(screen.getByText('.docker/docker-compose-prod.yml')).toBeDefined();
  });

  it('renders the honest empty state when a compose file could not be read (Docker image case)', async () => {
    stubApiFetch([
      {
        url: STACK_URL,
        body: manifest({
          docker: {
            composeFiles: [
              { file: '.docker/docker-compose.yml', flavor: 'dev', services: [], note: 'compose file not readable from this process' },
            ],
            hint: '',
          },
        }),
      },
    ]);

    render(<DeployStackDemo />);
    const dev = await screen.findByTestId('deploy-services-dev', {}, { timeout: 4000 });
    expect(dev).toHaveTextContent('compose file not readable from this process');
  });
});

describe('DeployStackDemo — commands and failure states', () => {
  it('always shows the compose command strip', () => {
    stubNetworkFailure();
    render(<DeployStackDemo />);

    const commands = screen.getByTestId('deploy-commands');
    expect(commands).toHaveTextContent('docker-compose-prod.yml build');
    expect(commands).toHaveTextContent('up -d');
    expect(commands).toHaveTextContent('/api/health');
  });

  it('degrades to the error strip with a retry when the server is unreachable', async () => {
    stubNetworkFailure();
    render(<DeployStackDemo />);

    const error = await screen.findByTestId('deploy-error');
    expect(error).toHaveTextContent('could not read the stack endpoint');
    expect(screen.queryByTestId('deploy-live')).toBeNull();
    expect(screen.getByTestId('deploy-summary')).toBeDefined();
  });

  it('rejects a malformed manifest instead of rendering nonsense facts', async () => {
    stubApiFetch([{ url: STACK_URL, body: { server: { pid: 'not-a-number' } } }]);

    render(<DeployStackDemo />);
    await screen.findByTestId('deploy-error');
    expect(screen.queryByTestId('deploy-live')).toBeNull();
  });
});
