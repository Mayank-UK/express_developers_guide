import { Router, type Request, type Response } from 'express';
import {
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLError,
  execute,
  parse,
  validate,
  type ExecutionResult,
} from 'graphql';
import { getContainer } from '../../di/container.js';
import { FAILURE_ERROR_CODE, type Failure } from '../../core/error_handling/failures.js';

/**
 * A REAL GraphQL endpoint (the `graphql` topic's working example) — no
 * express-graphql (deprecated), no Apollo: just the reference graphql-js
 * implementation and a handler small enough to read end to end, which is
 * itself the teaching. The schema exposes the SAME PostsUseCase the REST
 * routes use (via the container), so fake/live data and failure injection
 * apply to GraphQL exactly as they do to REST.
 *
 * - POST /api/graphql  → { data, errors } — parse, validate, execute, map
 * - GET  /api/graphql  → 405 + friendly POST-only guidance
 *
 * Error policy (deliberate, documented divergence from the REST envelope):
 * this endpoint speaks GraphQL's OWN error channel — an `errors` array whose
 * entries carry `extensions.code` — because a GraphQL client parses that
 * format, not the app's REST envelope. The CODES are still the app's one
 * taxonomy (failure kind → FAILURE_ERROR_CODE), so the dialect changes while
 * the vocabulary stays shared.
 */

/** Post objects come from the domain already shaped; default resolvers read properties. */
const graphqlPostType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Post',
  description: 'A guide post — the same domain Post the REST API serves.',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    body: { type: new GraphQLNonNull(GraphQLString) },
    author: { type: new GraphQLNonNull(GraphQLString) },
    // A real schema would define a DateTime scalar; String keeps the teaching
    // focused on the pipeline rather than custom scalars.
    createdAt: { type: new GraphQLNonNull(GraphQLString) },
    updatedAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** Result failures become GraphQL errors whose extensions.code is the app's own error code. */
function failureToGraphQLError(source: Failure): GraphQLError {
  return new GraphQLError(source.message, {
    extensions: { code: FAILURE_ERROR_CODE[source.kind], ...(source.details ?? {}) },
  });
}

const graphqlQueryType = new GraphQLObjectType({
  name: 'Query',
  description: 'Read operations — the same list/detail the REST routes expose.',
  fields: {
    posts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(graphqlPostType))),
      description: 'All posts, newest first. One resolver call for the whole list.',
      resolve: async () => {
        const result = await getContainer().postsUseCase.list();
        if (!result.ok) throw failureToGraphQLError(result.error);
        return result.value;
      },
    },
    post: {
      type: graphqlPostType, // nullable on purpose: a well-formed id may match nothing
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      description: 'One post by id. Nullable: unknown ids answer null + an error entry.',
      resolve: async (_source, args: { id: string }) => {
        const result = await getContainer().postsUseCase.getById(args.id);
        if (!result.ok) throw failureToGraphQLError(result.error);
        return result.value;
      },
    },
  },
});

const graphqlMutationType = new GraphQLObjectType({
  name: 'Mutation',
  description: 'Write operations — the same validation path POST /api/posts uses.',
  fields: {
    createPost: {
      type: new GraphQLNonNull(graphqlPostType),
      args: {
        title: { type: new GraphQLNonNull(GraphQLString) },
        body: { type: new GraphQLNonNull(GraphQLString) },
        author: { type: new GraphQLNonNull(GraphQLString) },
      },
      description: 'Create a post. Validation failures arrive as errors with extensions.fields.',
      resolve: async (_source, args: { title: string; body: string; author: string }) => {
        // Args are exactly the CreatePostInput shape — the use case validates.
        const result = await getContainer().postsUseCase.create(args);
        if (!result.ok) throw failureToGraphQLError(result.error);
        return result.value;
      },
    },
  },
});

export const graphqlDemoSchema: GraphQLSchema = new GraphQLSchema({
  query: graphqlQueryType,
  mutation: graphqlMutationType,
});

