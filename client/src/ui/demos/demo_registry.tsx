import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Example } from '../components/example';

/**
 * Demo registry — the client-side half of the DemoBlock contract. Content
 * served by the API names a demo by `demoId`; this map is the only place that
 * binds an id to an implementation. Demos are lazy-loaded so a topic's bundle
 * only pays for the demos it actually renders, and an unknown id degrades to a
 * "coming soon" panel instead of crashing the screen.
 */

export type DemoComponentType = ComponentType;

const AppInfoDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./express/app_info_demo'),
);

const RoutingExplorerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./express/routing_explorer_demo'),
);

const MiddlewarePipelineDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./express/middleware_pipeline_demo'),
);

const RequestInspectorDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./express/request_inspector_demo'),
);

const ResponseMethodsDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./express/response_methods_demo'),
);

const ValidationArenaDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./express/validation_arena_demo'),
);

const RuntimeTypesDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./fundamentals/runtime_types_demo'),
);

const EventLoopDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./fundamentals/event_loop_demo'),
);

const StreamingDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./fundamentals/streaming_demo'),
);

const HttpHeadersDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./fundamentals/http_headers_demo'),
);

const PostsWorkbenchDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./apis/posts_workbench_demo'),
);

const DocsLinkDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./apis/docs_link_demo'),
);

const GraphqlPlaygroundDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./apis/graphql_playground_demo'),
);

const WebhookSimulatorDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./apis/webhook_simulator_demo'),
);

const GrpcConsoleDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./apis/grpc_console_demo'),
);

const SchemaExplorerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/schema_explorer_demo'),
);

const MigrationRunnerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/migration_runner_demo'),
);

const SqlSafetyDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/sql_safety_demo'),
);

const MongoConsoleDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/mongo_console_demo'),
);

const SqlLabDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/sql_lab_demo'),
);

const FtsSearchDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/fts_search_demo'),
);

const BookingRaceDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/booking_race_demo'),
);

const UuidStrategyDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/uuid_strategy_demo'),
);

const AuditLogDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./data/audit_log_demo'),
);

const StreamConsoleDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./messaging/stream_console_demo'),
);

const OutboxRelayDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./messaging/outbox_relay_demo'),
);

const RedisPlaygroundDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./infra/redis_playground_demo'),
);

const CachingLabDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./infra/caching_lab_demo'),
);

const SessionLoginDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./auth/session_login_demo'),
);

const ApiKeyDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./auth/api_key_demo'),
);

const JwtDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./auth/jwt_demo'),
);

const OauthFlowDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./auth/oauth_flow_demo'),
);

const PasswordHashingDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./auth/password_hashing_demo'),
);

const RefreshRotationDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./auth/refresh_rotation_demo'),
);

const AuthzMatrixDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./auth/authz_matrix_demo'),
);

const SecurityLabDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./security/security_lab_demo'),
);

const PiiErasureDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./security/pii_erasure_demo'),
);

const FilesWorkbenchDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./media/files_workbench_demo'),
);

const I18nNegotiatorDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./i18n/i18n_demo'),
);

const SseTickerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./realtime/sse_ticker_demo'),
);

const WsChatDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./realtime/ws_chat_demo'),
);

const JobsConsoleDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/jobs_console_demo'),
);

const ErrorExplorerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/error_explorer_demo'),
);

const DepsManifestDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/deps_manifest_demo'),
);

const EnvInspectorDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/env_inspector_demo'),
);

const ArchTracerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/arch_tracer_demo'),
);

const EventStoreDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/event_store_demo'),
);

const OrderSagaDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/order_saga_demo'),
);

const LogViewerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/log_viewer_demo'),
);

const TraceWaterfallDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/trace_waterfall_demo'),
);

const TestRunnerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/test_runner_demo'),
);

const StallDiagnosisDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/stall_diagnosis_demo'),
);

const DeployStackDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/deploy_stack_demo'),
);

const PerfBenchDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/perf_bench_demo'),
);

const CircuitBreakerDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/circuit_breaker_demo'),
);

const StatelessInventoryDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/stateless_inventory_demo'),
);

const BestPracticesAuditDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/best_practices_audit_demo'),
);

