import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router, type Request, type Response } from 'express';

/**
 * Dependency-management demo endpoints (the `dependency-management` topic's
 * live surface). The demo is the app's OWN manifest: GET /api/demo/deps/manifest
 * reads this package's package.json + package-lock.json at runtime and reports
 * what a dependency audit actually looks at — the wanted ranges, what the
 * lockfile resolved them to, and how much transitive graph those 18 direct
 * dependencies pull in.
 */

export const DEPS_DEMO_MOUNT_PATH = '/api/demo/deps';

/**
 * Resolves a file at the PACKAGE ROOT relative to THIS module. Works under tsx
 * (src/presentation/routes/…) and under the built tree (dist/presentation/
 * routes/…) because tsconfig's rootDir(src)/outDir(dist) mirror each other —
 * both sit exactly three levels below the package root, next to package.json.
 */
export function resolvePackageFile(name: string): string {
  return fileURLToPath(new URL(`../../../${name}`, import.meta.url));
}

interface ManifestDependency {
  name: string;
  /** The semver RANGE as written in package.json (^5.1.0, ^0.8.1, 4.1.10…). */
  wanted: string;
  /** The exact version the lockfile pinned for the top-level node_modules slot. */
  resolved: string;
}

interface ManifestSnapshot {
  name: string;
  version: string;
  nodeVersion: string;
  dependencies: ManifestDependency[];
  devDependencyCount: number;
  lockfile: {
    lockfileVersion: number | null;
    /**
     * Heuristic, stated honestly: counts `"resolved":` fields in the lockfile
     * text. Every materialized package entry in a lockfileVersion-3 lockfile
     * carries one (the root "" entry and link entries do not), so this counts
     * installed packages — direct + transitive + dev — without deep-parsing a
     * half-megabyte JSON document.
     */
    packageCount: number;
    /** This repo's lockfiles are generated with npm@12 — see the decision log. */
    generator: 'npm@12 (decision log)';
  };
}

interface PackageJsonShape {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockfileShape {
  packages?: Record<string, { version?: string }>;
}

/** Lockfile facts via cheap regex — survives a lockfile too malformed to parse. */
function readLockfileFacts(text: string): {
  lockfileVersion: number | null;
  packageCount: number;
  versionByLockPath: Map<string, string>;
} {
  const versionMatch = /"lockfileVersion":\s*(\d+)/.exec(text);
  const versionByLockPath = new Map<string, string>();
  try {
    const parsed = JSON.parse(text) as LockfileShape;
    for (const [lockPath, entry] of Object.entries(parsed.packages ?? {})) {
      if (typeof entry?.version === 'string') versionByLockPath.set(lockPath, entry.version);
    }
  } catch {
    // The regex facts below still hold even when JSON.parse gives up.
  }
  return {
    lockfileVersion: versionMatch === null ? null : Number(versionMatch[1]),
    packageCount: (text.match(/"resolved":/g) ?? []).length,
    versionByLockPath,
  };
}

let snapshot: ManifestSnapshot | undefined;

/** Read once per process — the manifest cannot change under a running install. */
function getManifestSnapshot(): ManifestSnapshot {
  if (snapshot !== undefined) return snapshot;

  const pkg = JSON.parse(readFileSync(resolvePackageFile('package.json'), 'utf8')) as PackageJsonShape;
  const lockText = readFileSync(resolvePackageFile('package-lock.json'), 'utf8');
  const facts = readLockfileFacts(lockText);

  const dependencies = Object.entries(pkg.dependencies ?? {}).map(([name, wanted]) => ({
    name,
    wanted,
    // Top-level dependencies live at the lockfile's `node_modules/<name>` path
    // (the packages-map key, not the registry name).
    resolved: facts.versionByLockPath.get(`node_modules/${name}`) ?? 'unknown',
  }));

  snapshot = {
    name: pkg.name ?? 'unknown',
    version: pkg.version ?? 'unknown',
    nodeVersion: process.version,
    dependencies,
    devDependencyCount: Object.keys(pkg.devDependencies ?? {}).length,
    lockfile: {
      lockfileVersion: facts.lockfileVersion,
      packageCount: facts.packageCount,
      generator: 'npm@12 (decision log)',
    },
  };
  return snapshot;
}

function manifestController(_req: Request, res: Response): void {
  res.json(getManifestSnapshot());
}

export const depsDemoRouter = Router();
depsDemoRouter.get('/demo/deps/manifest', manifestController);
