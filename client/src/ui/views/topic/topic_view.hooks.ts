import { useEffect, useState } from 'react';
import { container } from '../../../core/container';
import type { Failure } from '../../../core/error-handling/failures';
import { ServerFailure } from '../../../core/error-handling/failures';
import type { Topic } from '../../../domain/models/topic';
import type { GetTopicUseCase } from '../../../domain/usecases/get-topic-usecase';

export type TopicViewState =
  | { state: 'loading' }
  | { state: 'error'; failure: Failure }
  | { state: 'ready'; topic: Topic };

/**
 * Loads the topic named by the route's :topicId param. Re-fetches when the id
 * changes (navigating between topics reuses the same screen), and a missing
 * param degrades to a friendly error instead of a request with "undefined" in
 * the URL. Expected failures arrive as typed Failures inside Results — the
 * hook never throws. The use case is injected as a default parameter
 * (react-guide `usePosts` style).
 */
export function useTopic(
  topicId: string | undefined,
  getTopicUseCase: GetTopicUseCase = container.getTopicUseCase,
): TopicViewState {
  const [view, setView] = useState<TopicViewState>({ state: 'loading' });

  useEffect(() => {
    if (topicId === undefined) {
      setView({
        state: 'error',
        failure: new ServerFailure('No topic id in this URL.', {
          code: 'not_found',
          status: 404,
        }),
      });
      return;
    }

    let cancelled = false;
    setView({ state: 'loading' });

    void getTopicUseCase.execute(topicId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setView({ state: 'ready', topic: result.value });
      } else {
        setView({ state: 'error', failure: result.failure });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [topicId, getTopicUseCase]);

  return view;
}
