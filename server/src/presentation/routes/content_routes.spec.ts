import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { CONTENT_API_VERSION, TOPIC_GROUPS } from '../../content/types.js';
import { ContentService } from '../../domain/content/content_service.js';
import { getTopicById, getTopicSummaries } from '../../content/registry.js';
import { UUID_RE } from '../../test_support/index.js';

/**
 * The 40-topic id contract, in served order (group order, then topic order).
 * These ids match the client nav registry — renaming any of them breaks the
 * client, which is exactly what this test guards.
 */
const EXPECTED_TOPIC_IDS = [
  'typescript-javascript',
  'node-js',
  'http-web',
  'express-fundamentals',
  'routing',
  'middleware',
  'request-response',
  'validation',
  'api-design',
  'api-documentation',
  'graphql',
  'webhooks',
  'grpc',
  'sql-schema',
  'sql-node',
  'mongodb',
  'redis',
  'caching',
  'messaging',
  'authentication',
  'authorization',
  'security',
  'files-media',
  'internationalization',
  'realtime',
  'background-jobs',
  'exception-handling',
  'dependency-management',
  'architecture',
  'observability',
  'testing',
  'debugging',
  'environments',
  'deployment',
  'performance',
  'reliability',
  'scaling',
  'best-practices',
  'third-party',
  'advanced-architecture',
] as const;

describe('GET /api/content', () => {
  it('serves the versioned topic tree: groups ordered, 40 summaries, no sections payload', async () => {
    const res = await request(createApp()).get('/api/content');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(CONTENT_API_VERSION);
    expect(res.body.groups).toEqual(TOPIC_GROUPS);
    // Groups must be ordered by their order field.
    const orders: number[] = res.body.groups.map((group: { order: number }) => group.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);

    // The full 38-id contract, in (group order, topic order).
    expect(res.body.topics).toHaveLength(40);
    expect(res.body.topics.map((topic: { id: string }) => topic.id)).toEqual([
      ...EXPECTED_TOPIC_IDS,
    ]);

    for (const topic of res.body.topics) {
      expect(topic).not.toHaveProperty('sections');
      expect(typeof topic.sectionCount).toBe('number');
      expect(typeof topic.title).toBe('string');
      expect(typeof topic.subtitle).toBe('string');
      expect(TOPIC_GROUPS.some((group) => group.id === topic.group)).toBe(true);
    }

    const expressFundamentals = res.body.topics.find(
      (topic: { id: string }) => topic.id === 'express-fundamentals',
    );
    expect(expressFundamentals.sectionCount).toBeGreaterThanOrEqual(4);
  });
});

describe('GET /api/content/topics/:id', () => {
  it('returns the fully populated express-fundamentals topic with unique ids and all block kinds', async () => {
    const res = await request(createApp()).get('/api/content/topics/express-fundamentals');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(CONTENT_API_VERSION);
    expect(res.body.id).toBe('express-fundamentals');
    expect(res.body.sections.length).toBeGreaterThanOrEqual(4);

    const sectionIds = new Set<string>();
    const blockIds = new Set<string>();
    const kinds = new Set<string>();
    const demoIds: string[] = [];
    for (const section of res.body.sections) {
      expect(typeof section.title).toBe('string');
      expect(section.blocks.length).toBeGreaterThanOrEqual(2);
      expect(sectionIds.has(section.id)).toBe(false);
      sectionIds.add(section.id);

      for (const block of section.blocks) {
        expect(blockIds.has(block.id), `block id ${block.id} must be unique`).toBe(false);
        blockIds.add(block.id);
        kinds.add(block.kind);
        if (block.kind === 'demo') demoIds.push(block.demoId);
        if (block.kind === 'code') {
          expect(typeof block.language).toBe('string');
          expect(typeof block.code).toBe('string');
        }
        if (block.kind === 'text') expect(typeof block.body).toBe('string');
      }
    }

    expect([...kinds].sort()).toEqual(['code', 'demo', 'text']);
    expect(demoIds).toContain('express:app-info');
  });

  it('rejects malformed ids with a validation failure before lookup (service level)', () => {
    // Same wiring as the container: the domain receives the registry functions
    // through its lookup port — never imports the registry itself.
    const service = new ContentService({ topics: { getTopicById, getTopicSummaries } });
    for (const bad of [undefined, 42, '', '   ']) {
      const result = service.getTopic(bad);
      expect(result.ok, `id ${String(bad)}`).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('validation');
    }
  });

  it('404s with the error envelope for unknown ids — including ids containing dots', async () => {
    for (const id of ['does-not-exist', 'a.b', 'Express-Fundamentals']) {
      const res = await request(createApp()).get(`/api/content/topics/${encodeURIComponent(id)}`);

      expect(res.status, `id "${id}"`).toBe(404);
      // The envelope merges failure details flat (topicId here) alongside the
      // canonical keys — toMatchObject asserts the canonical shape.
      expect(res.body.error).toMatchObject({
        code: 'not_found',
        message: expect.any(String),
        requestId: expect.stringMatching(UUID_RE),
      });
      expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    }
  });
});

describe('GET /api/content/topics/:id — the API section topics', () => {
  it('serves the fully populated api-design topic (8 sections, all block kinds, the workbench demo)', async () => {
    const res = await request(createApp()).get('/api/content/topics/api-design');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(CONTENT_API_VERSION);
    expect(res.body.id).toBe('api-design');
    expect(res.body.sections.length).toBeGreaterThanOrEqual(8);

    const blockIds = new Set<string>();
    const kinds = new Set<string>();
    const demoIds: string[] = [];
    for (const section of res.body.sections) {
      expect(section.blocks.length).toBeGreaterThanOrEqual(2);
      for (const block of section.blocks) {
        expect(blockIds.has(block.id), `block id ${block.id} must be unique`).toBe(false);
        blockIds.add(block.id);
        kinds.add(block.kind);
        if (block.kind === 'demo') demoIds.push(block.demoId);
        if (block.kind === 'code') expect(block.code.length).toBeGreaterThan(0);
      }
    }

    expect([...kinds].sort()).toEqual(['code', 'demo', 'text']);
    expect(demoIds).toContain('api:posts-workbench');
  });

  it('serves the fully populated api-documentation topic with the docs-link demo', async () => {
    const res = await request(createApp()).get('/api/content/topics/api-documentation');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(CONTENT_API_VERSION);
    expect(res.body.id).toBe('api-documentation');
    expect(res.body.sections.length).toBeGreaterThanOrEqual(7);

    const demoIds: string[] = [];
    const blockIds = new Set<string>();
    for (const section of res.body.sections) {
      for (const block of section.blocks) {
        expect(blockIds.has(block.id), `block id ${block.id} must be unique`).toBe(false);
        blockIds.add(block.id);
        if (block.kind === 'demo') demoIds.push(block.demoId);
      }
    }
    expect(demoIds).toContain('api:docs-link');
  });

  it('advertises both API topics as populated in the index', async () => {
    const res = await request(createApp()).get('/api/content');

    expect(res.status).toBe(200);
    for (const id of ['api-design', 'api-documentation']) {
      const summary = (res.body.topics as Array<{ id: string; sectionCount: number }>).find(
        (topic) => topic.id === id,
      );
      expect(summary, `topic ${id} in the index`).toBeDefined();
      expect(summary?.sectionCount).toBeGreaterThanOrEqual(7);
    }
  });
});
