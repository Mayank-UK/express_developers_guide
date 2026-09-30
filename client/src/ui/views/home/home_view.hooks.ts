import { useEffect, useState } from 'react';
import { container } from '../../../core/container';
import type { Failure } from '../../../core/error-handling/failures';
import type {
  ContentIndex,
  TopicGroup,
  TopicSummary,
} from '../../../domain/models/content-index';
import type { DataMode } from '../../../domain/models/scenario';
import type { GetContentIndexUseCase } from '../../../domain/usecases/get-content-index-usecase';
import type { GetHealthStatusUseCase } from '../../../domain/usecases/get-health-status-usecase';
import type { GetScenarioStatusUseCase } from '../../../domain/usecases/get-scenario-status-usecase';

/* ---- status chips (hero) ---- */

export type HealthStatus =
  | { state: 'checking' }
  | { state: 'ok'; uptimeSeconds: number }
  | { state: 'fail'; message: string };

export type ScenarioStatus =
  | { state: 'checking' }
  | { state: 'ready'; dataMode: DataMode; injectFailure: boolean }
  | { state: 'fail'; message: string };

/**
 * Live status chips under the hero: one liveness probe (/api/health) and the
 * runtime scenario (/api/demo/scenario — fake/live data + failure injection).
 * The two use cases are independent, so one failing never blocks the other.
 * Use cases are injected as default parameters (react-guide `usePosts` style)
 * so specs can substitute fakes without touching the container.
 */
export function useHomeStatusChips(
  getHealthStatusUseCase: GetHealthStatusUseCase = container.getHealthStatusUseCase,
  getScenarioStatusUseCase: GetScenarioStatusUseCase = container.getScenarioStatusUseCase,
): { health: HealthStatus; scenario: ScenarioStatus } {
  const [health, setHealth] = useState<HealthStatus>({ state: 'checking' });
  const [scenario, setScenario] = useState<ScenarioStatus>({ state: 'checking' });

  useEffect(() => {
    let cancelled = false;

    void getHealthStatusUseCase.execute().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setHealth({ state: 'ok', uptimeSeconds: result.value.uptimeSeconds });
      } else {
        setHealth({ state: 'fail', message: result.failure.message });
      }
    });

    void getScenarioStatusUseCase.execute().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setScenario({
          state: 'ready',
          dataMode: result.value.dataMode,
          injectFailure: result.value.injectFailure,
        });
      } else {
        setScenario({ state: 'fail', message: result.failure.message });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [getHealthStatusUseCase, getScenarioStatusUseCase]);

  return { health, scenario };
}

/* ---- topic map ---- */

export type TopicMapState =
  | { state: 'loading' }
  | { state: 'error'; failure: Failure }
  | { state: 'ready'; index: ContentIndex };

export function useTopicMap(
  getContentIndexUseCase: GetContentIndexUseCase = container.getContentIndexUseCase,
): TopicMapState {
  const [map, setMap] = useState<TopicMapState>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void getContentIndexUseCase.execute().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setMap({ state: 'ready', index: result.value });
      } else {
        setMap({ state: 'error', failure: result.failure });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [getContentIndexUseCase]);

  return map;
}

export interface GroupedTopics {
  group: TopicGroup;
  topics: TopicSummary[];
}

/**
 * Groups the flat topic list under its group, in display order. The server
 * already sends both ordered; sorting here keeps the client's rendering
 * contract explicit instead of trusting wire order.
 */
export function groupTopics(index: ContentIndex): GroupedTopics[] {
  const byGroup = new Map<string, TopicSummary[]>();
  for (const topic of index.topics) {
    const bucket = byGroup.get(topic.group) ?? [];
    bucket.push(topic);
    byGroup.set(topic.group, bucket);
  }

  return [...index.groups]
    .sort((a, b) => a.order - b.order)
    .map((group) => ({
      group,
      topics: (byGroup.get(group.id) ?? []).sort((a, b) => a.order - b.order),
    }));
}
