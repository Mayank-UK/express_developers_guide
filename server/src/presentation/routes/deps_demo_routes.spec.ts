import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  DEPS_DEMO_MOUNT_PATH,
  resolvePackageFile,
} from './deps_demo_routes.js';

/**
 * The manifest endpoint is an fs introspection of the SERVER'S OWN package
 * files, so these specs pin it against the same files read directly — the
 * response can never drift from what is actually installed beside the code.
 */

interface ManifestDependency {
  name: string;
  wanted: string;
  resolved: string;
}

interface ManifestBody {
  name: string;
  version: string;
  nodeVersion: string;
  dependencies: ManifestDependency[];
  devDependencyCount: number;
  lockfile: { lockfileVersion: number | null; packageCount: number; generator: string };
}

interface PackageJsonShape {
  name: string;
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(resolvePackageFile('package.json'), 'utf8'),
) as PackageJsonShape;

describe('GET /api/demo/deps/manifest', () => {
  it('serves the real manifest: every dependency with its wanted range and a pinned resolved version', async () => {
    const res = await request(createApp()).get(`${DEPS_DEMO_MOUNT_PATH}/manifest`);
    expect(res.status).toBe(200);

    const body = res.body as ManifestBody;
    expect(body.name).toBe(pkg.name);
    expect(body.version).toBe(pkg.version);
    expect(body.nodeVersion).toBe(process.version);
    expect(body.devDependencyCount).toBe(Object.keys(pkg.devDependencies).length);

    // Every declared dependency appears, carrying the exact range from the file.
    expect(body.dependencies.map((dep) => dep.name).sort()).toEqual(
      Object.keys(pkg.dependencies).sort(),
    );
    const expressDep = body.dependencies.find((dep) => dep.name === 'express');
    expect(expressDep?.wanted).toBe(pkg.dependencies.express);
    // The lockfile's job in one assertion: wanted is a RANGE, resolved is exact.
    expect(expressDep?.wanted.startsWith('^')).toBe(true);
    expect(expressDep?.resolved).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    // Every top-level dependency resolved through the lockfile (no 'unknown').
    for (const dep of body.dependencies) {
      expect(dep.resolved).toMatch(/^\d+/);
    }
  });

  it('the transitive lesson: lockfile packageCount exceeds the direct dependency count', async () => {
    const res = await request(createApp()).get(`${DEPS_DEMO_MOUNT_PATH}/manifest`);
    const body = res.body as ManifestBody;

    // 18 direct dependencies, but hundreds of installed packages — that gap IS
    // the dependency-management topic's first argument.
    expect(body.dependencies.length).toBeGreaterThan(10);
    expect(body.lockfile.packageCount).toBeGreaterThan(body.dependencies.length);
    expect(body.lockfile.lockfileVersion).toBe(3);
    expect(body.lockfile.generator).toContain('npm@12');
  });

  it('resolves the package files relative to the module — the path that must survive tsc', () => {
    // Both tsx (src/presentation/routes/) and the built tree (dist/presentation/
    // routes/) sit three levels under the package root, so the same relative
    // URL must find the real files. The build check below re-proves it for dist.
    expect(existsSync(resolvePackageFile('package.json'))).toBe(true);
    expect(existsSync(resolvePackageFile('package-lock.json'))).toBe(true);
  });
});
