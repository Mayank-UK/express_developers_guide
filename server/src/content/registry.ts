import { TOPIC_GROUPS, type Topic, type TopicGroupId, type TopicSummary } from './types.js';
import { topicTypescriptJavascript } from './topics/typescript_javascript.js';
import { topicNodeJs } from './topics/node_js.js';
import { topicHttpWeb } from './topics/http_web.js';
import { topicExpressFundamentals } from './topics/express_fundamentals.js';
import { topicRouting } from './topics/routing.js';
import { topicMiddleware } from './topics/middleware.js';
import { topicRequestResponse } from './topics/request_response.js';
import { topicValidation } from './topics/validation.js';
import { topicApiDesign } from './topics/api_design.js';
import { topicApiDocumentation } from './topics/api_documentation.js';
import { topicGraphql } from './topics/graphql.js';
import { topicWebhooks } from './topics/webhooks.js';
import { topicGrpc } from './topics/grpc.js';
import { topicSqlSchema } from './topics/sql_schema.js';
import { topicSqlNode } from './topics/sql_node.js';
import { topicMongodb } from './topics/mongodb.js';
import { topicRedis } from './topics/redis.js';
import { topicCaching } from './topics/caching.js';
import { topicAuthentication } from './topics/authentication.js';
import { topicAuthorization } from './topics/authorization.js';
import { topicSecurity } from './topics/security.js';
import { topicFilesMedia } from './topics/files_media.js';
import { topicInternationalization } from './topics/internationalization.js';
import { topicRealtime } from './topics/realtime.js';
import { topicBackgroundJobs } from './topics/background_jobs.js';
import { topicExceptionHandling } from './topics/exception_handling.js';
import { topicDependencyManagement } from './topics/dependency_management.js';
import { topicArchitecture } from './topics/architecture.js';
import { topicObservability } from './topics/observability.js';
import { topicTesting } from './topics/testing.js';
import { topicDebugging } from './topics/debugging.js';
import { topicEnvironments } from './topics/environments.js';
import { topicDeployment } from './topics/deployment.js';
import { topicPerformance } from './topics/performance.js';
import { topicReliability } from './topics/reliability.js';
import { topicScaling } from './topics/scaling.js';
import { topicBestPractices } from './topics/best_practices.js';
import { topicThirdParty } from './topics/third_party.js';
import { topicMessaging } from './topics/messaging.js';
import { topicAdvancedArchitecture } from './topics/advanced_architecture.js';

const unsorted: readonly Topic[] = [
  topicTypescriptJavascript,
  topicNodeJs,
  topicHttpWeb,
  topicExpressFundamentals,
  topicRouting,
  topicMiddleware,
  topicRequestResponse,
  topicValidation,
  topicApiDesign,
  topicApiDocumentation,
  topicGraphql,
  topicWebhooks,
  topicGrpc,
  topicSqlSchema,
  topicSqlNode,
  topicMongodb,
  topicRedis,
  topicCaching,
  topicAuthentication,
  topicAuthorization,
  topicSecurity,
  topicFilesMedia,
  topicInternationalization,
  topicRealtime,
  topicBackgroundJobs,
  topicExceptionHandling,
  topicDependencyManagement,
  topicArchitecture,
  topicObservability,
  topicTesting,
  topicDebugging,
  topicEnvironments,
  topicDeployment,
  topicPerformance,
  topicReliability,
  topicScaling,
  topicBestPractices,
  topicThirdParty,
  topicMessaging,
  topicAdvancedArchitecture,
];

/** Group id -> nav order; safe cast because TOPIC_GROUPS lists every TopicGroupId. */
const GROUP_ORDER = Object.fromEntries(
  TOPIC_GROUPS.map((group) => [group.id, group.order]),
) as Readonly<Record<TopicGroupId, number>>;

/**
 * The typed-content guarantee: throws at module load — so the process never
 * boots with broken content — on duplicate topic ids, duplicate section or
 * block ids within a topic, invalid block kinds, or unknown groups.
 * Exported for unit tests.
 */
export function validateRegistry(list: readonly Topic[]): void {
  const seenTopicIds = new Set<string>();
  for (const topic of list) {
    if (seenTopicIds.has(topic.id)) {
      throw new Error(`content registry: duplicate topic id "${topic.id}"`);
    }
    seenTopicIds.add(topic.id);

    if (!(topic.group in GROUP_ORDER)) {
      throw new Error(
        `content registry: topic "${topic.id}" has unknown group "${String(topic.group)}"`,
      );
    }

    const seenSectionIds = new Set<string>();
    const seenBlockIds = new Set<string>();
    for (const section of topic.sections) {
      if (seenSectionIds.has(section.id)) {
        throw new Error(
          `content registry: duplicate section id "${section.id}" in topic "${topic.id}"`,
        );
      }
      seenSectionIds.add(section.id);

      for (const block of section.blocks) {
        if (seenBlockIds.has(block.id)) {
          throw new Error(
            `content registry: duplicate block id "${block.id}" in topic "${topic.id}"`,
          );
        }
        seenBlockIds.add(block.id);

        // Captured before the kind check: inside the branch TS narrows block
        // to never (the union is exhausted), but runtime-crafted content can
        // still reach it — this check exists for exactly those cases.
        const rawKind = String(block.kind);
        const rawId = String(block.id);
        if (block.kind !== 'text' && block.kind !== 'code' && block.kind !== 'demo') {
          throw new Error(
            `content registry: invalid block kind "${rawKind}" on block "${rawId}" in topic "${topic.id}"`,
          );
        }
      }
    }
  }
}

validateRegistry(unsorted);

/** All topics, ordered for display: group order first, then topic order. */
export const topics: readonly Topic[] = [...unsorted].sort(
  (a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.order - b.order,
);

/** Summaries for list views — never carries the sections payload. */
export function getTopicSummaries(): TopicSummary[] {
  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    ...(topic.subtitle !== undefined && { subtitle: topic.subtitle }),
    group: topic.group,
    order: topic.order,
    sectionCount: topic.sections.length,
  }));
}

/** Exact-match lookup; undefined when no topic carries that id. */
export function getTopicById(id: string): Topic | undefined {
  return topics.find((topic) => topic.id === id);
}
