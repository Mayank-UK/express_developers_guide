import { Link } from 'react-router';
import { SectionWrapper } from '../../components/section-wrapper';
import { ContentGroupWrapper } from '../../components/content-group-wrapper';
import { TextBlock } from '../../components/text-block';
import { CodeBlock } from '../../components/code-block';
import { ErrorPanel } from '../../components/error-panel';
import { topicPath } from '../../routing/routes';
import type { TopicSummary } from '../../../domain/models/content-index';
import {
  groupTopics,
  useHomeStatusChips,
  useTopicMap,
  type HealthStatus,
  type ScenarioStatus,
} from './home_view.hooks';

/**
 * Home — the guide's front door: hero with live status chips, run
 * instructions, and the topic map rendered from the content API. Like every
 * screen in this app it owns no teaching content of its own; the topic map is
 * whatever the server serves.
 */
export function HomeView() {
  const { health, scenario } = useHomeStatusChips();
  const map = useTopicMap();

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-lg px-md py-xl">
      <header className="flex flex-col gap-md">
        <div className="flex flex-col gap-sm">
          <h1 className="font-display text-display-md text-on-surface">
            Express Developers Guide
          </h1>
          <p className="text-title-sm text-on-surface-variant">
            Backend canon, taught by a working Express app
          </p>
        </div>
        <StatusChips health={health} scenario={scenario} />
      </header>

      <SectionWrapper
        id="run-this-guide"
        title="Run this guide"
        lead="This guide is a real app, not a PDF — every screen you read can be booted locally."
      >
        <TextBlock>
          {'The repository is a monorepo: server/ is the Express 5 + TypeScript API that carries all of the teaching content, client/ is the React shell that renders it. Start each package in its own terminal, or boot the whole stack through Docker Compose.'}
        </TextBlock>
        <ContentGroupWrapper title="Commands">
          <CodeBlock
            code={'cd server\nnpm run dev'}
            language="sh"
            caption="API on :4000 — tsx watch, reloads on every save"
          />
          <CodeBlock
            code={'cd client\nnpm run dev'}
            language="sh"
            caption="Client on :5173 — Vite proxies /api to the server"
          />
          <CodeBlock
            code={'docker compose -f .docker/docker-compose.yml up'}
            language="sh"
            caption="Full stack — server + client via Docker"
          />
        </ContentGroupWrapper>
      </SectionWrapper>

      {map.state === 'loading' && <TopicMapSkeleton />}

      {map.state === 'error' && <ErrorPanel subject="the topic map" failure={map.failure} />}

      {map.state === 'ready' && (
        <SectionWrapper
          id="topic-map"
          title="Topic map"
          lead="Every topic the guide will teach, grouped like the navigation. Populated topics are links; the rest are on the way."
        >
          {groupTopics(map.index).map(({ group, topics }) => (
            <ContentGroupWrapper key={group.id} title={group.title}>
              <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3">
                {topics.map((topic) => (
                  <TopicCard key={topic.id} topic={topic} />
                ))}
              </div>
            </ContentGroupWrapper>
          ))}
        </SectionWrapper>
      )}
    </div>
  );
}

/* ---- hero status chips ---- */

type ChipTone = 'ok' | 'warn' | 'error' | 'muted';

const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  ok: 'border-secondary/40 text-secondary',
  warn: 'border-warning/40 text-warning',
  error: 'border-error/40 text-error',
  muted: 'border-outline text-on-surface-variant',
};

