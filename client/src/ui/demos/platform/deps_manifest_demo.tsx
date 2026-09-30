import { useEffect, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `deps:manifest` — the dependency-management topic's live
 * surface. One fetch to GET /api/demo/deps/manifest renders:
 *
 * 1. THE MANIFEST TABLE — every runtime dependency with its WANTED range (the
 *    string in package.json) beside its RESOLVED pin (from the lockfile). The
 *    express row IS the semver lesson: ^5.1.0 admitting 5.2.1.
 * 2. THE LOCKFILE STATS — lockfileVersion, the resolved-entry package count
 *    (an honestly-stated heuristic), and the TRANSITIVE GAP: lockfile packages
 *    minus direct dependencies — section 1's argument rendered as a number.
 * 3. THE npm@12 CALLOUT — this repo's real decision-log story: lockfiles
 *    generated with npm@12 because npm 10's arborist crashed on fresh
 *    resolution; npm ci under npm 10 verified green.
 *
 * Lives in demos/platform/ beside the jobs console and the error explorer —
 * the app's own operating machinery is the subject.
 */

const MANIFEST_URL = '/api/demo/deps/manifest';

const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

interface ManifestDependency {
  name: string;
  wanted: string;
  resolved: string;
}

interface Manifest {
  name: string;
  version: string;
  nodeVersion: string;
  dependencies: ManifestDependency[];
  devDependencyCount: number;
  lockfile: {
    lockfileVersion: number | null;
    packageCount: number;
    generator: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Guarded wire reads — a malformed payload degrades, never crashes. */
function parseManifest(raw: unknown): Manifest | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.name !== 'string') return null;
  if (!Array.isArray(raw.dependencies)) return null;
  const dependencies = raw.dependencies
    .map((entry): ManifestDependency | null => {
      if (!isRecord(entry)) return null;
      if (typeof entry.name !== 'string') return null;
      if (typeof entry.wanted !== 'string') return null;
      if (typeof entry.resolved !== 'string') return null;
      return { name: entry.name, wanted: entry.wanted, resolved: entry.resolved };
    })
    .filter((dep): dep is ManifestDependency => dep !== null);
  if (dependencies.length === 0) return null;
  if (!isRecord(raw.lockfile)) return null;
  if (typeof raw.lockfile.packageCount !== 'number') return null;
  if (typeof raw.lockfile.generator !== 'string') return null;
  const lockfileVersion =
    typeof raw.lockfile.lockfileVersion === 'number' ? raw.lockfile.lockfileVersion : null;
  return {
    name: raw.name,
    version: typeof raw.version === 'string' ? raw.version : 'unknown',
    nodeVersion: typeof raw.nodeVersion === 'string' ? raw.nodeVersion : 'unknown',
    dependencies,
    devDependencyCount:
      typeof raw.devDependencyCount === 'number' ? raw.devDependencyCount : 0,
    lockfile: {
      lockfileVersion,
      packageCount: raw.lockfile.packageCount,
      generator: raw.lockfile.generator,
    },
  };
}

export default function DepsManifestDemo(): ReactNode {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const response = await fetch(MANIFEST_URL);
        if (!alive) return;
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const parsed = parseManifest(await response.json());
        if (!alive) return;
        if (parsed === null) throw new Error('malformed manifest payload');
        setManifest(parsed);
        setError(null);
      } catch {
        if (alive) setError('the demo API is unreachable — reload once the server is up');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const transitiveGap =
    manifest !== null ? Math.max(manifest.lockfile.packageCount - manifest.dependencies.length, 0) : 0;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="deps-summary" className="text-body-sm text-on-surface">
        This server&apos;s own <code className="font-mono">package.json</code> and{' '}
        <code className="font-mono">package-lock.json</code>, read live at runtime: every runtime
        dependency&apos;s <strong>wanted</strong> range (the manifest) beside its{' '}
        <strong>resolved</strong> pin (the lockfile) — plus the transitive-package count that is
        the whole argument.
      </p>

      {error !== null && (
        <p data-testid="deps-error" className="text-caption text-error">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body-sm font-semibold text-on-surface">
            1 · the manifest — wanted vs resolved
          </span>
          <span className="text-caption text-on-surface-variant">
            {manifest === null
              ? MANIFEST_URL
              : `${manifest.name}@${manifest.version} · node ${manifest.nodeVersion} · ${String(manifest.dependencies.length)} dependencies + ${String(manifest.devDependencyCount)} devDependencies`}
          </span>
        </div>
        {manifest === null && error === null && (
          <p data-testid="deps-loading" className="text-body-sm text-on-surface-variant">
            reading the manifest…
          </p>
        )}
        {manifest !== null && (
          <div data-testid="deps-table" className="flex flex-col gap-xxs">
            <div className="flex items-center gap-sm border-b border-outline pb-xxs font-mono text-caption text-on-surface-variant">
              <span className="w-40 shrink-0">package</span>
              <span className="w-28 shrink-0">wanted</span>
              <span className="w-24 shrink-0">resolved</span>
              <span>note</span>
            </div>
            {manifest.dependencies.map((dep) => (
              <div
                key={dep.name}
                data-testid="deps-row"
                className="flex items-center gap-sm font-mono text-caption text-on-surface"
              >
                <span className="w-40 shrink-0 truncate">{dep.name}</span>
                <span className="w-28 shrink-0">{dep.wanted}</span>
                <span className="w-24 shrink-0 font-semibold">{dep.resolved}</span>
                <span className="text-on-surface-variant">
                  {dep.wanted === dep.resolved
                    ? 'exact / newest satisfying'
                    : 'the range admitted a newer version — the caret\'s real meaning'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {manifest !== null && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-xs">
            <span className="text-body-sm font-semibold text-on-surface">
              2 · the lockfile — the transitive gap
            </span>
            <span className="text-caption text-on-surface-variant">
              packageCount counts <code className="font-mono">&quot;resolved&quot;:</code> fields —
              a stated heuristic, not an exact ledger
            </span>
          </div>
          <div data-testid="deps-lockfile" className="flex flex-wrap items-center gap-xs">
            <span className={CHIP_STRONG}>
              lockfileVersion: {manifest.lockfile.lockfileVersion === null ? 'unknown' : String(manifest.lockfile.lockfileVersion)}
            </span>
            <span className={CHIP_STRONG}>
              lockfile packages: {String(manifest.lockfile.packageCount)}
            </span>
            <span className={CHIP}>direct dependencies: {String(manifest.dependencies.length)}</span>
            <span className={CHIP}>
              transitive gap: +{String(transitiveGap)} packages you never chose
            </span>
          </div>
          <p className="text-caption text-on-surface-variant">
            THE LESSON: {String(manifest.dependencies.length)} direct choices install{' '}
            {String(manifest.lockfile.packageCount)} packages — that gap is code you ship, answer
            CVEs for, and upgrade forever.
          </p>
        </section>
      )}

      {manifest !== null && (
        <section data-testid="deps-npm12" className="flex flex-col gap-xxs rounded-md border border-outline bg-surface-variant p-sm">
          <span className="text-body-sm font-semibold text-on-surface">
            3 · the npm@12 story — from this repo&apos;s decision log
          </span>
          <p className="text-body-sm text-on-surface">
            &quot;Lockfiles generated with npm@12 — npm 10&apos;s arborist crashed on fresh
            resolution of this tree; <code className="font-mono">npm ci</code> under npm 10
            verified green.&quot; The tool that WRITES the lockfile turned out to be replaceable
            because the lockfile itself is the contract: pinned versions, resolved URLs, integrity
            hashes. When your toolchain betrays you, pin the OUTPUT and verify the INSTALL.
          </p>
        </section>
      )}
    </div>
  );
}
