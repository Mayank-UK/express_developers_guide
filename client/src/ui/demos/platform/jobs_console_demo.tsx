import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `jobs:console` — the background-jobs topic's live
 * surface, polling the REAL hand-rolled queue (server domain/jobs/
 * job_queue.ts over /api/demo/jobs). The board renders each job's lifecycle
 * — queued → running → succeeded/dead — with the retry backoff delays from
 * the history timeline made visible, dead jobs get a REQUEUE button, and the
 * scheduler toggle feeds report jobs onto the board with a source badge.
 *
 * Lives in demos/platform/ (not realtime/): this is the first demo whose
 * subject is the app's operating machinery — work that outlives requests —
 * and the upcoming platform topics (exception handling, observability,
 * testing) will join it here.
 */

const JOBS_URL = '/api/demo/jobs';
const STATS_URL = '/api/demo/jobs/stats';
const POLL_MS = 1000;

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const BUTTON_DANGER =
  'w-fit rounded-md border border-error px-sm py-xs text-body-sm text-error hover:bg-error hover:text-on-error disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_BADGE =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption text-on-surface';

type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead';

const STATUS_CHIP_CLASS: Record<JobStatus, string> = {
  queued: 'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant',
  running: 'rounded-md border border-outline bg-warning px-xs py-xxs font-mono text-caption font-semibold text-on-surface',
  succeeded: 'rounded-md border border-outline bg-primary px-xs py-xxs font-mono text-caption font-semibold text-on-primary',
  dead: 'rounded-md border border-error bg-error px-xs py-xxs font-mono text-caption font-semibold text-on-error',
};

interface HistoryEntry {
  at: string;
  event: string;
  attempt?: number;
  delayMs?: number;
  lastError?: string;
}

interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  history: HistoryEntry[];
}

interface Stats {
  queued: number;
  running: number;
  succeeded: number;
  dead: number;
  totalEnqueued: number;
  oldestQueuedAgeMs: number | null;
  scheduler: { running: boolean; lastRunAt: string | null; intervalMs: number };
  config: { baseDelayMs: number; maxAttempts: number };
}

/** The three teaching temperaments behind the enqueue buttons. */
const ENQUEUE_PRESETS: Record<string, { label: string; payload: Record<string, unknown> }> = {
  welcome: { label: 'welcome email (succeeds)', payload: { to: 'student@example.com', subject: 'Welcome' } },
  flaky: { label: 'flaky email (fails 2×, then succeeds)', payload: { forceFailures: 2, latencyMs: 60 } },
  poison: { label: 'poison email (always fails → dead-letter)', payload: { alwaysFail: true, latencyMs: 40 } },
};

/** Guarded wire reads — a malformed payload degrades to skipped, never a crash. */
function parseJob(raw: unknown): Job | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.type !== 'string') return null;
  const status = record.status;
  if (status !== 'queued' && status !== 'running' && status !== 'succeeded' && status !== 'dead') {
    return null;
  }
  return {
    id: record.id,
    type: record.type,
    payload:
      typeof record.payload === 'object' && record.payload !== null && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : {},
    status,
    attempts: typeof record.attempts === 'number' ? record.attempts : 0,
    history: Array.isArray(record.history)
      ? record.history.filter(
          (entry): entry is HistoryEntry =>
            typeof entry === 'object' && entry !== null && typeof (entry as HistoryEntry).event === 'string',
        )
      : [],
  };
}

function parseStats(raw: unknown): Stats | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const asCount = (value: unknown): number => (typeof value === 'number' ? value : 0);
  const scheduler =
    typeof record.scheduler === 'object' && record.scheduler !== null
      ? (record.scheduler as Stats['scheduler'])
      : { running: false, lastRunAt: null, intervalMs: 5000 };
  const config =
    typeof record.config === 'object' && record.config !== null
      ? (record.config as Stats['config'])
      : { baseDelayMs: 300, maxAttempts: 3 };
  return {
    queued: asCount(record.queued),
    running: asCount(record.running),
    succeeded: asCount(record.succeeded),
    dead: asCount(record.dead),
    totalEnqueued: asCount(record.totalEnqueued),
    oldestQueuedAgeMs: typeof record.oldestQueuedAgeMs === 'number' ? record.oldestQueuedAgeMs : null,
    scheduler,
    config,
  };
}

