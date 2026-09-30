import { fail, ok, type Result } from '../../core/result/result.js';
import { failure, type Failure } from '../../core/error_handling/failures.js';
import {
  CONTENT_API_VERSION,
  TOPIC_GROUPS,
  type Topic,
  type TopicSummary,
} from '../../content/types.js';

/** Payload of GET /api/content — the nav tree without section payloads. */
export interface TopicList {
  readonly version: number;
  readonly groups: typeof TOPIC_GROUPS;
  readonly topics: TopicSummary[];
}

/** Payload of GET /api/content/topics/:id — one full topic, versioned. */
export type TopicDetail = Topic & { readonly version: number };

/**
 * The topic-lookup PORT: the registry access this service needs, expressed as
 * plain function types the domain owns. The registry module itself is
 * infrastructure (it loads all 40 topics at import time) — so THIS file never
 * imports it. The composition root supplies the real functions; specs may
 * hand in fakes. Same lesson as the repositories: the domain names what it
 * needs, wiring decides what answers.
 */
export interface TopicLookup {
  /** Summaries for list views — never carries the sections payload. */
  readonly getTopicSummaries: () => TopicSummary[];
  /** Exact-match lookup; undefined when no topic carries that id. */
  readonly getTopicById: (id: string) => Topic | undefined;
}

export interface ContentServiceOptions {
  readonly topics: TopicLookup;
}

/**
 * Pure domain service over the topic catalog: no HTTP, no timing, nothing
 * async — the registry is validated at module load, so lookups only decide
 * between ok and a typed failure. The lookup functions arrive by CONSTRUCTOR
 * injection (frozen below): the domain constructs nothing itself.
 */
export class ContentService {
  private readonly topics: TopicLookup;

  constructor(options: ContentServiceOptions) {
    this.topics = Object.freeze({ ...options.topics });
  }

  listTopics(): Result<TopicList, Failure> {
    return ok({
      version: CONTENT_API_VERSION,
      groups: TOPIC_GROUPS,
      topics: this.topics.getTopicSummaries(),
    });
  }

  getTopic(id: unknown): Result<TopicDetail, Failure> {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return fail(
        failure('validation', 'topic id must be a non-empty string', { parameter: 'id' }),
      );
    }
    const topic = this.topics.getTopicById(id);
    if (!topic) {
      return fail(failure('not_found', `no topic with id "${id}"`, { topicId: id }));
    }
    return ok({ ...topic, version: CONTENT_API_VERSION });
  }
}
