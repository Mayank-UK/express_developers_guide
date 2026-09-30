/**
 * The hand-written OpenAPI 3.1 document behind the Swagger UI at /docs.
 *
 * This spec is maintained BESIDE the routes it describes (not generated from
 * them), which is a deliberate choice the api-documentation topic teaches:
 * the document lives or dies by staying honest with the real handlers in
 * this directory — paths, parameters, status codes and the error envelope
 * below mirror what the app actually emits. Drift here is exactly what the
 * topic warns about, so the spec asserts the real surface:
 *
 *   health_routes.ts      → /api/health
 *   content_routes.ts     → /api/content, /api/content/topics/{id}
 *   posts_routes.ts       → /api/posts, /api/posts/{id}
 *   demo_routes.ts        → /api/demo/scenario, /api/demo/app-info,
 *                           /api/demo/error (the error-envelope demo)
 *   graphql_demo_routes.ts → /api/graphql (the non-CRUD representative)
 *
 * SCOPE, stated honestly (info.description carries the same note): this
 * document covers the CORE resource surface above plus two representative
 * non-CRUD entries. The ~25 teaching route groups under /api/demo/** are
 * documented by their topic screens and curl tours instead of exhaustively
 * mirrored here — their contract is pedagogical, consumed by the guide UI,
 * not by tooling; the core surface is what a spec consumer needs.
 *
 * The `{ error: { code, message, requestId } }` envelope produced by the
 * error-handling middleware is ONE reusable schema (components.schemas.Error)
 * shared by every error response — the same single-source-of-truth trick the
 * middleware itself uses.
 */

import {
  FAILURE_ERROR_CODE,
  FAILURE_HTTP_STATUS,
  FAILURE_KINDS,
} from '../../core/error_handling/failures.js';

/**
 * Responses for /api/demo/error, DERIVED from the real failure maps (the
 * endpoint throws whatever kind you name, so statuses and codes are imported,
 * not retyped — the same no-drift trick the errors/taxonomy demo uses).
 * All eight kinds map to distinct statuses; 400 doubles as the bad-param
 * answer (an unknown or missing ?failure value).
 */