/** UTC HH:MM:SS of an ISO instant — the timeline reads as one clock. */
function clockOf(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

function formatAge(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function JobsConsoleDemo(): ReactNode {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const aliveRef = useRef(true);

  const loadState = useCallback(async (): Promise<void> => {
    try {
      const [jobsResponse, statsResponse] = await Promise.all([fetch(JOBS_URL), fetch(STATS_URL)]);
      if (!aliveRef.current) return;
      if (!jobsResponse.ok || !statsResponse.ok) throw new Error(`HTTP ${String(jobsResponse.status)}/${String(statsResponse.status)}`);
      const jobsBody = (await jobsResponse.json()) as unknown;
      const statsBody = (await statsResponse.json()) as unknown;
      if (!aliveRef.current) return;
      const parsedJobs =
        typeof jobsBody === 'object' && jobsBody !== null && Array.isArray((jobsBody as Record<string, unknown>).jobs)
          ? ((jobsBody as Record<string, unknown>).jobs as unknown[])
              .map(parseJob)
              .filter((job): job is Job => job !== null)
          : [];
      setJobs(parsedJobs);
      setStats(parseStats(statsBody));
      setError(null);
    } catch {
      if (aliveRef.current) {
        setError('the jobs API is unreachable — the board keeps retrying every second');
      }
    }
  }, []);

  // The board poller: immediate fetch, then once a second; dies with the component.
  useEffect(() => {
    aliveRef.current = true;
    void loadState();
    const timer = setInterval(() => void loadState(), POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [loadState]);

  const enqueue = async (preset: keyof typeof ENQUEUE_PRESETS): Promise<void> => {
    try {
      await fetch(JOBS_URL + '/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'email', payload: ENQUEUE_PRESETS[preset]?.payload ?? {} }),
      });
    } catch {
      // the next poll surfaces the failure — the error strip is the messenger
    }
    await loadState();
  };

  const requeue = async (id: string): Promise<void> => {
    try {
      await fetch(`${JOBS_URL}/${id}/requeue`, { method: 'POST' });
    } catch {
      // same contract — the poll reconciles
    }
    await loadState();
  };

  const toggleScheduler = async (): Promise<void> => {
    const running = stats?.scheduler.running ?? false;
    try {
      await fetch(`${JOBS_URL}/scheduler`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ running: !running }),
      });
    } catch {
      // ditto
    }
    await loadState();
  };

  const clearBoard = async (): Promise<void> => {
    try {
      await fetch(JOBS_URL, { method: 'DELETE' });
    } catch {
      // ditto
    }
    await loadState();
  };

  const maxAttempts = stats?.config.maxAttempts ?? 3;
  const schedulerOn = stats?.scheduler.running ?? false;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="jobs-summary" className="text-body-sm text-on-surface">
        A real in-process job queue: enqueue emails with injected temperaments and watch the
        lifecycle — <code className="font-mono">queued → running → succeeded/dead</code> — with each
        retry&apos;s backoff delay rendered in the history timeline. Dead jobs can be requeued; the
        scheduler feeds report jobs onto the board.
      </p>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <button type="button" data-testid="jobs-enqueue-welcome" onClick={() => void enqueue('welcome')} className={BUTTON_PRIMARY}>
            welcome email (succeeds)
          </button>
          <button type="button" data-testid="jobs-enqueue-flaky" onClick={() => void enqueue('flaky')} className={BUTTON_PRIMARY}>
            flaky email (fails 2×, then succeeds)
          </button>
          <button type="button" data-testid="jobs-enqueue-poison" onClick={() => void enqueue('poison')} className={BUTTON}>
            poison email (always fails → dead-letter)
          </button>
          <button type="button" data-testid="jobs-clear" onClick={() => void clearBoard()} className={BUTTON_DANGER}>
            clear
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-xs">
          <span data-testid="jobs-stats" className={CHIP}>
            {stats === null
              ? 'stats …'
              : `queued ${String(stats.queued)} · running ${String(stats.running)} · succeeded ${String(stats.succeeded)} · dead ${String(stats.dead)} · oldest ${stats.oldestQueuedAgeMs === null ? '—' : formatAge(stats.oldestQueuedAgeMs)} · total ${String(stats.totalEnqueued)}`}
          </span>
          <span className="text-caption text-on-surface-variant">
            depth + oldest-job age — the two numbers the alerts watch
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-xs">
          <button type="button" data-testid="jobs-scheduler-toggle" onClick={() => void toggleScheduler()} className={schedulerOn ? BUTTON_DANGER : BUTTON}>
            {schedulerOn ? 'scheduler: on — turn off' : 'scheduler: off — turn on'}
          </button>
          <span data-testid="jobs-scheduler-state" className={CHIP}>
            {stats === null
              ? '…'
              : `${schedulerOn ? 'ticking' : 'idle'} · every ${formatAge(stats.scheduler.intervalMs)}${stats.scheduler.lastRunAt === null ? '' : ` · last ${clockOf(stats.scheduler.lastRunAt)}`}`}
          </span>
        </div>

        {error !== null && (
          <p data-testid="jobs-error" className="text-caption text-error">
            {error}
          </p>
        )}
      </section>

      <section
        data-testid="jobs-board"
        className="flex max-h-96 flex-col gap-sm overflow-y-auto rounded-md border border-outline bg-surface p-sm"
      >
        {jobs === null && <p className="text-body-sm text-on-surface-variant">loading the board…</p>}
        {jobs !== null && jobs.length === 0 && (
          <p className="text-body-sm text-on-surface-variant">
            the queue is empty — enqueue an email above, or turn the scheduler on and watch the
            clock feed the queue.
          </p>
        )}
        {jobs?.map((job) => {
          const isOpen = expanded[job.id] === true;
          const fromScheduler = job.payload.source === 'scheduler';
          return (
            <article key={job.id} data-testid="jobs-card" className="flex flex-col gap-xxs rounded-md border border-outline p-sm">
              <div className="flex flex-wrap items-center gap-xs">
                <span className="font-mono text-caption text-on-surface">{job.id}</span>
                <span className={CHIP}>{job.type}</span>
                {fromScheduler && (
                  <span data-testid="jobs-source-badge" className={CHIP_BADGE}>
                    scheduler · tick {String(job.payload.tick ?? '?')}
                  </span>
                )}
                <span data-testid={`jobs-status-${job.status}`} className={STATUS_CHIP_CLASS[job.status]}>
                  {job.status}
                </span>
                <span data-testid="jobs-attempts" className="font-mono text-caption text-on-surface-variant">
                  {String(job.attempts)}/{String(maxAttempts)} attempts
                </span>
                <button
                  type="button"
                  data-testid="jobs-history-toggle"
                  onClick={() => setExpanded((previous) => ({ ...previous, [job.id]: !isOpen }))}
                  className="ml-auto rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant hover:bg-surface-variant"
                >
                  {isOpen ? 'hide history' : 'history'}
                </button>
              </div>

              <p className="font-mono text-caption text-on-surface-variant">
                {job.type === 'email'
                  ? `to ${String(job.payload.to ?? 'student@example.com')} — ${String(job.payload.subject ?? 'Welcome')}`
                  : `source ${String(job.payload.source ?? 'api')}${job.payload.tick === undefined ? '' : ` · tick ${String(job.payload.tick)}`}`}
                {job.history.length > 0 ? ` · enqueued ${clockOf(job.history[0]?.at ?? '')}Z` : ''}
              </p>

              {job.status === 'dead' && (
                <div className="flex items-center gap-xs">
                  <button type="button" data-testid="jobs-requeue" onClick={() => void requeue(job.id)} className={BUTTON_PRIMARY}>
                    requeue (fresh retry budget)
                  </button>
                  <span className="text-caption text-on-surface-variant">
                    history is kept — the postmortem survives the replay
                  </span>
                </div>
              )}

              {isOpen && (
                <ol data-testid="jobs-history" className="flex flex-col gap-xxs border-t border-outline pt-xxs">
                  {job.history.map((entry, index) => (
                    <li key={index} className="font-mono text-caption text-on-surface-variant">
                      {clockOf(entry.at)}Z · {entry.event}
                      {entry.attempt !== undefined ? ` · attempt ${String(entry.attempt)}` : ''}
                      {entry.delayMs !== undefined ? (
                        <span className="text-on-surface"> {`(+${String(entry.delayMs)}ms backoff)`}</span>
                      ) : null}
                      {entry.lastError !== undefined ? (
                        <span className="text-error"> {entry.lastError}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
