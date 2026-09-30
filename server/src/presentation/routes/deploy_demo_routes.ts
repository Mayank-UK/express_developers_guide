import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';
import { appConfig } from '../../core/config/app_config.js';

/**
 * Deployment demo endpoints (the `deployment` topic's live surface).
 *
 * GET /api/demo/deploy/stack → the STACK MANIFEST: the machine-readable facts
 * of the process you are talking to (pid, node version, uptime, rss — the
 * "you are running inside the deployed thing" moment), the browser origin as
 * this request reached it (which front door served you: Vite's dev proxy, the
 * prod nginx, or a direct :4000 hit), and the services DECLARED by this
 * repo's two compose files, parsed live off disk so the demo can put the
 * declared stack beside the live one.
 */

export const DEPLOY_DEMO_MOUNT_PATH = '/api/demo/deploy';

/**
 * Resolves a file at the REPO ROOT relative to THIS module. Works under tsx
 * (src/presentation/routes/… → up through src, server, root) and under the
 * built tree (dist/presentation/routes/… → dist, server, root) because both
 * trees sit at the same depth under the package — the same property
 * deps_demo_routes' resolvePackageFile relies on, one level higher. When the
 * .docker directory is not shipped (the runtime Docker image carries only
 * dist/ + node_modules/), reads fail and the endpoint degrades honestly
 * instead of 500ing — see readComposeFile.
 */
export function resolveRepoFile(name: string): string {
  return fileURLToPath(new URL(`../../../../${name}`, import.meta.url));
}

const COMPOSE_FILES = [
  { path: '.docker/docker-compose.yml', flavor: 'dev' },
  { path: '.docker/docker-compose-prod.yml', flavor: 'prod' },
] as const;

export interface ComposeSnapshot {
  file: string;
  flavor: string;
  services: string[];
  /** Present when the file could not be read or parsed — the honest empty. */
  note?: string;
}

/**
 * Tolerant compose parser, stated as a heuristic: takes the text between the
 * top-level `services:` key and the next top-level key (networks:/volumes:/…)
 * and collects the two-space-indented `name:` keys beneath it — the shape
 * every compose file in the wild uses, without hauling in a YAML parser (and
 * its dependency weight) for a demo endpoint. Malformed input yields [], not
 * a throw.
 */
export function parseComposeServices(text: string): string[] {
  const servicesMatch = /^services:\s*(?:#.*)?$/m.exec(text);
  if (servicesMatch === null) return [];
  const after = text.slice(servicesMatch.index + servicesMatch[0].length);
  const endMatch = /^(networks|volumes|configs|secrets|name):\s*(?:#.*)?$/m.exec(after);
  const block = endMatch === null ? after : after.slice(0, endMatch.index);
  const names: string[] = [];
  for (const line of block.split('\n')) {
    const serviceKey = /^  ([A-Za-z0-9][A-Za-z0-9_.-]*):\s*(?:#.*)?$/.exec(line);
    if (serviceKey !== null) names.push(serviceKey[1] ?? '');
  }
  return names.filter((name) => name !== '');
}

/** Exported for its spec — the missing-file degradation contract below. */
export function readComposeFile(path: string, flavor: string): ComposeSnapshot {
  const snapshot: ComposeSnapshot = { file: path, flavor, services: [] };
  try {
    const text = readFileSync(resolveRepoFile(path), 'utf8');
    snapshot.services = parseComposeServices(text);
    if (snapshot.services.length === 0) {
      snapshot.note = 'services block not found — the tolerant parse came up empty';
    }
  } catch {
    // Expected whenever the repo is not shipped beside the code — most
    // importantly inside the Docker runtime image (dist + node_modules only).
    snapshot.note = 'compose file not readable from this process (expected inside the Docker image, which ships no repo)';
  }
  return snapshot;
}

// Compose files do not change during a process's life; read them once.
let composeSnapshots: ComposeSnapshot[] | undefined;

function getComposeSnapshots(): ComposeSnapshot[] {
  composeSnapshots ??= COMPOSE_FILES.map((entry) => readComposeFile(entry.path, entry.flavor));
  return composeSnapshots;
}

function stackController(req: Request, res: Response): void {
  const memory = process.memoryUsage();
  const host = req.get('host') ?? 'unknown';
  // The app cannot KNOW TLS was terminated in front unless the proxy says so:
  // x-forwarded-proto is exactly the header the shipped nginx conf does NOT
  // set (see the deployment topic's reverse-proxy section) — so this reads
  // null through the prod proxy and truthfully reports http.
  const forwardedProto = req.get('x-forwarded-proto') ?? null;

  res.json({
    server: {
      name: 'server',
      port: appConfig.port,
      env: appConfig.nodeEnv,
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryRssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
    },
    client: {
      name: 'client',
      note: 'the React shell is served by your browser origin, not by this process',
      origin: `${forwardedProto ?? 'http'}://${host}`,
      forwardedProto,
    },
    docker: {
      composeFiles: getComposeSnapshots(),
      hint: 'services parsed live from this repo\u2019s compose files (a tolerant two-space-indent heuristic); compare the DECLARED stack against the LIVE process facts above',
    },
  });
}

export const deployDemoRouter: Router = Router();
// Mounted under /api by src/app.ts (the sibling demo routers' convention):
// the router registers /demo/deploy/…, the full path is /api/demo/deploy/….
deployDemoRouter.get('/demo/deploy/stack', stackController);