const failureDemoResponses = Object.fromEntries(
  FAILURE_KINDS.map((kind) => [
    String(FAILURE_HTTP_STATUS[kind]),
    {
      description:
        `?failure=${kind} — the error envelope with code "${FAILURE_ERROR_CODE[kind]}".` +
        (kind === 'validation'
          ? ' A missing or unknown ?failure value also answers 400, with the valid values in the details.'
          : ''),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  ]),
) as Record<string, unknown>;

/** Served raw at GET /docs/openapi.json and fed to Swagger UI at GET /docs/. */
export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Express Developers Guide API',
    version: '1.0.0',
    summary: 'The guide app\'s own HTTP surface — the API this guide teaches with.',
    description: [
      'Every path below is served by the running app you are looking at.',
      'The posts pipeline (routes → use case → repository) is the canonical',
      'vertical slice; the demo endpoints toggle the runtime scenario',
      '(fake/live data, failure injection) so you can watch the same resource',
      'answer from different data modes — including the 503 failure envelope.',
      'Errors always use the shared Error envelope carried by the',
      'error-handling middleware; failures merge extra detail keys flat',
      'alongside the canonical code/message/requestId triple.',
      'Scope: paths here cover the CORE resource surface (health, content,',
      'posts, scenario) plus two representative non-CRUD entries',
      '(/api/demo/error, /api/graphql). The teaching routes under',
      '/api/demo/** are documented by their topic screens and curl tours',
      'rather than exhaustively mirrored here.',
    ].join(' '),
  },
  servers: [
    {
      url: '/',
      description: 'this server (relative — works on any host/port the app runs on)',
    },
  ],
  tags: [
    { name: 'health', description: 'Liveness — no scenario dependence, no container.' },
    { name: 'content', description: 'The typed topic tree the React client renders.' },
    { name: 'posts', description: 'The canonical layered pipeline resource.' },
    { name: 'demo', description: 'Runtime scenario state and app facts for the client demos.' },
    { name: 'graphql', description: 'The hand-rolled non-CRUD representative — its topic owns the schema.' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['health'],
        summary: 'Liveness check',
        description:
          'Pure liveness: if this responds, the process is up. No scenario dependence, no container.',
        operationId: 'getHealth',
        responses: {
          200: {
            description: 'The process is up.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthStatus' },
                example: { status: 'ok', uptime: 1284, requestId: '9a1f5c33-7e42-4b08-b5d6-8c7e2f1a0b4c' },
              },
            },
          },
        },
      },
    },
    '/api/content': {
      get: {
        tags: ['content'],
        summary: 'The topic tree (summaries only)',
        description:
          'Versioned content index: groups in display order plus one summary per topic — never the sections payload.',
        operationId: 'listContent',
        responses: {
          200: {
            description: 'Content index with topic summaries.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ContentIndex' },
              },
            },
          },
        },
      },
    },
    '/api/content/topics/{id}': {
      get: {
        tags: ['content'],
        summary: 'One fully populated topic',
        description:
          'Serves the topic with its sections and blocks (text | code | demo). Topic ids are the client nav registry\'s stable slugs.',
        operationId: 'getTopic',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Topic slug — e.g. api-design, api-documentation, validation.',
            schema: { type: 'string', pattern: '^[a-z0-9-]+$' },
            example: 'api-design',
          },
        ],
        responses: {
          200: {
            description: 'The topic with sections and blocks.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Topic' },
              },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/posts': {
      get: {
        tags: ['posts'],
        summary: 'List posts',
        description:
          'All posts, newest first (createdAt DESC, then id DESC). The repository answering is chosen per call from the scenario (fake in-memory or live sqlite) — the wire contract is identical either way.',
        operationId: 'listPosts',
        responses: {
          200: {
            description: 'The posts collection.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['posts'],
                  properties: {
                    posts: { type: 'array', items: { $ref: '#/components/schemas/Post' } },
                  },
                },
                example: {
                  posts: [
                    {
                      id: '0f1c2b3a-0000-4000-8000-000000000003',
                      title: 'Failures are values here',
                      body: 'Repositories and use cases return Result values instead of throwing; only the presentation edge converts a Failure into a typed exception for the error middleware.',
                      author: 'the guide',
                      createdAt: '2026-09-24T09:10:00.000Z',
                      updatedAt: '2026-09-24T09:10:00.000Z',
                    },
                  ],
                },
              },
            },
          },
          503: { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
      post: {
        tags: ['posts'],
        summary: 'Create a post',
        description:
          'Validation lives in the use case (title/body/author, strings of 1..120 / 1..5000 / 1..80 chars, unknown fields rejected); the route stays a thin translator. Answers 201 with the created post — the representation rides the body.',
        operationId: 'createPost',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePostInput' },
              example: {
                title: 'A post from the workbench',
                body: 'Created through the posts workbench demo — the same pipeline every client uses.',
                author: 'you',
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Created — the new post rides the body (no Location header on this endpoint; the body is the address).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Post' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          503: { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/api/posts/{id}': {
      get: {
        tags: ['posts'],
        summary: 'Fetch one post',
        description:
          'Route matched ≠ resource found: an unknown-but-well-formed id answers 404 with the envelope (the failure details carry the offending postId).',
        operationId: 'getPostById',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Post id (UUID).',
            schema: { type: 'string', format: 'uuid' },
            example: '0f1c2b3a-0000-4000-8000-000000000001',
          },
        ],
        responses: {
          200: {
            description: 'The post representation.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Post' },
              },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
          503: { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/api/demo/scenario': {
      get: {
        tags: ['demo'],
        summary: 'Current runtime scenario',
        description:
          'The live scenario state the container reads per call: which data mode answers and whether failure injection is on.',
        operationId: 'getScenario',
        responses: {
          200: {
            description: 'Current scenario state.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScenarioState' },
                example: { dataMode: 'fake', injectFailure: false },
              },
            },
          },
        },
      },
      patch: {
        tags: ['demo'],
        summary: 'Toggle the runtime scenario',
        description:
          'Partial update — send only the fields you want to flip. Accepts an empty object as a no-op. Unknown fields are rejected with a 400 naming them.',
        operationId: 'patchScenario',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ScenarioPatch' },
              examples: {
                switchToLive: { value: { dataMode: 'live' } },
                injectFailure: { value: { injectFailure: true } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'The scenario state after applying the patch.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ScenarioState' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
        },
      },
    },
    '/api/demo/app-info': {
      get: {
        tags: ['demo'],
        summary: 'App facts for the client demo',
        description:
          'Runtime facts (node/express versions, env, uptime, pid) plus config and the live scenario — every value read per request so the answer always reflects now.',
        operationId: 'getAppInfo',
        responses: {
          200: {
            description: 'Process/config/scenario facts.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AppInfo' },
              },
            },
          },
        },
      },
    },
    '/api/demo/error': {
      get: {
        tags: ['demo'],
        summary: 'Throw any failure kind on purpose',
        description:
          'The error-contract demo: name a failure kind and the endpoint throws the matching typed exception, so the middleware answers with the real envelope at the real status. The response list below is derived from the failure taxonomy itself — one entry per kind.',
        operationId: 'getDemoError',
        parameters: [
          {
            name: 'failure',
            in: 'query',
            required: true,
            description: 'Which failure kind to inject (the taxonomy\'s kind names, not the error codes).',
            schema: { type: 'string', enum: [...FAILURE_KINDS] },
            example: 'unavailable',
          },
        ],
        responses: failureDemoResponses,
      },
    },
    '/api/graphql': {
      post: {
        tags: ['graphql'],
        summary: 'Run a GraphQL operation (POST-only)',
        description:
          'The non-CRUD representative: a hand-rolled GraphQL-over-HTTP handler. Parse/validation problems answer 400 with a GraphQL errors array — deliberately NOT the REST envelope, a different contract. A successful execution answers 200 with data and/or errors, because partial data plus errors is a legal GraphQL answer. The schema itself is introspectable; the GraphQL topic owns it.',
        operationId: 'runGraphql',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string', description: 'A GraphQL document string.' },
                  variables: {
                    type: 'object',
                    description: 'Optional — values for the document\'s variable definitions.',
                  },
                  operationName: {
                    type: ['string', 'null'],
                    description: 'Optional — picks one operation when the document has several.',
                  },
                },
              },
              example: { query: '{ posts { id title } }' },
            },
          },
        },
        responses: {
          200: {
            description: 'Executed — data and/or errors (execution failures still answer 200; partial data is legal GraphQL).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'A sketch — GraphQL\'s real contract is its introspectable schema, not this entry.',
                  properties: {
                    data: { description: 'The operation result; shape depends on the query.' },
                    errors: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          message: { type: 'string' },
                          locations: { type: 'array', items: { type: 'object' } },
                          path: { type: 'array' },
                          extensions: { type: 'object' },
                        },
                      },
                    },
                  },
                },
                example: {
                  data: { posts: [{ id: '0f1c2b3a-0000-4000-8000-000000000003', title: 'Failures are values here' }] },
                },
              },
            },
          },
          400: {
            description: 'Bad request envelope, unparseable document, or schema-invalid operation — a GraphQL errors array, not the REST envelope.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['errors'],
                  properties: {
                    errors: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { message: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      get: {
        tags: ['graphql'],
        summary: 'GET explains the contract (405)',
        description:
          'Reserved for tooling (GraphiQL) in real deployments; this teaching endpoint answers 405 with Allow: POST and a body showing how to call it.',
        operationId: 'getGraphqlGuidance',
        responses: {
          405: {
            description: 'Method not allowed — POST only (Allow: POST).',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        description:
          'The one error envelope every failure answers with (error-handling middleware). Failure details merge flat alongside the canonical keys, so extra keys like fields (validation) or postId (not-found) may ride along.',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: {
                type: 'string',
                description: 'Machine-readable, derived from the failure kind.',
                enum: [
                  'validation_failed',
                  'unauthorized',
                  'forbidden',
                  'not_found',
                  'conflict',
                  'rate_limited',
                  'service_unavailable',
                  'internal_error',
                  'request_failed',
                ],
              },
              message: { type: 'string', description: 'Human-readable; safe to show.' },
              requestId: {
                type: 'string',
                description: 'Matches the x-request-id response header — quote it when you ask about a failure.',
              },
              fields: {
                type: 'object',
                description: 'validation failures only: field name → human message.',
                additionalProperties: { type: 'string' },
              },
            },
          },
        },
        example: {
          error: {
            code: 'validation_failed',
            message: 'post payload is invalid',
            requestId: '9a1f5c33-7e42-4b08-b5d6-8c7e2f1a0b4c',
            fields: { title: 'must be a string of 1 to 120 characters (got 0)' },
          },
        },
      },
      Post: {
        type: 'object',
        description: 'A post — the canonical resource of the layered pipeline.',
        required: ['id', 'title', 'body', 'author', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          body: { type: 'string', minLength: 1, maxLength: 5000 },
          author: { type: 'string', minLength: 1, maxLength: 80 },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        example: {
          id: '0f1c2b3a-0000-4000-8000-000000000002',
          title: 'The dependency rule, concretely',
          body: 'Presentation may import domain; data implements domain interfaces. Nothing under src/data is ever imported by a route — the container does all wiring.',
          author: 'the guide',
          createdAt: '2026-09-24T09:05:00.000Z',
          updatedAt: '2026-09-24T09:05:00.000Z',
        },
      },
      CreatePostInput: {
        type: 'object',
        description: 'What a create request must carry. Unknown fields are rejected — a whitelist, not a blacklist.',
        required: ['title', 'body', 'author'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120 },
          body: { type: 'string', minLength: 1, maxLength: 5000 },
          author: { type: 'string', minLength: 1, maxLength: 80 },
        },
        additionalProperties: false,
      },
      ScenarioState: {
        type: 'object',
        description: 'Runtime scenario — read per call by the container.',
        required: ['dataMode', 'injectFailure'],
        properties: {
          dataMode: { type: 'string', enum: ['fake', 'live'] },
          injectFailure: { type: 'boolean' },
        },
      },
      ScenarioPatch: {
        type: 'object',
        description: 'Partial scenario update; omit what you do not want to change.',
        minProperties: 0,
        properties: {
          dataMode: { type: 'string', enum: ['fake', 'live'] },
          injectFailure: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      HealthStatus: {
        type: 'object',
        required: ['status', 'uptime', 'requestId'],
        properties: {
          status: { type: 'string', const: 'ok' },
          uptime: { type: 'integer', description: 'Process uptime in whole seconds.' },
          requestId: { type: 'string' },
        },
      },
      AppInfo: {
        type: 'object',
        required: [
          'app',
          'nodeVersion',
          'expressVersion',
          'env',
          'uptimeSeconds',
          'pid',
          'scenario',
        ],
        properties: {
          app: { type: 'string', const: 'express_developers_guide' },
          nodeVersion: { type: 'string', example: 'v22.0.0' },
          expressVersion: { type: 'string', example: '5.1.0' },
          env: { type: 'string', example: 'development' },
          uptimeSeconds: { type: 'integer' },
          pid: { type: 'integer' },
          scenario: { $ref: '#/components/schemas/ScenarioState' },
        },
      },
      ContentIndex: {
        type: 'object',
        description: 'Versioned content tree: display-ordered groups + topic summaries (no sections).',
        required: ['version', 'groups', 'topics'],
        properties: {
          version: { type: 'integer', description: 'Bumped when response shapes change.', const: 1 },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'title', 'order'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                order: { type: 'integer' },
              },
            },
          },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'title', 'group', 'order', 'sectionCount'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                subtitle: { type: 'string' },
                group: { type: 'string' },
                order: { type: 'integer' },
                sectionCount: { type: 'integer' },
              },
            },
          },
        },
      },
      Topic: {
        type: 'object',
        description:
          'One populated topic: sections of blocks (text | code | demo). Kept deliberately loose — the shapes are the content API\'s contract, not this spec\'s teaching burden.',
        required: ['id', 'title', 'group', 'order', 'sections'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          group: { type: 'string' },
          order: { type: 'integer' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'title', 'blocks'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                lead: { type: 'string' },
                blocks: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ContentBlock' },
                },
              },
            },
          },
        },
      },
      ContentBlock: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'id', 'body'],
            properties: {
              kind: { type: 'string', const: 'text' },
              id: { type: 'string' },
              body: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['kind', 'id', 'language', 'code'],
            properties: {
              kind: { type: 'string', const: 'code' },
              id: { type: 'string' },
              language: { type: 'string' },
              caption: { type: 'string' },
              code: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['kind', 'id', 'demoId', 'title'],
            properties: {
              kind: { type: 'string', const: 'demo' },
              id: { type: 'string' },
              demoId: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
            },
          },
        ],
      },
    },
    responses: {
      BadRequest: {
        description: 'Validation failure — the envelope names the offending fields.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
      NotFound: {
        description: 'Unknown resource — the envelope (details carry the requested id).',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
      ServiceUnavailable: {
        description: 'Failure injection is ON — the demo 503. Nothing the client sent is wrong.',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
          },
        },
      },
    },
  },
} as const;
