import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { appConfig } from '../../core/config/app_config.js';
import {
  DEPLOY_DEMO_MOUNT_PATH,
  parseComposeServices,
  readComposeFile,
  resolveRepoFile,
} from './deploy_demo_routes.js';

/**
 * The stack manifest is an fs + process introspection, so these specs pin it
 * against the same sources it reads: the imported appConfig and process
 * object for the live facts, the REAL compose files for the declared
 * services, and synthetic text for the tolerant parser's failure modes.
 */

interface ServerFacts {
  name: string;
  port: number;
  env: string;
  pid: number;
  nodeVersion: string;
  uptimeSeconds: number;
  memoryRssMb: number;
}

interface StackBody {
  server: ServerFacts;
  client: { name: string; note: string; origin: string; forwardedProto: string | null };
  docker: {
    composeFiles: { file: string; flavor: string; services: string[]; note?: string }[];
    hint: string;
  };
}

describe('GET /api/demo/deploy/stack — the live process facts', () => {
  it('reports THIS process: port/env from the imported appConfig, pid/node version from process', async () => {
    const res = await request(createApp()).get(`${DEPLOY_DEMO_MOUNT_PATH}/stack`);
    expect(res.status).toBe(200);

    const server = (res.body as StackBody).server;
    expect(server.name).toBe('server');
    expect(server.port).toBe(appConfig.port);
    expect(server.env).toBe(appConfig.nodeEnv);
    expect(server.pid).toBe(process.pid);
    expect(server.nodeVersion).toBe(process.version);
    expect(server.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(server.memoryRssMb).toBeGreaterThan(0);
  });

  it('derives the browser origin from the request Host header (the front door that served you)', async () => {
    const res = await request(createApp())
      .get(`${DEPLOY_DEMO_MOUNT_PATH}/stack`)
      .set('Host', 'guide.example.test:8080');
    expect(res.status).toBe(200);

    const client = (res.body as StackBody).client;
    expect(client.name).toBe('client');
    expect(client.origin).toBe('http://guide.example.test:8080');
    // No proxy set x-forwarded-proto → honestly null, origin falls back to http.
    expect(client.forwardedProto).toBeNull();
  });

  it('uses x-forwarded-proto when a TLS-terminating proxy provides it', async () => {
    const res = await request(createApp())
      .get(`${DEPLOY_DEMO_MOUNT_PATH}/stack`)
      .set('Host', 'guide.example.test')
      .set('x-forwarded-proto', 'https');
    const client = (res.body as StackBody).client;
    expect(client.forwardedProto).toBe('https');
    expect(client.origin).toBe('https://guide.example.test');
  });
});

describe('GET /api/demo/deploy/stack — the declared compose services', () => {
  it('parses the REAL compose files: dev declares server/client/redis/mongo, prod server/client/redis', async () => {
    const res = await request(createApp()).get(`${DEPLOY_DEMO_MOUNT_PATH}/stack`);
    expect(res.status).toBe(200);

    const files = (res.body as StackBody).docker.composeFiles;
    expect(files.map((file) => file.flavor)).toEqual(['dev', 'prod']);

    const dev = files.find((file) => file.flavor === 'dev');
    const prod = files.find((file) => file.flavor === 'prod');
    // File order preserved by the tolerant parse — the order a reader sees.
    expect(dev?.file).toBe('.docker/docker-compose.yml');
    expect(dev?.services).toEqual(['server', 'client', 'redis', 'mongo']);
    expect(prod?.file).toBe('.docker/docker-compose-prod.yml');
    expect(prod?.services).toEqual([
      'server',
      'client',
      'redis',
      'mongo',
      'caddy',
    ]);
    // Both real files parsed cleanly — no degradation notes.
    expect(dev?.note).toBeUndefined();
    expect(prod?.note).toBeUndefined();
  });
});

describe('parseComposeServices — the tolerant heuristic', () => {
  it('collects two-space-indented service keys and stops at the next top-level key', () => {
    const text = [
      'services:',
      '  server:',
      '    image: a',
      '  client:',
      '    build:',
      '      context: ./../',
      '',
      'networks:',
      '  frontend:',
    ].join('\n');
    expect(parseComposeServices(text)).toEqual(['server', 'client']);
  });

  it('tolerates comments and blank lines; ignores deeper-indented keys', () => {
    const text = [
      'services: # the stack',
      '',
      '  # a comment line',
      '  redis:   # optional service',
      '    volumes:',
      '      - redis_data:/data',
      'networks:',
    ].join('\n');
    expect(parseComposeServices(text)).toEqual(['redis']);
  });

  it('yields [] for input with no services block, an empty one, or pure junk', () => {
    expect(parseComposeServices('')).toEqual([]);
    expect(parseComposeServices('not yaml at all')).toEqual([]);
    expect(parseComposeServices('networks:\n  frontend:\n')).toEqual([]);
    expect(parseComposeServices('services:\nnetworks:\n')).toEqual([]);
  });
});

describe('readComposeFile — degradation, never a 500', () => {
  it('returns empty services + an honest note when the file is missing', () => {
    const snapshot = readComposeFile('.docker/no-such-compose.yml', 'test');
    expect(snapshot.services).toEqual([]);
    expect(snapshot.note).toContain('not readable');
  });

  it('resolveRepoFile points at the repo root (both real compose files exist there in dev)', () => {
    // Under the built tree the repo may be absent (the Docker image) — this
    // spec only pins the DEVELOPMENT claim; the missing-file path above pins
    // the dist/Docker story.
    expect(resolveRepoFile('.docker/docker-compose.yml')).toMatch(/\.docker\/docker-compose\.yml$/);
  });
});
