import type { Failure } from '../../core/error_handling/failures.js';
import { failureToException } from '../../core/error_handling/exceptions.js';
import type { Result } from '../../core/result/result.js';
import type { TopicDetail, TopicList } from '../../domain/content/content_service.js';
import type { Controller, HttpRequest, HttpResponse } from '../routes/make_express_callback.js';

/**
 * Content controllers — the framework-free ring for the topic-tree API the
 * React client renders. Same contract as the posts controllers: receive the
 * httpRequest DTO, call ONE service method, map the Result to { status, body }
 * or throw the typed exception for the error middleware. The service is pure
 * and synchronous, so these controllers are too — nothing here awaits.
 */

/** The service surface the content controllers depend on (injected, frozen in). */
export interface ContentControllerDependencies {
  readonly listTopics: () => Result<TopicList, Failure>;
  readonly getTopic: (id: unknown) => Result<TopicDetail, Failure>;
}

export function makeContentControllers({ listTopics, getTopic }: ContentControllerDependencies) {
  return Object.freeze({
    /** GET /api/content → 200 { version, groups, topics } */
    list(_httpRequest: HttpRequest): HttpResponse {
      const result = listTopics();
      if (!result.ok) throw failureToException(result.error);
      return { status: 200, body: result.value };
    },

    /** GET /api/content/topics/:id → 200 { version, ...topic } */
    detail(httpRequest: HttpRequest): HttpResponse {
      const result = getTopic(httpRequest.params.id);
      if (!result.ok) throw failureToException(result.error);
      return { status: 200, body: result.value };
    },
  });
}

export type ContentControllers = ReturnType<typeof makeContentControllers>;
export type ContentController = Controller;