const ThirdPartyHubDemo: LazyExoticComponent<DemoComponentType> = lazy(() =>
  import('./platform/third_party_hub_demo'),
);

export const demoRegistry: Readonly<Record<string, LazyExoticComponent<DemoComponentType>>> = {
  'express:app-info': AppInfoDemo,
  'routing:explorer': RoutingExplorerDemo,
  'middleware:pipeline': MiddlewarePipelineDemo,
  'reqres:inspector': RequestInspectorDemo,
  'reqres:methods': ResponseMethodsDemo,
  'validation:arena': ValidationArenaDemo,
  'ts:runtime-types': RuntimeTypesDemo,
  'node:event-loop': EventLoopDemo,
  'node:streaming': StreamingDemo,
  'http:headers': HttpHeadersDemo,
  'api:posts-workbench': PostsWorkbenchDemo,
  'api:docs-link': DocsLinkDemo,
  'api:graphql-playground': GraphqlPlaygroundDemo,
  'api:webhook-simulator': WebhookSimulatorDemo,
  'api:grpc-console': GrpcConsoleDemo,
  'db:schema-explorer': SchemaExplorerDemo,
  'db:migrations': MigrationRunnerDemo,
  'db:sql-safety': SqlSafetyDemo,
  'db:mongo-console': MongoConsoleDemo,
  'db:sql-lab': SqlLabDemo,
  'db:search': FtsSearchDemo,
  'db:race': BookingRaceDemo,
  'db:uuid': UuidStrategyDemo,
  'db:audit': AuditLogDemo,
  'msg:stream': StreamConsoleDemo,
  'msg:outbox': OutboxRelayDemo,
  'redis:playground': RedisPlaygroundDemo,
  'caching:lab': CachingLabDemo,
  'auth:sessions': SessionLoginDemo,
  'auth:api-keys': ApiKeyDemo,
  'auth:jwt': JwtDemo,
  'auth:oauth': OauthFlowDemo,
  'auth:hashing': PasswordHashingDemo,
  'auth:refresh': RefreshRotationDemo,
  'authz:matrix': AuthzMatrixDemo,
  'security:lab': SecurityLabDemo,
  'security:pii': PiiErasureDemo,
  'files:workbench': FilesWorkbenchDemo,
  'i18n:negotiator': I18nNegotiatorDemo,
  'realtime:ticker': SseTickerDemo,
  'realtime:chat': WsChatDemo,
  'jobs:console': JobsConsoleDemo,
  'errors:explorer': ErrorExplorerDemo,
  'deps:manifest': DepsManifestDemo,
  'env:inspector': EnvInspectorDemo,
  'arch:tracer': ArchTracerDemo,
  'arch:eventstore': EventStoreDemo,
  'arch:saga': OrderSagaDemo,
  'obs:viewer': LogViewerDemo,
  'obs:trace': TraceWaterfallDemo,
  'testing:runner': TestRunnerDemo,
  'debug:stall': StallDiagnosisDemo,
  'deploy:stack': DeployStackDemo,
  'perf:bench': PerfBenchDemo,
  'reliability:breaker': CircuitBreakerDemo,
  'scaling:stateless': StatelessInventoryDemo,
  'best:checklist': BestPracticesAuditDemo,
  'thirdparty:hub': ThirdPartyHubDemo,
};

export interface DemoHostProps {
  demoId: string;
  title: string;
  description?: string;
}

/**
 * DemoHost — renders the Example panel for a demo block and mounts the
 * registered component inside it. Unknown demoIds (content shipped before the
 * demo landed) render the panel with a "coming soon" note — never an error.
 */
export function DemoHost({ demoId, title, description }: DemoHostProps) {
  const Demo = demoRegistry[demoId];

  return (
    <Example title={title} description={description}>
      {Demo === undefined ? (
        <p data-testid="demo-coming-soon" className="text-body-sm text-on-surface-variant">
          This demo is coming soon — the content API already references it, but the
          interactive part has not landed yet.
        </p>
      ) : (
        <Suspense fallback={<p className="text-body-sm text-on-surface-variant">loading demo…</p>}>
          <Demo />
        </Suspense>
      )}
    </Example>
  );
}
