import type { Topic } from '../types.js';

/**
 * The GraphQL topic: what problem it solves, schema/resolvers, a complete
 * handler in a few dozen lines of Express, queries/mutations, the errors
 * channel, N+1 and batching, introspection/tooling — concept-first, then the
 * REAL endpoint this app serves (graphql_demo_routes.ts), which runs the same
 * PostsUseCase the REST routes use. Snippets marked verbatim are the running
 * source; illustrative sketches say so in their captions.
 */
export const topicGraphql: Topic = {
  id: 'graphql',
  title: 'GraphQL',
  subtitle:
    'A typed query layer alongside REST: schema, resolvers, and when it earns its complexity.',
  group: 'apis',
  order: 3,
  sections: [
    {
      id: 'graphql-why',
      title: 'The problem GraphQL solves',
      lead: "GraphQL exists because REST's fixed representations fit nobody perfectly: every endpoint over-serves some clients and under-serves others. One endpoint where each client describes exactly the shape it needs is the fix — and the bill is a schema, a resolver layer, and a new failure surface.",
      blocks: [
        {
          kind: 'text',
          id: 'graphql-why:fetching',
          body: `Two chronic REST pains, concretely. OVER-FETCHING: a mobile post-list screen needs a post's title and nothing else, but GET /api/posts answers with body, author, createdAt, updatedAt — five fields shipped for two used, on a metered radio, times every scroll. Multiply by endpoints and screens and over-fetching becomes a real cost line. UNDER-FETCHING (the N+1 of HTTP): the same screen also wants each post's comment count, so you either add ?include=comments (a per-client permutation that metastasizes into include=comments,author.profile,reactions — the "REST query language" anti-pattern) or the client fires GET /api/posts/:id/comments per post — eleven round trips where one would do. The root cause in both: the SERVER decides the response's shape, once, for everyone.\n\nGraphQL inverts that one decision. There is ONE endpoint, and the CLIENT sends a query describing the exact shape it wants — fields, nesting, depth. The server walks that description against a SCHEMA (the typed catalog of everything queryable) and builds precisely that JSON. No over-fetching (you get the fields you named), no under-fetching (related data nests in one request), no include= permutations (the query IS the permutation). The schema is a contract that is executable: the same document that tells clients what exists tells the server how to validate, and tooling on both sides generates from it.\n\nAnd the honest counterweight — when REST is still right: one endpoint that answers arbitrary shapes is a voluntarily given up caching simplicity (GET /api/posts is cacheable by URL; a POSTed query is not — GraphQL deployments rebuild caching with persisted queries and CDNs that understand them), a server that must reason about query DEPTH and cost (a malicious query can ask for exponentially nested data — depth limiting and cost analysis are operational requirements, not options), and a mental model clients must learn (a query language) versus "HTTP + JSON" that any curl user already has. For entity-shaped products with many consuming clients (the Facebook-to-GitHub scale of the problem), the trade pays; for three consumers and stable shapes — most internal services — REST plus a sparse-fieldsets convention (the REST topic's ?fields=title,author — deliberately the poor man's GraphQL) is simpler and ages fine. This app keeps BOTH: the REST surface from the previous topics, and the GraphQL endpoint this topic builds, over the SAME domain pipeline.`,
        },
        {
          kind: 'code',
          id: 'graphql-why:comparison',
          language: 'txt',
          caption: 'The same screen three ways — REST over/under-fetching, the include= sprawl, and the GraphQL query this app actually answers',
          code: `# REST: over-fetching — the screen wants titles, the endpoint ships whole posts:
GET /api/posts
→ [ { id, title, body(2KB), author, createdAt, updatedAt }, ×3 ]

# REST: under-fetching — comment counts need a second round per post:
GET /api/posts , then GET /api/posts/:id/comments ×3   # 4 round trips

# REST "fix" that rots: per-client query flags on the server:
GET /api/posts?include=comments,author.profile&fields=title  # a private query language

# GraphQL: the client names the shape, one round trip (real query this app serves):
POST /api/graphql
{ "query": "{ posts { title comments { total } } }" }
→ { "data": { "posts": [ { "title": "…", "comments": { "total": 4 } } ] } }

# and the SAME endpoint serves the minimal mobile shape:
{ "query": "{ posts { title } }" }
→ { "data": { "posts": [ { "title": "…" } ] } }        # nothing else shipped`,
        },
      ],
    },
    {
      id: 'graphql-schema',
      title: 'Schema, types, and resolvers',
      lead: 'Three pieces, three jobs: the schema is the contract, the types are its vocabulary, and resolvers are the functions that actually produce each field\'s value. Everything else in a GraphQL server is ceremony around these.',
      blocks: [
        {
          kind: 'text',
          id: 'graphql-schema:anatomy',
          body: `The SCHEMA is written in SDL, the Schema Definition Language — a small typed language of types, fields, and arguments. Every schema has at least a Query type (the read entry points); ours also has a Mutation type (the write entry points). Walk the vocabulary in the SDL below. OBJECT TYPES name a thing and its fields (type Post). SCALARS are the leaves — String, ID (a String that means identity, serialized differently by some clients), Int, Float, Boolean, and custom scalars you define (a DateTime, taught as an extension). The ! is NON-NULL: the field is guaranteed, and if a resolver under it fails, the guarantee propagates — nulls bubble UP to the nearest nullable ancestor, which is why our posts: [Post!]! failing nulls the entire response's data, while post(id): Post (nullable) failing nulls just that field. LISTS bracket their item type ([Post!]! = a non-null list of non-null posts). ARGUMENTS parameterize fields (post(id: ID!)) exactly like function parameters, with the same type system.\n\nRESOLVERS are those functions. The default resolver for a field is "read the property of the parent object by the field's name" — which is why our Post fields need no resolvers at all: the domain Post objects already have id, title, body…. You write a resolver wherever producing a field takes WORK: posts resolves by calling the use case; createPost by validating and creating. A resolver receives (parent, args, context, info): the PARENT (what the enclosing field produced), ARGS (the typed arguments), CONTEXT (per-request state — auth user, request id — the GraphQL counterpart of dependency injection), and INFO (the query AST, for advanced tricks like inspecting what subfields were requested). The schema and the resolvers are wired together in code or via tools like codegen from SDL; this app builds the schema programmatically with graphql-js's GraphQLObjectType so resolvers sit right next to their field definitions — everything in one file you can read top to bottom.`,
        },
        {
          kind: 'code',
          id: 'graphql-schema:sdl',
          language: 'graphql',
          caption: 'The schema THIS app serves — the verbatim output of printSchema(graphqlDemoSchema), recorded as a real repo artifact (server/src/domain/teaching/exhibit_a_graphql_printed_schema.ts) so it can be quoted; graphql-js derives this SDL from the programmatic definition in graphql_demo_routes.ts',
          source: 'server/src/domain/teaching/exhibit_a_graphql_printed_schema.ts',
          code: `# (The recorded artifact wraps the SDL in a TS template literal; the SDL
# itself, from the top — the Query type's doc string names its role:)
# """Read operations — the same list/detail the REST routes expose."""
type Query {
  """All posts, newest first. One resolver call for the whole list."""
  posts: [Post!]!

  """One post by id. Nullable: unknown ids answer null + an error entry."""
  post(id: ID!): Post
}

"""A guide post — the same domain Post the REST API serves."""
type Post {
  id: ID!
  title: String!
  body: String!
  author: String!
  createdAt: String!
  updatedAt: String!
}

"""Write operations — the same validation path POST /api/posts uses."""
type Mutation {
  """
  Create a post. Validation failures arrive as errors with extensions.fields.
  """
  createPost(title: String!, body: String!, author: String!): Post!
}`,
        },
        {
          kind: 'code',
          id: 'graphql-schema:resolvers',
          language: 'ts',
          caption: 'Verbatim — the failure→error mapping that keeps the app\'s ONE taxonomy, then the Query resolvers (graphql_demo_routes.ts): same PostsUseCase the REST controllers call',
          source: 'server/src/presentation/routes/graphql_demo_routes.ts',
          code: `// Result failures become GraphQL errors whose extensions.code is the app's
// own error code — the one taxonomy wearing the GraphQL dialect:
function failureToGraphQLError(source: Failure): GraphQLError {
  return new GraphQLError(source.message, {
    extensions: { code: FAILURE_ERROR_CODE[source.kind], ...(source.details ?? {}) },
  });
}

const graphqlQueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    posts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(graphqlPostType))),
      resolve: async () => {
        const result = await getContainer().postsUseCase.list();
        if (!result.ok) throw failureToGraphQLError(result.error);
        return result.value;
      },
    },
    post: {
      type: graphqlPostType, // nullable on purpose: a well-formed id may match nothing
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_source, args: { id: string }) => {
        const result = await getContainer().postsUseCase.getById(args.id);
        if (!result.ok) throw failureToGraphQLError(result.error);
        return result.value;
      },
    },
  },
});`,
        },
      ],
    },
    {
      id: 'graphql-handler',
      title: 'A GraphQL handler in ~40 lines of Express',
      lead: 'express-graphql is deprecated; Apollo Server is one choice among several. But the protocol over HTTP is small enough that the clearest way to learn it is to serve it yourself — which is exactly what this app does, with no framework beyond Express and the reference graphql-js implementation.',
      blocks: [
        {
          kind: 'text',
          id: 'graphql-handler:protocol',
          body: `What does "GraphQL over HTTP" actually require? A POST endpoint that accepts a JSON envelope { query, variables?, operationName? }, and answers { data, errors }. The query is the SDL document string; variables are the JSON values for $placeholders in the document (never string-interpolate values into the query itself — that is how you get injection); operationName selects one document when several are sent (rare; editors batch). Producing the answer is four steps, and graphql-js gives you each as one function: PARSE the document (syntax), VALIDATE it against the schema (semantics — unknown fields, wrong argument types), EXECUTE it (walk the document, calling resolvers), and FORMAT the result. Parse and validation failures are request errors — 400 territory, the query never ran. Execution errors are NOT transport errors: the operation ran, possibly partially, so the answer is 200 with whatever data survived plus an errors array — the single most REST-reflex-violating rule in GraphQL, and the correct one.\n\nThe handler below is the whole thing, verbatim from this app. Note what is NOT there: no framework, no code generation, no decorators — and the layering from the architecture topics survives intact, because the resolvers call the same use case through the same container. Also note the divergence it documents: this endpoint speaks GraphQL's errors array instead of the app's REST envelope, because a GraphQL client parses that format — but the CODES inside extensions are still the app's own failure taxonomy (service_unavailable, validation_failed, not_found), so the vocabulary stays shared even where the dialect changes.`,
        },
        {
          kind: 'code',
          id: 'graphql-handler:verbatim',
          language: 'ts',
          caption: 'Verbatim — the entire GraphQL-over-HTTP handler (graphql_demo_routes.ts): read envelope → parse → validate → execute → answer',
          source: 'server/src/presentation/routes/graphql_demo_routes.ts',
          code: `async function graphqlController(req: Request, res: Response): Promise<void> {
  let request: ReturnType<typeof readGraphqlRequestBody>;
  try {
    request = readGraphqlRequestBody(req.body); // { query, variables?, operationName? }
  } catch (error) {                              // bad envelope: not even a document yet
    respondGraphql(res, 400, { errors: [error as GraphQLError] });
    return;
  }

  let document;
  try {
    document = parse(request.query);             // 1. syntax
  } catch (error) {
    respondGraphql(res, 400, { errors: [error as GraphQLError] });
    return;
  }

  const validationErrors = validate(graphqlDemoSchema, document); // 2. semantics
  if (validationErrors.length > 0) {
    respondGraphql(res, 400, { errors: [...validationErrors] });
    return;
  }

  const result = await execute({                 // 3. run resolvers
    schema: graphqlDemoSchema,
    document,
    ...(request.variables !== undefined && { variableValues: request.variables }),
    ...(request.operationName !== undefined && { operationName: request.operationName }),
    // contextValue is how per-request state (auth user, request id) reaches
    // every resolver without globals — the GraphQL counterpart of DI.
    contextValue: { requestId: res.locals.requestId },
  });
  respondGraphql(res, 200, result);              // 4. { data, errors } — always 200 here
}

// respondGraphql emits the wire shape: data when present (even null), errors
// when present, each error mapped to { message, locations?, path?, extensions? }.`,
        },
        {
          kind: 'text',
          id: 'graphql-handler:reality',
          body: `When would you NOT hand-roll this? When the list of concerns grows past the teaching size: uploads, persisted queries, APQ, subscriptions (websockets), federation gateways, tracing, and query-cost limiting all arrive faster in a maintained server (Apollo, GraphQL Yoga, Mercurius for Fastify, Pothos for type-safe schema building) than in your forty lines. The judgment is the usual one: the framework is buying back complexity you have verified you actually have. What hand-rolling buys you first is understanding — after this file, "GraphQL server" is no longer a black box: it is a schema object plus four functions, and every framework you will ever use is a packaging of exactly those pieces.`,
        },
      ],
    },
    {
      id: 'graphql-operations',
      title: 'Queries and mutations',
      lead: 'The client-side language is three features deep: fields and nesting, variables, and aliases/fragments. Master those and you can read almost any query in the wild.',
      blocks: [
        {
          kind: 'text',
          id: 'graphql-operations:features',
          body: `FIELDS AND NESTING are the base case — the response JSON is shaped like the query, field for field, which is why a GraphQL response is legible upside down against its request. VARIABLES decouple the document from its inputs: the query says post(id: $id), the envelope carries variables: { "id": "…" } — the same document is cacheable and reusable, and a variable's TYPE ($id: ID!) is checked against the schema exactly like an argument literal, so a wrong-typed variable is a validation error before anything runs. ALIASES rename a field in the response (newest: posts) — and, crucially, let you ask for the SAME field twice with different arguments (first: post(id: "a") second: post(id: "b")) — without aliases the keys would collide. FRAGMENTS are named, reusable field selections (fragment PostSummary on Post { id title }) spread into queries with ...PostSummary — the deduplication tool for screens that ask for the same shape in several places. MUTATIONS look like queries and return a payload you also shape — you query the mutation's RESULT, conventionally under a typed payload object (createPost(...): Post! here returns the entity directly, which is fine at this size; bigger APIs wrap it as CreatePostPayload { post, userErrors } so errors can be DATA rather than the errors array). One more convention worth knowing: mutations are serialized — the spec executes mutation root fields one at a time, in order — while QUERIES may resolve their top-level fields in parallel; do not put two writes in one query document and expect order.`,
        },
        {
          kind: 'code',
          id: 'graphql-operations:examples',
          language: 'bash',
          caption: 'Real requests against this app\'s /api/graphql — variables, aliases, and a mutation, runnable from a terminal',
          code: `# fields + nesting — the response mirrors the request shape:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"{ posts { id title author } }"}' localhost:4000/api/graphql | jq

# variables — the document stays fixed; only the values change:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"query One($id: ID!) { post(id: $id) { title body } }",
       "variables":{"id":"0f1c2b3a-0000-4000-8000-000000000002"}}' \\
  localhost:4000/api/graphql | jq

# aliases — the same field twice, differently named:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"{ newest: posts { title } }"}' localhost:4000/api/graphql | jq

# a mutation — creates through the SAME validation path as POST /api/posts,
# then the created post rides the payload you asked for:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"mutation { createPost(title: \"One endpoint, client-shaped\",
       body: \"The client asked for exactly this.\", author: \"you\") { id title createdAt } }"}' \\
  localhost:4000/api/graphql | jq
# → { "data": { "createPost": { "id": "…", "title": "One endpoint, client-shaped",
#       "createdAt": "…" } } }`,
        },
      ],
    },
    {
      id: 'graphql-errors',
      title: 'Errors',
      lead: "GraphQL moves errors out of the status line and into the payload: a top-level errors array, per-error path and locations, partial data alongside failures, and machine codes in extensions. It is the REST envelope's ideas wearing a different shape.",
      blocks: [
        {
          kind: 'text',
          id: 'graphql-errors:shape',
          body: `The wire contract: an answer may carry data AND errors at once. Each error entry has a MESSAGE (human-readable, safe to log), LOCATIONS (the line/column in the query document where the failing field sits — you can point a squiggle at it, which no REST error can do), PATH (the resolver chain — ["posts", 0, "comments"] tells you exactly which value died), and EXTENSIONS — the extension namespace where machine-readable data lives, and where the ecosystem puts CODES (GraphQL itself defines none; the community's Apollo-style convention — BAD_USER_INPUT, INTERNAL_SERVER_ERROR — is de facto). This app puts its own taxonomy's codes in extensions.code (service_unavailable, validation_failed, not_found) and merges failure details beside them (a validation error carries fields: { title: "…" } exactly like the REST envelope's detail keys).\n\nThe two reflexes to unlearn from REST: first, execution errors answer HTTP 200 — the transport succeeded; the operation's outcome is in the body (this app 400s only parse/validation failures, where the query never ran). Second, NULL PROPAGATION encodes severity: a field declared non-null that errors takes its nearest NULLABLE ancestor down with it — posts: [Post!]! failing nulls all of data (you asked for a guaranteed list; there is no honest partial answer), while post(id): Post failing nulls only data.post and the rest of the query survives. That is why nullability choices in the schema are error-design choices: every ! is a promise about what failure looks like. Compared with the REST envelope from the API design topic: same three ideas (machine code, human message, plus location/correlation), different transport — and the GraphQL shape buys field-level precision (path + locations) at the cost of the status line, which is why monitoring GraphQL needs body-aware tooling: your load balancer will show a sea of 200s.`,
        },
        {
          kind: 'code',
          id: 'graphql-errors:verbatim',
          language: 'bash',
          caption: 'Real error answers from this app — partial data, non-null propagation, and codes in extensions (inject the 503 first via PATCH /api/demo/scenario)',
          code: `# a nullable field failing: data survives, the field is null, one error entry:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"query($id: ID!) { post(id: $id) { title } posts { title } }",
       "variables":{"id":"0f1c2b3a-0000-4000-8000-00000000dead"}}' \\
  localhost:4000/api/graphql | jq
# → { "data": { "post": null, "posts": [ …still answered… ] },
#     "errors": [ { "message": "no post with id \\"…\\"",
#                   "path": ["post"],
#                   "extensions": { "code": "not_found", "postId": "…" } } ] }

# failure injection + posts: [Post!]! — the guarantee nulls ALL of data:
curl -s -X PATCH -H 'content-type: application/json' \\
  -d '{"injectFailure":true}' localhost:4000/api/demo/scenario > /dev/null
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"{ posts { id } }"}' localhost:4000/api/graphql | jq
# → { "data": null,
#     "errors": [ { "message": "Failure injection is ON — this is the demo 503",
#                   "path": ["posts"],
#                   "extensions": { "code": "service_unavailable" } } ] }

# validation from the use case — fields ride extensions like the REST envelope:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"mutation { createPost(title: \\"\\", body: \\"b\\", author: \\"a\\") { id } }"}' \\
  localhost:4000/api/graphql | jq '.errors[0].extensions'
# → { "code": "validation_failed",
#     "fields": { "title": "must be a string of 1 to 120 characters (got 0)" } }`,
        },
      ],
    },
    {
      id: 'graphql-n1',
      title: 'N+1 and batching',
      lead: "GraphQL's per-field resolvers make it trivially easy to fire one query per row. The pathology is old; the cure is batching — and our own schema shows why it doesn't always apply.",
      blocks: [
        {
          kind: 'text',
          id: 'graphql-n1:problem',
          body: `The classic: posts resolves to three Posts, and then Post.comments — a field with its own resolver — runs once PER POST, each call hitting the database. Three posts, one list query plus three comment queries: 1+N. Thirty posts on a feed page: 31 queries per request, most fetching one row's worth of context the original query could have carried. The pathology is not GraphQL's invention (the REST client firing GET /comments per post in the first section had it too) — but GraphQL makes it EFFORTLESS, because the natural way to write resolvers (each field independently fetching what it needs) multiplies calls exactly when lists get longer, and the client controls list length.\n\nThe cure is BATCHING: collect all the comments fields' requests during one execution pass, then resolve them in ONE database round trip whose WHERE IN covers every key at once. Doing that by hand is miserable (resolvers run synchronously-ish in sequence); doing it with a promise cache is the dataloader pattern, sketched below — per REQUEST (one instance per execution, not a singleton, or you leak one user's data into another's cache), LOAD returns a promise, and the loader microtask-batches every promise requested in the same tick into one batch function call. The honest note about THIS app: our resolvers do not have the problem, structurally. posts resolves the WHOLE list in one use-case call and Post's fields are default property reads — no per-entity fetching exists to multiply. N+1 enters the moment a nested field gains its own resolver that touches storage (Post.author fetching a user row, Post.comments fetching counts) — which is exactly when you reach for the pattern below rather than "optimizing" a schema that is already one query deep.`,
        },
        {
          kind: 'code',
          id: 'graphql-n1:sketch',
          language: 'ts',
          caption: 'The dataloader pattern as a real, compilable teaching exhibit (server/src/domain/teaching/exhibit_a_graphql_dataloader.ts — ~15 lines; the real dataloader package adds caching, error propagation, and scheduling polish)',
          source: 'server/src/domain/teaching/exhibit_a_graphql_dataloader.ts',
          code: `// The pattern: load() returns a promise; promises requested in the same
// tick are batched into ONE call to batchFn. In a resolver:
//   (parent) => authorLoader.load(parent.authorId)
export class Loader<K, V> {
  private queue: { key: K; resolve: (v: V) => void; reject: (e: unknown) => void }[] = [];
  private scheduled = false;

  constructor(private readonly batchFn: (keys: readonly K[]) => Promise<V[]>) {}

  load(key: K): Promise<V> {
    return new Promise((resolve, reject) => {
      this.queue.push({ key, resolve, reject });
      if (!this.scheduled) {
        // microtask boundary: collect everything this tick asked for, then flush
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const batch = this.queue; // everything the resolvers asked for…
    this.queue = [];
    this.scheduled = false;
    const values = await this.batchFn(batch.map((entry) => entry.key)); // …ONE query
    batch.forEach((entry, index) => entry.resolve(values[index]!));
  }
}

// One instance PER REQUEST (in contextValue — never a module singleton):
//   const authorLoader = new Loader((ids) =>
//     db.select('id, name').from('users').where(inArray('id', ids)));  // WHERE id IN (…)
// 3 posts → 3 load(authorId) calls → 1 SELECT … WHERE id IN (a, b, c).`,
        },
      ],
    },
    {
      id: 'graphql-introspection',
      title: 'Introspection and tooling',
      lead: "The schema is queryable through the schema itself — a self-describing system that powers every editor's autocomplete. It is also a free map of your API for attackers, which is why production disabling is a real debate with a real answer.",
      blocks: [
        {
          kind: 'text',
          id: 'graphql-introspection:system',
          body: `Introspection is a reserved, meta-fields surface (__schema, __type) the execution engine answers without your code: ask for __schema { queryType { name } } and the server describes itself — every type, field, argument, and deprecation, typed. This is not a nice-to-have: it is WHY the tooling story is uniformly good. GraphiQL and GraphQL Playground are in-browser editors that introspect your endpoint and then autocomplete field names, show inline type errors against the real schema, and one-click "docs" — the same contract powering client codegen (typed query results from .graphql files) and schema diffing in CI ("this release removed a field clients query" becomes a build failure). Point any generic GraphQL IDE at http://localhost:4000/api/graphql and it will draw this app's schema without reading our source.\n\nThe debate: an open introspection endpoint hands an attacker your complete API map — every field, every argument type — for one cheap query. The counterargument: it is reconnaissance convenience, not a vulnerability class; the fields an attacker can introspect are the fields they can already brute-force by guessing names (schemas are not guess-proof: type names like Post and User are not secrets), and security-by-obscurity buys nothing against the insider or the leaked schema file that every client build ships. The working consensus: DISABLE it on public, unauthenticated production endpoints (graphql-js: NoSchemaIntrospectionCustomRule passed to validate — one line in this app's handler would do it), KEEP it everywhere else (internal services, authenticated surfaces, every non-prod environment), and if public clients need tooling, serve them PERSISTED QUERIES instead — a registry of pre-approved documents the server only executes by hash, which simultaneously fixes introspection exposure, arbitrary-query cost abuse, and caching. This app leaves introspection ON deliberately — it is a teaching surface, and the playground below is a hand-rolled cousin of what introspection enables.`,
        },
        {
          kind: 'code',
          id: 'graphql-introspection:query',
          language: 'bash',
          caption: 'Real — ask this app\'s endpoint to describe itself (this is what the editors run on load)',
          code: `# the schema's entry points and every type they reach:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"{ __schema { queryType { name } mutationType { name } types { name kind } } }"}' \\
  localhost:4000/api/graphql | jq '.data.__schema.types'

# one type, fully: Post's fields and their types:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"{ __type(name: \\"Post\\") { fields { name type { name kind ofType { name } } } } }"}' \\
  localhost:4000/api/graphql | jq

# and the one-line switch the debate is about, in this app's handler:
#   import { specifiedRules, NoSchemaIntrospectionCustomRule } from 'graphql';
#   validate(schema, document, [...specifiedRules, NoSchemaIntrospectionCustomRule])`,
        },
      ],
    },
    {
      id: 'graphql-live',
      title: 'See it live',
      lead: 'A mini playground over the real endpoint: edit a query and variables, run them, and read the answer with data and errors rendered separately — plus the curl forms for your terminal.',
      blocks: [
        {
          kind: 'text',
          id: 'graphql-live:intro',
          body: `The playground posts to the SAME /api/graphql handler this topic walked, so everything above is reproducible in it: run the prefilled posts query, load the mutation preset (note the variables panel coming alive), then hand-edit the query to ask for more or fewer fields and watch the response mirror your edit — the client-shaped-shape claim, verified by your own hands. Break it on purpose, too: leave a brace unclosed (a 400 with a syntax error and a location you can find in the editor), rename a field that does not exist (a validation error quoting the real schema), or flip failure injection on in the REST workbench and re-run any query here — the same failure that answers 503 to REST arrives as an errors array with extensions.code service_unavailable, because both surfaces share one use case, one taxonomy, and one scenario store. The response panel separates data from errors and chips each error's code, so partial-data-plus-errors answers (query for an unknown post's field beside the healthy list) are legible at a glance.`,
        },
        {
          kind: 'code',
          id: 'graphql-live:curl',
          language: 'bash',
          caption: 'The three fastest experiments from a terminal — the happy query, the unknown-id partial answer, and the injected 503 as a GraphQL error',
          code: `# 1. the happy path:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"{ posts { id title } }"}' localhost:4000/api/graphql | jq

# 2. partial data + errors together (a nullable field failing beside a healthy one):
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"query($id: ID!) { post(id: $id) { title } posts { title } }",
       "variables":{"id":"no-such-post"}}' localhost:4000/api/graphql | jq

# 3. the injected failure, GraphQL-shaped (watch extensions.code):
curl -s -X PATCH -H 'content-type: application/json' \\
  -d '{"injectFailure":true}' localhost:4000/api/demo/scenario > /dev/null
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"query":"{ posts { id } }"}' localhost:4000/api/graphql | jq
curl -s -X PATCH -H 'content-type: application/json' \\
  -d '{"injectFailure":false}' localhost:4000/api/demo/scenario > /dev/null`,
        },
        {
          kind: 'demo',
          id: 'graphql-live:playground-demo',
          demoId: 'api:graphql-playground',
          title: 'The GraphQL playground',
          description:
            'A mini query editor over the real POST /api/graphql endpoint: editable document and variables, two presets (the posts query; the createPost mutation with variables), a RUN button, and a response panel that renders data and errors separately with extensions.code chips — syntax, validation, partial-data, and injected-503 answers all visible.',
        },
      ],
    },
  ],
};