function StatusChip({ tone, testId, children }: { tone: ChipTone; testId: string; children: string }) {
  return (
    <span
      data-testid={testId}
      className={`rounded-pill border px-sm py-xxs font-mono text-caption uppercase tracking-wide ${CHIP_TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

function StatusChips({ health, scenario }: { health: HealthStatus; scenario: ScenarioStatus }) {
  return (
    <div className="flex flex-wrap items-center gap-xs" aria-label="Live API status">
      {health.state === 'checking' && (
        <StatusChip tone="warn" testId="status-chip-health">
          api: checking…
        </StatusChip>
      )}
      {health.state === 'ok' && (
        <StatusChip tone="ok" testId="status-chip-health">
          {`api: ok (up ${String(health.uptimeSeconds)}s)`}
        </StatusChip>
      )}
      {health.state === 'fail' && (
        <StatusChip tone="error" testId="status-chip-health">
          api: down
        </StatusChip>
      )}

      {scenario.state === 'checking' && (
        <StatusChip tone="warn" testId="status-chip-data-mode">
          data: checking…
        </StatusChip>
      )}
      {scenario.state === 'ready' && (
        <StatusChip tone={scenario.dataMode === 'live' ? 'ok' : 'muted'} testId="status-chip-data-mode">
          {`data: ${scenario.dataMode}`}
        </StatusChip>
      )}
      {scenario.state === 'fail' && (
        <StatusChip tone="error" testId="status-chip-data-mode">
          data: unavailable
        </StatusChip>
      )}

      {scenario.state === 'ready' && (
        <StatusChip
          tone={scenario.injectFailure ? 'error' : 'muted'}
          testId="status-chip-inject-failure"
        >
          {`failure injection: ${scenario.injectFailure ? 'on' : 'off'}`}
        </StatusChip>
      )}
    </div>
  );
}

/* ---- topic map cards ---- */

function TopicCard({ topic }: { topic: TopicSummary }) {
  const badge = (
    <span className="shrink-0 rounded-pill border border-outline px-xs text-overline uppercase tracking-wide text-on-surface-variant">
      {topic.sectionCount === 1 ? '1 section' : `${String(topic.sectionCount)} sections`}
    </span>
  );

  if (topic.sectionCount === 0) {
    return (
      <div
        data-testid={`topic-card-${topic.id}`}
        aria-disabled="true"
        title="Coming soon"
        className="flex flex-col gap-xs rounded-md border border-outline bg-surface p-md shadow-button-card"
      >
        <div className="flex items-baseline justify-between gap-xs">
          <span className="font-display text-title-sm text-on-surface-variant/60">
            {topic.title}
          </span>
          <span className="shrink-0 text-overline uppercase tracking-wide text-on-surface-variant/50">
            soon
          </span>
        </div>
        {topic.subtitle !== undefined && (
          <p className="text-body-sm text-on-surface-variant/60">{topic.subtitle}</p>
        )}
        {badge}
      </div>
    );
  }

  return (
    <Link
      data-testid={`topic-card-${topic.id}`}
      to={topicPath(topic.id)}
      className="group flex flex-col gap-xs rounded-md border border-outline bg-surface p-md shadow-button-card transition-all duration-200 hover:-translate-y-1 hover:border-primary hover:bg-surface-variant hover:shadow-button-card-hover"
    >
      <div className="flex items-baseline justify-between gap-xs">
        <span className="font-display text-title-sm text-on-surface transition-colors group-hover:text-primary">
          {topic.title}
          <span
            aria-hidden
            className="ml-xxs inline-block text-on-surface-variant transition-transform group-hover:translate-x-1 group-hover:text-primary"
          >
            →
          </span>
        </span>
        {badge}
      </div>
      {topic.subtitle !== undefined && (
        <p className="text-body-sm text-on-surface-variant">{topic.subtitle}</p>
      )}
    </Link>
  );
}

function TopicMapSkeleton() {
  return (
    <div data-testid="topic-map-loading" aria-hidden className="flex flex-col gap-md">
      <p className="text-body text-on-surface-variant">loading the topic map…</p>
      <div className="h-lg w-full animate-pulse rounded-md bg-surface-variant" />
      <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="h-xl animate-pulse rounded-md bg-surface-variant" />
        ))}
      </div>
    </div>
  );
}