/** The wire shape of one error entry: message + where it happened + machine code. */
function formatGraphQLError(error: GraphQLError): Record<string, unknown> {
  return {
    message: error.message,
    ...(error.locations !== undefined && error.locations.length > 0 && { locations: error.locations }),
    ...(error.path !== undefined && { path: error.path }),
    ...(error.extensions !== undefined &&
      Object.keys(error.extensions).length > 0 && { extensions: error.extensions }),
  };
}

function respondGraphql(res: Response, status: number, result: Partial<ExecutionResult>): void {
  res.status(status).json({
    ...('data' in result ? { data: result.data ?? null } : {}),
    ...(result.errors !== undefined && result.errors.length > 0
      ? { errors: result.errors.map(formatGraphQLError) }
      : {}),
  });
}

/** Request-envelope validation: { query, variables?, operationName? }. Throws GraphQLError. */
function readGraphqlRequestBody(body: unknown): {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new GraphQLError(
      'GraphQL requests need a JSON object body with a "query" field (Content-Type: application/json)',
      { extensions: { code: FAILURE_ERROR_CODE.validation } },
    );
  }
  const { query, variables, operationName } = body as Record<string, unknown>;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new GraphQLError('"query" must be a non-empty GraphQL document string', {
      extensions: { code: FAILURE_ERROR_CODE.validation },
    });
  }
  if (
    variables !== undefined &&
    variables !== null &&
    (typeof variables !== 'object' || Array.isArray(variables))
  ) {
    throw new GraphQLError('"variables" must be a JSON object (or null)', {
      extensions: { code: FAILURE_ERROR_CODE.validation },
    });
  }
  if (
    operationName !== undefined &&
    operationName !== null &&
    typeof operationName !== 'string'
  ) {
    throw new GraphQLError('"operationName" must be a string (or null)', {
      extensions: { code: FAILURE_ERROR_CODE.validation },
    });
  }
  return {
    query,
    ...(variables !== undefined && variables !== null && { variables: variables as Record<string, unknown> }),
    ...(operationName !== undefined && operationName !== null && { operationName }),
  };
}

/**
 * The whole GraphQL-over-HTTP handler: parse the request envelope, parse the
 * document, validate it against the schema, execute it, and answer with
 * { data, errors }. Parse/validation problems are 400s; execution errors are
 * a 200 — the operation RAN, and partial data plus errors is a legal answer.
 */
async function graphqlController(req: Request, res: Response): Promise<void> {
  let request: ReturnType<typeof readGraphqlRequestBody>;
  try {
    request = readGraphqlRequestBody(req.body);
  } catch (error) {
    respondGraphql(res, 400, { errors: [error as GraphQLError] });
    return;
  }

  let document;
  try {
    document = parse(request.query);
  } catch (error) {
    respondGraphql(res, 400, { errors: [error as GraphQLError] });
    return;
  }

  const validationErrors = validate(graphqlDemoSchema, document);
  if (validationErrors.length > 0) {
    respondGraphql(res, 400, { errors: [...validationErrors] });
    return;
  }

  const result = await execute({
    schema: graphqlDemoSchema,
    document,
    ...(request.variables !== undefined && { variableValues: request.variables }),
    ...(request.operationName !== undefined && { operationName: request.operationName }),
    // contextValue is how per-request state (auth user, request id) reaches
    // every resolver without globals — the GraphQL counterpart of DI.
    contextValue: { requestId: res.locals.requestId },
  });
  respondGraphql(res, 200, result);
}

/** GET is reserved for tooling (GraphiQL) in real apps; here it explains the contract. */
function graphqlGetController(_req: Request, res: Response): void {
  res
    .set('Allow', 'POST')
    .status(405)
    .json({
      message: 'This is a GraphQL endpoint: POST a JSON object to /api/graphql.',
      how: {
        url: '/api/graphql',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { query: '{ posts { id title } }', variables: null, operationName: null },
      },
      note: 'Real deployments usually serve GraphiQL (an in-browser query editor) on GET; this teaching endpoint answers POST only. Try the playground in the GraphQL topic, or curl the example above.',
    });
}

export const graphqlDemoRouter = Router();
graphqlDemoRouter.post('/graphql', graphqlController);
graphqlDemoRouter.get('/graphql', graphqlGetController);
