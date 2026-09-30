import { useEffect, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `env:inspector` — the environments topic's live surface.
 * One fetch to GET /api/demo/env/inspect renders:
 *
 * 1. THE CONFIG GRID — the frozen AppConfig every module reads (nodeEnv, ports,
 *    logLevel, dbPath) plus process facts (node version, pid, cwd) and the
 *    DERIVED env-file name (`.env.${nodeEnv}` — computed the way app_config
 *    computes its dotenv path) with an honest exists-on-disk flag.
 * 2. THE MASKED ENV VIEW — config values shown (ports/paths/levels are not
 *    secrets); MONGO_URI / REDIS_URL render only 'set (hidden)' | 'unset';
 *    secret-shaped NAMES are counted with values never rendered.
 * 3. THE WHAT-DIFFERS STRIP — static, from the repo's three real .env files:
 *    what dev / staging / production actually set differently. Same code,
 *    different variables — the one-artifact argument.
 *
 * Lives in demos/platform/ beside the jobs console and the error explorer.
 */

const INSPECT_URL = '/api/demo/env/inspect';

const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_STRONG =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption font-semibold text-on-surface';

interface InspectPayload {
  nodeEnv: string;
  port: number;
  grpcPort: number;
  logLevel: string;
  dbPath: string;
  mongoConfigured: boolean;
  redisConfigured: boolean;
  nodeVersion: string;
  pid: number;
  cwd: string;
  envFileLoaded: string;
  envFileExists: boolean;
  maskedEnv: Record<string, string>;
  hiddenSecretNames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Guarded wire reads — a malformed payload degrades, never crashes. */
function parseInspect(raw: unknown): InspectPayload | null {
  if (!isRecord(raw)) return null;
  const {
    nodeEnv, logLevel, dbPath, nodeVersion, envFileLoaded,
    port, grpcPort, pid, cwd,
    mongoConfigured, redisConfigured, envFileExists,
    maskedEnv: rawMaskedEnv, hiddenSecretNames: rawHidden,
  } = raw;
  if (typeof nodeEnv !== 'string') return null;
  if (typeof logLevel !== 'string') return null;
  if (typeof dbPath !== 'string') return null;
  if (typeof nodeVersion !== 'string') return null;
  if (typeof envFileLoaded !== 'string') return null;
  if (typeof port !== 'number' || typeof grpcPort !== 'number') return null;
  if (typeof pid !== 'number' || typeof cwd !== 'string') return null;
  if (typeof mongoConfigured !== 'boolean' || typeof redisConfigured !== 'boolean') return null;
  if (!isRecord(rawMaskedEnv)) return null;
  const maskedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawMaskedEnv)) {
    if (typeof value !== 'string') return null;
    maskedEnv[key] = value;
  }
  const hiddenSecretNames = Array.isArray(rawHidden)
    ? rawHidden.filter((name): name is string => typeof name === 'string')
    : [];
  return {
    nodeEnv,
    logLevel,
    dbPath,
    nodeVersion,
    envFileLoaded,
    port,
    grpcPort,
    pid,
    cwd,
    mongoConfigured,
    redisConfigured,
    envFileExists: envFileExists === true,
    maskedEnv,
    hiddenSecretNames,
  };
}

/** The static strip — the repo's three real .env files, summarized honestly. */
const DIFFERS: { env: string; file: string; lines: string[] }[] = [
  {
    env: 'development',
    file: '.env.development',
    lines: [
      'LOG_LEVEL=debug — the loud world',
      'SQLITE_PATH=data/guide.db',
      'MONGO_URI + REDIS_URL → localhost (compose publishes the ports)',
      'every optional service ON for the topics that teach them',
    ],
  },
  {
    env: 'staging',
    file: '.env.staging',
    lines: [
      'LOG_LEVEL=info — the quiet rehearsal',
      'everything else UNSET — defaults exercised:',
      'sqlite → data/guide.db (the parser default)',
      'MONGO_URI / REDIS_URL unset → both features boot OFF',
    ],
  },
  {
    env: 'production',
    file: '.env.production',
    lines: [
      'LOG_LEVEL=info',
      'SQLITE_PATH=data/guide.db',
      'MONGO_URI deliberately unset (the file says why: no mongo service',
      'exists for this environment yet) — honest optional-service off',
    ],
  },
];

