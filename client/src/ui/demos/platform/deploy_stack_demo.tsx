import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `deploy:stack` — the deployment topic's stack explorer.
 *
 * One endpoint, GET /api/demo/deploy/stack, rendered as three panels:
 *
 * 1. LIVE PROCESS   — the real pid / node version / env / uptime / RSS of the
 *                     server answering the request (the "you are running
 *                     inside the deployed thing" moment).
 * 2. DECLARED       — the services this repo's two compose files declare,
 *   SERVICES          parsed live off disk by the server (declared vs live).
 * 3. COMMANDS       — the build/boot commands that stand the real stack up.
 *
 * Plus the origin card: the browser origin the request arrived through and
 * whether a proxy set x-forwarded-proto (null through the shipped prod
 * conf — the reverse-proxy section's gap, visible as data).
 */

const STACK_URL = '/api/demo/deploy/stack';

const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';
const COMMAND_BLOCK =
  'overflow-x-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-caption whitespace-pre text-on-surface';

interface ServerFacts {
  name: string;
  port: number;
  env: string;
  pid: number;
  nodeVersion: string;
  uptimeSeconds: number;
  memoryRssMb: number;
}

interface ComposeFileSnapshot {
  file: string;
  flavor: string;
  services: string[];
  note?: string;
}

interface StackManifest {
  server: ServerFacts;
  client: { name: string; note: string; origin: string; forwardedProto: string | null };
  docker: { composeFiles: ComposeFileSnapshot[]; hint: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStack(raw: unknown): StackManifest {
  if (!isRecord(raw) || !isRecord(raw.server) || !isRecord(raw.client) || !isRecord(raw.docker)) {
    throw new Error('malformed stack manifest');
  }
  const { server, client, docker } = raw;
  if (
    typeof server.pid !== 'number' ||
    typeof server.nodeVersion !== 'string' ||
    typeof server.env !== 'string' ||
    typeof server.port !== 'number' ||
    typeof server.uptimeSeconds !== 'number' ||
    typeof server.memoryRssMb !== 'number' ||
    typeof client.origin !== 'string' ||
    !Array.isArray(docker.composeFiles)
  ) {
    throw new Error('malformed stack manifest');
  }
  const composeFiles: ComposeFileSnapshot[] = [];
  for (const entry of docker.composeFiles) {
    if (
      isRecord(entry) &&
      typeof entry.file === 'string' &&
      typeof entry.flavor === 'string' &&
      Array.isArray(entry.services) &&
      entry.services.every((name): name is string => typeof name === 'string')
    ) {
      composeFiles.push({
        file: entry.file,
        flavor: entry.flavor,
        services: entry.services,
        note: typeof entry.note === 'string' ? entry.note : undefined,
      });
    }
  }
  return {
    server: {
      name: 'server',
      port: server.port,
      env: server.env,
      pid: server.pid,
      nodeVersion: server.nodeVersion,
      uptimeSeconds: server.uptimeSeconds,
      memoryRssMb: server.memoryRssMb,
    },
    client: {
      name: 'client',
      note: typeof client.note === 'string' ? client.note : '',
      origin: client.origin,
      forwardedProto:
        client.forwardedProto === null || typeof client.forwardedProto === 'string'
          ? client.forwardedProto
          : null,
    },
    docker: {
      composeFiles,
      hint: typeof docker.hint === 'string' ? docker.hint : '',
    },
  };
}

async function fetchStack(): Promise<StackManifest> {
  const response = await fetch(STACK_URL);
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return parseStack(await response.json());
}

export default function DeployStackDemo(): ReactNode {
  const [stack, setStack] = useState<StackManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const manifest = await fetchStack();
      if (mounted.current) setStack(manifest);
    } catch {
      if (mounted.current) setError('could not read the stack endpoint — is the server running?');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="deploy-summary" className="text-body-sm text-on-surface">
        The declared stack versus the live one: the manifest endpoint reports the process you are
        talking to and parses this repo&apos;s compose files off disk. Deployment is the discipline
        of keeping the two columns identical.
      </p>

      {error !== null && (
        <div className="flex flex-wrap items-center gap-xs">
          <p data-testid="deploy-error" className="text-caption text-error">
            {error}
          </p>
          <button type="button" className={BUTTON_PRIMARY} onClick={() => void load()}>
            retry
          </button>
        </div>
      )}

      {loading && stack === null && (
        <p data-testid="deploy-loading" className="text-body-sm text-on-surface-variant">
          reading the stack manifest…
        </p>
      )}

      {/* ---- panel 1: the live process ---- */}
      {stack !== null && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-xs">
            <span className="text-body-sm font-semibold text-on-surface">1 · live process</span>
            <span className={CHIP}>GET /api/demo/deploy/stack</span>
            <button
              type="button"
              data-testid="deploy-refresh-button"
              className={BUTTON_PRIMARY}
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? 'refreshing…' : 'refresh'}
            </button>
          </div>
          <div data-testid="deploy-live" className="flex flex-wrap gap-xs">
            <span className={CHIP_STRONG}>pid {String(stack.server.pid)}</span>
            <span className={CHIP_STRONG}>{stack.server.nodeVersion}</span>
            <span className={CHIP_STRONG}>env: {stack.server.env}</span>
            <span className={CHIP_STRONG}>port {String(stack.server.port)}</span>
            <span className={CHIP}>up {String(stack.server.uptimeSeconds)}s</span>
            <span className={CHIP}>rss {String(stack.server.memoryRssMb)}MB</span>
          </div>
          <p data-testid="deploy-origin" className="text-caption text-on-surface">
            you reached this page through <strong>{stack.client.origin}</strong> —{' '}
            {stack.client.forwardedProto === null
              ? 'and no proxy set x-forwarded-proto: the app cannot see TLS termination (the shipped nginx conf does not forward it — see the reverse-proxy section).'
              : `x-forwarded-proto: ${stack.client.forwardedProto} (a proxy told the app what TLS actually was).`}
          </p>
        </section>
      )}

      {/* ---- panel 2: the declared services ---- */}
      {stack !== null && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <span className="text-body-sm font-semibold text-on-surface">
            2 · declared services (parsed from the repo&apos;s compose files)
          </span>
          {stack.docker.composeFiles.map((file) => (
            <div key={file.file} data-testid="deploy-declared" className="flex flex-col gap-xxs">
              <div className="flex flex-wrap items-center gap-xs">
                <span className={CHIP_STRONG}>{file.flavor}</span>
                <span className={CHIP}>{file.file}</span>
              </div>
              <div className="flex flex-wrap gap-xs" data-testid={`deploy-services-${file.flavor}`}>
                {file.services.length === 0 ? (
                  <span className="text-caption text-on-surface-variant">
                    {file.note ?? 'no services parsed'}
                  </span>
                ) : (
                  file.services.map((service) => (
                    <span
                      key={service}
                      data-testid={`deploy-service-${file.flavor}-${service}`}
                      className={
                        service === 'server' || service === 'client' ? CHIP_STRONG : CHIP
                      }
                    >
                      {service}
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}
          <p className="text-caption text-on-surface-variant">{stack.docker.hint}</p>
        </section>
      )}

      {/* ---- panel 3: the commands that stand it up ---- */}
      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <span className="text-body-sm font-semibold text-on-surface">
          3 · boot the real prod stack
        </span>
        <pre data-testid="deploy-commands" className={COMMAND_BLOCK}>
          {`docker compose -f .docker/docker-compose-prod.yml build
docker compose -f .docker/docker-compose-prod.yml up -d
curl -s localhost:8080/api/health     # through nginx → the server
docker compose -f .docker/docker-compose-prod.yml down`}
        </pre>
      </section>
    </div>
  );
}
