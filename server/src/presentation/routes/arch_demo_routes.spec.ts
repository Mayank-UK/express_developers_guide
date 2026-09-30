import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { ARCH_DEMO_MOUNT_PATH } from './arch_demo_routes.js';
import { scenarioStore } from '../../core/scenario/scenario.js';
import { UUID_RE } from '../../test_support/index.js';

/**
 * The tracer runs the REAL pipeline (the container's postsUseCase, the live
 * scenario store), so these specs pin structure and honesty rather than exact
 * timings: six layers in order, non-negative ms, totalMs at least the largest
 * bar, the mode chip reflecting scenarioStore, and THIS request's requestId
 * matching the x-request-id header the middleware already set.
 */

const TRACE_URL = `${ARCH_DEMO_MOUNT_PATH}/trace`;
const FOLDERS_URL = `${ARCH_DEMO_MOUNT_PATH}/folders`;

const EXPECTED_LAYERS = [
  'request-id middleware',
  'route + controller (parse)',
  'use case (validation + scenario check)',
  'repository selector (fake | live)',
  'repository / dao',
  'response serialization',
] as const;

interface TraceLayerBody {
  layer: string;
  ms: number;
  note: string;
}

interface TraceBody {
  trace: TraceLayerBody[];
  totalMs: number;
  mode: string;
  injectFailure: boolean;
  postCount: number;
  requestId: string;
  failure?: { kind: string; message: string };
}

function assertTraceStructure(res: request.Response): TraceBody {
  const body = res.body as TraceBody;
  expect(body.trace.map((entry) => entry.layer)).toEqual([...EXPECTED_LAYERS]);
  for (const entry of body.trace) {
    expect(entry.ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(entry.ms)).toBe(true);
    expect(entry.note.length).toBeGreaterThan(0);
  }
  // Tolerant total: at least the largest single bar (sub-ms rounding).
  const maxLayer = Math.max(...body.trace.map((entry) => entry.ms));
  expect(body.totalMs + 1).toBeGreaterThanOrEqual(maxLayer);
  return body;
}

beforeEach(() => {
  scenarioStore.set({ dataMode: 'fake', injectFailure: false });
});

afterEach(() => {
  scenarioStore.reset();
});

describe('GET /api/demo/arch/trace', () => {
  it('returns six layers in order, honest non-negative timings, and a total covering the max bar', async () => {
    const res = await request(createApp()).get(TRACE_URL).expect(200);
    assertTraceStructure(res);
  });

  it('the trace IS this request: requestId matches the x-request-id header (fake mode reported)', async () => {
    const res = await request(createApp()).get(TRACE_URL).expect(200);
    const body = assertTraceStructure(res);
    expect(body.mode).toBe('fake');
    expect(body.injectFailure).toBe(false);
    expect(body.requestId).toMatch(UUID_RE);
    expect(body.requestId).toBe(res.headers['x-request-id']);
    expect(body.postCount).toBeGreaterThan(0);
    expect(body.failure).toBeUndefined();
    // The use-case bar says it includes the repository; the selector bar
    // names the current mode.
    expect(body.trace[2].note).toContain('INCLUDES THE REPOSITORY');
    expect(body.trace[3].note).toContain('fake');
  });

  it('follows the scenario into live mode: sqlite is reported, posts still served', async () => {
    scenarioStore.set({ dataMode: 'live', injectFailure: false });
    const res = await request(createApp()).get(TRACE_URL).expect(200);
    const body = assertTraceStructure(res);
    expect(body.mode).toBe('live');
    expect(body.postCount).toBeGreaterThan(0);
    expect(body.trace[3].note).toContain('live');
  });

  it('under failure injection the use case short-circuits — trace still honest and complete', async () => {
    scenarioStore.set({ dataMode: 'fake', injectFailure: true });
    const res = await request(createApp()).get(TRACE_URL).expect(200);
    const body = assertTraceStructure(res);
    expect(body.injectFailure).toBe(true);
    expect(body.postCount).toBe(0);
    expect(body.failure).toMatchObject({ kind: 'unavailable' });
    expect(body.trace[4].note).toContain('short-circuited');
  });
});

describe('GET /api/demo/arch/folders', () => {
  interface FolderNodeBody {
    name: string;
    kind: 'dir' | 'file';
    children?: FolderNodeBody[];
  }

  function findChild(nodes: FolderNodeBody[], name: string): FolderNodeBody | undefined {
    return nodes.find((node) => node.name === name);
  }

  it('returns the REAL tree: six top-level dirs, each with its purpose line', async () => {
    const res = await request(createApp()).get(FOLDERS_URL).expect(200);
    const tree = res.body.tree as FolderNodeBody[];
    const purposes = res.body.purposes as Record<string, string>;

    for (const dir of ['presentation', 'domain', 'data', 'core', 'di', 'content']) {
      const node = findChild(tree, dir);
      expect(node, `top-level dir ${dir}`).toBeDefined();
      expect(node?.kind).toBe('dir');
      expect(node?.children?.length ?? 0).toBeGreaterThan(0);
      expect(typeof purposes[dir]).toBe('string');
      expect(purposes[dir].length).toBeGreaterThan(0);
    }
    expect(res.body.root).toBe('server/src');
    expect(res.body.truncated).toBe(false);
  });

  it('the tree is real, not decorative: presentation carries routes/ and middleware/; content/topics has the topic files', async () => {
    const res = await request(createApp()).get(FOLDERS_URL).expect(200);
    const tree = res.body.tree as FolderNodeBody[];

    const presentation = findChild(tree, 'presentation');
    expect(findChild(presentation?.children ?? [], 'routes')?.kind).toBe('dir');
    expect(findChild(presentation?.children ?? [], 'middleware')?.kind).toBe('dir');

    const content = findChild(tree, 'content');
    const topics = findChild(content?.children ?? [], 'topics');
    const topicFiles = (topics?.children ?? []).filter((node) => node.kind === 'file');
    expect(topics?.kind).toBe('dir');
    expect(topicFiles.length).toBeGreaterThanOrEqual(37);
    expect(findChild(topicFiles, 'architecture.ts')).toBeDefined();

    // Depth is capped at three visible levels: routes/ children are files
    // and dirs WITHOUT children of their own.
    const routes = findChild(presentation?.children ?? [], 'routes');
    const indexNode = findChild(routes?.children ?? [], 'index.ts');
    expect(indexNode?.kind).toBe('file');
    expect(indexNode?.children).toBeUndefined();
  });

  it('every node is a well-formed dir|file entry (walk never leaks node_modules or dotfiles)', async () => {
    const res = await request(createApp()).get(FOLDERS_URL).expect(200);
    const names: string[] = [];
    const visit = (nodes: FolderNodeBody[]): void => {
      for (const node of nodes) {
        expect(['dir', 'file']).toContain(node.kind);
        expect(node.name).not.toMatch(/^\.|node_modules|^dist$/);
        names.push(node.name);
        if (node.children !== undefined) visit(node.children);
      }
    };
    visit(res.body.tree as FolderNodeBody[]);
    expect(names.length).toBeGreaterThan(50);
  });
});