export default function EnvInspectorDemo(): ReactNode {
  const [payload, setPayload] = useState<InspectPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      try {
        const response = await fetch(INSPECT_URL);
        if (!alive) return;
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const parsed = parseInspect(await response.json());
        if (!alive) return;
        if (parsed === null) throw new Error('malformed inspect payload');
        setPayload(parsed);
        setError(null);
      } catch {
        if (alive) setError('the demo API is unreachable — reload once the server is up');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const cards: { label: string; value: string; note?: string }[] =
    payload === null
      ? []
      : [
          { label: 'nodeEnv', value: payload.nodeEnv, note: 'the resolved NODE_ENV (test → development under vitest)' },
          { label: 'port', value: String(payload.port) },
          { label: 'grpcPort', value: String(payload.grpcPort) },
          { label: 'logLevel', value: payload.logLevel, note: 'default debug in dev, info elsewhere' },
          { label: 'dbPath', value: payload.dbPath, note: ':memory: under test — no spec touches a real db' },
          { label: 'nodeVersion', value: payload.nodeVersion },
          { label: 'pid', value: String(payload.pid) },
          { label: 'cwd', value: payload.cwd },
          {
            label: 'envFileLoaded',
            value: payload.envFileLoaded,
            note: payload.envFileExists ? 'found on disk' : 'NOT on disk — dotenv set nothing',
          },
        ];

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="env-summary" className="text-body-sm text-on-surface">
        This server&apos;s frozen <code className="font-mono">AppConfig</code>, introspected live:
        the validated values every module reads, the derived{' '}
        <code className="font-mono">.env</code> file, and a MASKED environment view — configuration
        shown, secrets never.
      </p>

      {error !== null && (
        <p data-testid="env-error" className="text-caption text-error">
          {error}
        </p>
      )}

      {payload === null && error === null && (
        <p data-testid="env-loading" className="text-body-sm text-on-surface-variant">
          introspecting the config…
        </p>
      )}

      {payload !== null && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-xs">
            <span className="text-body-sm font-semibold text-on-surface">
              1 · the frozen config + process facts
            </span>
            <span className={CHIP}>{INSPECT_URL}</span>
          </div>
          <div data-testid="env-config-grid" className="grid grid-cols-1 gap-xs sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <div
                key={card.label}
                data-testid="env-config-card"
                className="flex flex-col gap-xxs rounded-md border border-outline p-xs"
              >
                <span className="font-mono text-caption text-on-surface-variant">{card.label}</span>
                <span className="truncate font-mono text-body-sm font-semibold text-on-surface" title={card.value}>
                  {card.value}
                </span>
                {card.note !== undefined && (
                  <span className="text-caption text-on-surface-variant">{card.note}</span>
                )}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-xs">
            <span className={CHIP_STRONG}>mongo: {payload.mongoConfigured ? 'configured' : 'off'}</span>
            <span className={CHIP_STRONG}>redis: {payload.redisConfigured ? 'configured' : 'off'}</span>
            <span className="text-caption text-on-surface-variant">
              &apos;&apos; = feature off is a VALID config state — the app boots without them
            </span>
          </div>
        </section>
      )}

      {payload !== null && (
        <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
          <div className="flex flex-wrap items-center gap-xs">
            <span className="text-body-sm font-semibold text-on-surface">
              2 · the environment, masked
            </span>
            <span className="text-caption text-on-surface-variant">
              name confesses (token/secret/password…) or URL carries credentials → never rendered
            </span>
          </div>
          <div data-testid="env-masked-table" className="flex flex-col gap-xxs">
            {Object.entries(payload.maskedEnv).map(([key, value]) => (
              <div
                key={key}
                data-testid="env-masked-row"
                className="flex items-center gap-sm font-mono text-caption text-on-surface"
              >
                <span className="w-32 shrink-0">{key}</span>
                <span className={value === 'unset' ? 'text-on-surface-variant' : 'font-semibold'}>
                  {value}
                </span>
              </div>
            ))}
          </div>
          <p data-testid="env-secrets" className="text-caption text-on-surface-variant">
            {payload.hiddenSecretNames.length === 0
              ? 'no secret-shaped variables present in this process right now'
              : `${String(payload.hiddenSecretNames.length)} secret-shaped variable(s) present — names only, values never rendered: ${payload.hiddenSecretNames.join(', ')}`}
          </p>
        </section>
      )}

      <section data-testid="env-differs" className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <span className="text-body-sm font-semibold text-on-surface">
          3 · what differs per environment — this repo&apos;s three real files
        </span>
        <div className="grid grid-cols-1 gap-xs lg:grid-cols-3">
          {DIFFERS.map((entry) => (
            <div key={entry.env} className="flex flex-col gap-xxs rounded-md border border-outline p-xs">
              <span className="font-mono text-caption font-semibold text-on-surface">
                {entry.env} <span className="font-normal text-on-surface-variant">({entry.file})</span>
              </span>
              {entry.lines.map((line) => (
                <span key={line} className="text-caption text-on-surface-variant">
                  {line}
                </span>
              ))}
            </div>
          ))}
        </div>
        <p className="text-caption text-on-surface-variant">
          THE LESSON: the same compiled artifact runs in all three — only variables differ. Run{' '}
          <code className="font-mono">NODE_ENV=staging npm run dev</code> and re-fetch: the config
          row changes, the code does not.
        </p>
      </section>
    </div>
  );
}
