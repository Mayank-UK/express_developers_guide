import type { Topic } from '../types.js';

/**
 * The gRPC topic: contracts-first RPC over HTTP/2 with Protobuf — the IDL,
 * the four interaction shapes, serving and calling from Node, the error and
 * deadline model, and the codegen-vs-runtime-loading decision. Concept-first,
 * then the REAL service this app runs (presentation/grpc/: a grpc-js server
 * implementing guide.v1.PostsService over the same PostsUseCase REST and
 * GraphQL use, plus the HTTP bridge a browser needs to drive it). Snippets
 * marked verbatim are the running source; illustrative sketches say so.
 */
export const topicGrpc: Topic = {
  id: 'grpc',
  title: 'gRPC',
  subtitle:
    'Contract-first RPC with protobuf: services, streaming, and Node clients.',
  group: 'apis',
  order: 5,
  sections: [
    {
      id: 'grpc-what',
      title: 'What gRPC is',
      lead: 'gRPC is RPC with the contract in the middle: one .proto file describes the methods and messages, both sides generate code from it, and calls ride HTTP/2 with Protocol Buffers bodies. That single design choice buys performance, polyglot clients, and streaming — and costs you the browser, readability, and caching.',
      blocks: [
        {
          kind: 'text',
          id: 'grpc-what:mechanism',
          body: `THE MECHANISM, in one breath: you write an INTERFACE DEFINITION — a .proto file declaring services (the callable methods) and messages (their request/response shapes) — then a compiler turns that file into typed client and server code for your language, and calls travel as Protobuf-encoded bodies over HTTP/2. Everything else follows from those three commitments. THE CONTRACT IS THE CODE: unlike REST, where the "contract" is documentation that drifts the moment someone edits a handler, the .proto IS the interface — Go, Java, Python and Node services implement the same file, and a mismatch is a compile error, not a 3am production incident. THE WIRE IS BINARY: Protobuf serializes to compact binary (field numbers, not field names, go on the wire — a JSON body saying "title" spends 7 bytes where protobuf spends 1 for the tag), and it is typed, so a 64-bit integer stays 64 bits end to end instead of flirting with JavaScript number precision. THE TRANSPORT IS HTTP/2: one TCP connection carries many concurrent calls as STREAMS (multiplexing — no head-of-line queue of separate HTTP/1.1 connections), and streams are first-class, which is what makes STREAMING a native RPC shape rather than a hack bolted onto request/response.\n\nWHERE IT WINS: INTERNAL service-to-service calls inside a company or a microservices perimeter — both ends controlled by people who talk to each other, latency and strict typing compound across hundreds of calls, and nothing public needs to understand the traffic. POLYGLOT environments — the .proto generates Go server + Node client + Python jobs with no per-language negotiation. HEAVY or HOT traffic — the binary encoding and connection reuse genuinely matter at scale. STREAMING workloads — subscriptions, chat, telemetry, long computations that push progress. WHERE REST STILL FITS anything the PUBLIC internet or third parties consume: a REST API is debuggable with curl, cacheable by shared infrastructure, and guessable by anyone with the JSON in front of them; a gRPC endpoint is none of those without extra tooling. AND GRAPHQL keeps the seat it earned in its own topic — when the CLIENT needs to shape the response (frontend teams, mobile apps trimming payloads), GraphQL's per-query shape beats both fixed REST representations and fixed proto messages. The mature answer inside one system is often all three: gRPC between your services, REST for your public surface, GraphQL for your product clients — this app runs the teaching version of that with the same PostsUseCase behind REST routes, a GraphQL endpoint, and the gRPC service this topic builds.`,
        },
        {
          kind: 'code',
          id: 'grpc-what:comparison',
          language: 'txt',
          caption: 'The same "list the posts" call, three ways — this app serves all three over ONE use case',
          code: `REST (HTTP/1.1, JSON)              GraphQL (HTTP/1.1, JSON)         gRPC (HTTP/2, Protobuf)
----------------------------------  --------------------------------  ------------------------------
GET /api/posts                      POST /api/graphql                stub.ListPosts({}, {deadline})
→ 200 [{id,title,body,…},…]         body { query: '{ posts {         → PostsList { posts: […] }
headers: text/json                    id title } }' }                binary frames on one h2 conn
cacheable, curl-able, public        response shaped BY THE CLIENT    typed stub from posts.proto
contract = documentation            contract = the schema           contract = the .proto FILE
                                    (introspectable)                 (compiled/codegen'd)

this app:  GET /api/posts           POST /api/graphql                127.0.0.1:50051
           posts_routes.ts          graphql_demo_routes.ts           guide.v1.PostsService
                                        \\    |    /
                                         \\   |   /  all three delegate to
                                          postsUseCase (di/container.ts)
fake/live data + failure injection apply identically to all three surfaces`,
        },
      ],
    },
    {
      id: 'grpc-idl',
      title: 'The IDL: writing a .proto',
      lead: 'A proto file is small, declarative, and ruthlessly boring — and two rules keep it boring forever: field numbers are the contract, and packages version the service. Here is this app\'s real one, in full.',
      blocks: [
        {
          kind: 'text',
          id: 'grpc-idl:rules',
          body: `READ THE FILE BELOW LIKE A CHECKLIST. SYNTAX: proto3 (the dialect everything current speaks; proto2 is legacy). PACKAGE guide.v1 — a namespace that becomes the SERVICE'S FULL NAME (guide.v1.PostsService on the wire) and, versioned in the name, the industry's compat story: a breaking v2 ships as guide.v2 BESIDE v1, and old clients keep working against the old service. MESSAGES are just typed bags: scalars (string, int64, bool…), repeated fields (our posts list), nested messages, maps, oneofs. Every field has a NUMBER, and THE NUMBERS ARE THE CONTRACT: the name is documentation, the number is what actually goes on the wire — reusing number 3 for a different field after deleting body silently corrupts every old client's parses, so numbers of deleted fields are retired, never recycled (proto3 has no required, and unset fields simply cost zero bytes). THE SERVICE block is the interface: each rpc names a method, its request message, and its response message — ListPosts, GetPost, CreatePost here, the same three operations the REST routes expose, because the contract is the same business capability wearing a different dialect. COMMENTS ride along into generated code and documentation, which is why the file below explains its own compatibility rules where they matter.`,
        },
        {
          kind: 'code',
          id: 'grpc-idl:proto-verbatim',
          language: 'proto',
          caption: 'Verbatim — server/src/presentation/grpc/posts.proto, the entire contract this topic serves (the status endpoint below serves this same text)',
          source: 'server/src/presentation/grpc/posts.proto',
          code: `syntax = "proto3";

// The guide's one and only gRPC contract: three unary rpcs over the SAME
// PostsUseCase the REST and GraphQL surfaces call. The package name carries
// the API identity plus a version (guide.v1) so a future breaking contract
// can live beside this one as guide.v2 without disturbing v1 clients.

package guide.v1;

// A post as it crosses the wire. The field NUMBERS are the contract; the
// names are documentation. Never renumber a field and never reuse the number
// of a field you removed — that is the whole compatibility story of proto3.
message PostMessage {
  string id = 1;
  string title = 2;
  string body = 3;
  string author = 4;
  string created_at = 5;  // ISO 8601 string; a bigger schema would use Timestamp
  string updated_at = 6;
}

// Empty request messages are idiomatic: "list everything" takes no arguments,
// and an empty message leaves room to add optional filters later.
message ListPostsRequest {}

message PostsList {
  repeated PostMessage posts = 1;
}

message GetPostRequest {
  string id = 1;
}

message CreatePostInput {
  string title = 1;
  string body = 2;
  string author = 3;
}

service PostsService {
  rpc ListPosts (ListPostsRequest) returns (PostsList);
  rpc GetPost (GetPostRequest) returns (PostMessage);
  rpc CreatePost (CreatePostInput) returns (PostMessage);
}`,
        },
      ],
    },
    {
      id: 'grpc-streaming',
      title: 'Four kinds of streaming',
      lead: 'gRPC methods are streams wearing one of four shapes. This app\'s three rpcs are all UNARY — but knowing the other three shapes is knowing when gRPC stops being "faster REST" and becomes something REST cannot express.',
      blocks: [
        {
          kind: 'text',
          id: 'grpc-streaming:shapes',
          body: `UNARY is the shape you already know: one request message in, one response message out, exactly a function call over the network — every rpc in this app's PostsService is unary, and that is the correct first instinct: most operations ARE request/response, and unary gRPC already beats REST on encoding and multiplexing without a single streaming thought. SERVER-STREAMING (returns (stream PostsList)) sends ONE request and gets a SEQUENCE of messages back over one long-lived stream — the natural fit for watching a collection (feed the client post after post as the query walks), subscriptions with an initial state, tailing logs, or chunking a big result that would otherwise materialize in memory. CLIENT-STREAMING (takes (stream CreatePostInput)) inverts it: the client sends a SEQUENCE and gets ONE summary answer — file uploads chunk by chunk, telemetry/sensor batches, bulk imports where the server acks a total at the end. BIDIRECTIONAL STREAMING (both sides stream) opens a pipe where EITHER side pushes whenever it has something — chat, collaborative editing, multiplayer state, "client sends commands while server pushes events about them". On the wire all four are the same HTTP/2 DATA frames; the proto keyword just fixes WHO sends how many messages, and the generated code hands you async iterables/callbacks instead of a single promise.\n\nTHE DISCIPLINE that comes with the power: a stream is a LONG-LIVED call, so the failure questions change shape — "what happens if the client dies mid-stream?" (HTTP/2 RST_STREAM, and your handler should notice), "how long may this stream stay open?" (proxies and load balancers have idle timeouts; heartbeats exist for a reason), "what is the unit of retry?" (unary retries are free; resuming a stream needs application-level checkpoints — resending everything is usually wrong). The honest guidance: reach for streaming when the DOMAIN is actually a sequence (progress, subscriptions, continuous data), not because a response is large (pagination and Range requests often serve better), and keep the unary version of a streaming API around for simple clients — gRPC itself did exactly that with its own reflection and health services.`,
        },
        {
          kind: 'code',
          id: 'grpc-streaming:sketch',
          language: 'proto',
          caption: 'The real unary service (verbatim, posts.proto) with the streaming shapes it would grow sketched in the comments — the syntax for each kind',
          source: 'server/src/presentation/grpc/posts.proto',
          code: `service PostsService {
  // what this app really serves — one in, one out:
  rpc ListPosts (ListPostsRequest) returns (PostsList);
  rpc GetPost (GetPostRequest) returns (PostMessage);
  rpc CreatePost (CreatePostInput) returns (PostMessage);

  // server-streaming — one request, a SEQUENCE of answers (watch a feed):
  //   rpc WatchPosts (ListPostsRequest) returns (stream PostMessage);

  // client-streaming — a sequence of requests, ONE summary answer (bulk import):
  //   rpc ImportPosts (stream CreatePostInput) returns (ImportSummary);

  // bidirectional — both sides send whenever they have something (live sync):
  //   rpc SyncPosts (stream PostMessage) returns (stream PostMessage);
}

// In a Node handler the difference is just the call signature you implement:
//   unary:          (call, callback) => void          — call.request, answer once
//   server-stream:  (call) => { call.write(…); call.end(); }
//   client-stream:  (call, callback) => { call.on('data', …); call.on('end', () => callback(…)); }
//   bidi:           (call) => { call.on('data', …); call.write(…); }`,
        },
      ],
    },
    {
      id: 'grpc-serving',
      title: 'Serving gRPC from Node',
      lead: 'The server is one hundred honest lines: load the proto, implement each rpc as a thin handler over the use case, bind a port. The interesting decision is hiding in plain sight — the port is a SECOND one, because your Express app and your gRPC service speak different HTTPs.',
      blocks: [
        {
          kind: 'text',
          id: 'grpc-serving:bootstrap',
          body: `THE BOOTSTRAP: grpc-js's Server takes a SERVICE DEFINITION (the parsed proto's method table) plus an IMPLEMENTATION object — one function per rpc — then bindAsync assigns the port and tryShutdown drains it later (both used verbatim below). THE HANDLERS follow the thin-controller rule this app enforces everywhere: parse nothing (the proto already did — call.request arrives as a decoded object), delegate to the USE CASE via the container, map the Result to either a response message or a gRPC error. That last mapping is where this app's architecture pays off a third time: PostsUseCase does not know it is being called by gRPC today, exactly as it did not know about GraphQL — the dependency arrow points the same way, and fake/live data plus failure injection work through this surface for free.\n\nWHY A SECOND PORT: the Express app speaks HTTP/1.1 cleartext; gRPC REQUIRES HTTP/2 framing end to end. Node cannot honestly serve "HTTP/1.1 with JSON bodies" and "HTTP/2 with protobuf frames" on the same listener, so one process runs two listeners — :4000 stays the HTTP/1.1 guide (REST, GraphQL, the content API), and :50051 (GRPC_PORT, from the same validated app_config) speaks HTTP/2 for guide.v1.PostsService. The credentials argument in bindAsync is where TRANSPORT SECURITY lives: this teaching server uses ServerCredentials.createInsecure() — plaintext HTTP/2, fine on localhost and INSIDE a trusted network segment, and the honest note is that production gRPC uses TLS with ALPN (the same negotiation that gives browsers h2); the plaintext variant you would meet in container meshes is called h2c, and it survives only where the perimeter is already trusted. THE LIFECYCLE follows the app's graceful-shutdown discipline: server.ts starts the gRPC listener AFTER the HTTP one (so an Express port error wins), treats a bind failure as DEGRADED not fatal (the guide keeps serving; the demo bridge lazily starts an ephemeral replacement), and shutdown() stops gRPC first, then HTTP — the same finish-in-flight-then-exit contract with the same 10s force-exit safety net.`,
        },
        {
          kind: 'code',
          id: 'grpc-serving:verbatim',
          language: 'ts',
          caption: 'Verbatim — the real server bootstrap (presentation/grpc/grpc_server.ts); its place in server.ts\'s lifecycle quoted in the comments',
          source: 'server/src/presentation/grpc/grpc_server.ts',
          code: `// One handler, in full — the thin-controller pattern, gRPC edition:
// the proto parsed the input, the use case owns the rules, this maps the Result.
const getPostHandler: handleUnaryCall<{ id?: unknown }, GrpcPostMessage> = async (call, callback) => {
  await answerWith(callback, async () => {
    const result = await getContainer().postsUseCase.getById(call.request.id);
    return result.ok ? { ok: true as const, value: postToMessage(result.value) } : result;
  });
};

// The bootstrap: definition + implementations + a bind. Note the SECOND port —
// gRPC needs HTTP/2, Express here speaks HTTP/1.1, so the process runs both.
export async function startGrpcServer(port: number): Promise<GrpcServerHandle> {
  if (running !== undefined) return running;          // one instance per process

  const server = new Server();
  server.addService(POSTS_SERVICE_DEFINITION, {
    ListPosts: listPostsHandler,
    GetPost: getPostHandler,
    CreatePost: createPostHandler,
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    // createInsecure = plaintext HTTP/2 — local teaching only; production
    // uses TLS (ALPN negotiates h2), h2c only inside a trusted perimeter.
    server.bindAsync(\`127.0.0.1:\${port}\`, ServerCredentials.createInsecure(), (err, bound) => {
      if (err !== undefined && err !== null) reject(err);
      else resolve(bound);                            // port 0 → the OS assigns one
    });
  });
  /* …wrap boundPort + tryShutdown into the handle, memoize, return… */
}

// And in server.ts — gRPC starts AFTER HTTP listens, degrades instead of
// crashing, and shutdown() drains it FIRST:
//   const grpcServerPromise: Promise<GrpcServerHandle | null> = startGrpcServer(appConfig.grpcPort)
//     .then((handle) => { logger.info({ grpcPort: handle.port }, 'grpc demo service started'); return handle; })
//     .catch((err: Error) => {
//       logger.error({ err, grpcPort: appConfig.grpcPort },
//         'grpc server failed to start — the HTTP guide keeps serving; the demo bridge will retry on an ephemeral port');
//       return null;
//     });`,
        },
      ],
    },
    {
      id: 'grpc-calling',
      title: 'Calling gRPC from Node',
      lead: 'A gRPC client is the contract compiled into a stub: credentials, a target, a deadline, a callback. And because browsers cannot speak native gRPC, this app adds the pattern every gRPC-serving backend eventually grows — a small HTTP bridge that relays browser instructions to real gRPC calls.',
      blocks: [
        {
          kind: 'text',
          id: 'grpc-calling:client',
          body: `THE CLIENT ANATOMY, start to finish: a TARGET ("127.0.0.1:50051" — host and port of the service), CHANNEL CREDENTIALS (createInsecure() here, TLS in production — the same channel carries every call, multiplexed), the STUB (the service definition shaped into callable methods — rpc ListPosts becomes stub.ListPosts), and CALL OPTIONS of which DEADLINE is the one you must never skip: an absolute timestamp after which the call gives up (the error section below shows what expires look like). The call itself is a one-liner — payload in, callback out — and in-process that is ALL you need: the demo's invoke bridge creates a client, fires the rpc with a 2-second deadline, relays the outcome, closes the client.\n\nTHE BROWSER PROBLEM, stated honestly: the demo console below runs in YOUR browser, and browsers do not expose HTTP/2 framing the way gRPC needs — fetch() cannot speak the gRPC wire protocol (no access to trailers, no way to frame protobuf over the stream with the required semantics). Teams solve this with grpc-web plus a translating PROXY (Envoy in front of the service, translating the browser's grpc-web dialect to real gRPC) — infrastructure this guide deliberately does not require. THE PATTERN THIS APP USES instead is the one backend teams reach for when one browser feature needs one gRPC call: an HTTP BRIDGE. The browser POSTs a plain JSON instruction — { method: 'ListPosts', payload: {} } — to /api/demo/grpc/invoke; the bridge runs a REAL grpc-js client call in-process against the running service; the outcome comes back as JSON. The trip the demo renders is therefore: browser → ordinary HTTP → bridge → real gRPC call over HTTP/2 → the same PostsUseCase the REST routes call. Note what the bridge does NOT do: translate the whole service generically — it relays three known methods, validates the instruction is one of them (a 400 only for malformed instructions), and STAYS a teaching-sized seam. If a product grows past a few calls, the honest next step is grpc-web + Envoy, not a growing bridge.`,
        },
        {
          kind: 'code',
          id: 'grpc-calling:verbatim',
          language: 'ts',
          caption: 'Verbatim — the bridge\'s real client call (grpc_demo_routes.ts): target, insecure local credentials, a deadline, the relay',
          source: 'server/src/presentation/routes/grpc_demo_routes.ts',
          code: `// The bridge's whole client ceremony — this IS the "calling gRPC from
// Node" lesson, in production clothing:
const server = await ensureBridgeServer();            // the running handle, or a lazy port-0 one
const client = createPostsServiceClient(server.port); // new PostsServiceClient(target, createInsecure())
try {
  const outcome = await new Promise<{ error: GrpcClientError | null; response?: unknown }>(
    (resolve) => {
      client.stub[instruction.method](               // rpc → stub method, typed by the proto
        instruction.payload,                          // the request message as plain JSON-ish object
        { deadline: Date.now() + BRIDGE_DEADLINE_MS },// 2s: a hung rpc must not hang the tab
        (error, response) => resolve({ error, response }),
      );
    },
  );
  // relay: OK → { status: 'OK', response }; a gRPC error → its status code,
  // message and trailer facts (next section) — always HTTP 200, because
  // observing a failed call IS the successful outcome of an invoke.
} finally {
  client.close();                                     // one client per call, nothing left open
}`,
        },
      ],
    },
    {
      id: 'grpc-errors',
      title: 'Errors and deadlines',
      lead: 'gRPC replaces HTTP status codes with its own small, honest ladder of seventeen, and makes the deadline a first-class part of every call. This app\'s one Failure taxonomy maps onto that ladder in a single exhaustive table.',
      blocks: [
        {
          kind: 'text',
          id: 'grpc-errors:codes',
          body: `STATUS CODES: every gRPC call ends in a status — OK (0) or one of the seventeen error codes; the ones you will actually live in are INVALID_ARGUMENT (3 — the caller's fault, fix the request), NOT_FOUND (5), ALREADY_EXISTS (6), PERMISSION_DENIED (7 — authenticated but not allowed), RESOURCE_EXHAUSTED (8 — quota, throttling), FAILED_PRECONDITION (9 — right request, wrong state), UNAVAILABLE (14 — the service cannot answer NOW; retrying later is reasonable), UNAUTHENTICATED (16 — prove who you are first), INTERNAL (13 — the server's bug) and DEADLINE_EXCEEDED (4 — the call outlived its deadline). THE MAPPING DISCIPLINE is this app's whole error story in miniature: the domain speaks Failure kinds, and each SURFACE translates — failures.ts already owns failure-kind → HTTP status for REST (and → extensions.code for GraphQL); the gRPC server adds the third column, kind → gRPC status, in ONE exhaustive table (a new FailureKind fails to compile until it picks a status). Note the translations are not one-to-one with HTTP: validation 400 becomes INVALID_ARGUMENT, 404 becomes NOT_FOUND, 409 conflict becomes ALREADY_EXISTS, 429 rate_limited becomes RESOURCE_EXHAUSTED, 503 unavailable stays UNAVAILABLE — same meanings, different dialects, and UNAVAILABLE-vs-INTERNAL is the one worth internalizing early: UNAVAILABLE tells the client "try again later"; INTERNAL tells you "read the server logs".\n\nERRORS ON THE WIRE are deliberately spartan: a code, a short MESSAGE (human text), and TRAILERS — metadata sent after the body, which is where structured error context rides (gRPC's own richer mechanism, status-details-bin, packs protobuf into a trailer). This app puts the human message in the status message and its own failure-kind/error-code facts in two trailer keys — a raw client sees "5 NOT_FOUND: no post with id …" AND can read that it was failure kind not_found. DEADLINES: every call carries an ABSOLUTE expiry timestamp (Date.now() + budget), and when it passes the call fails with DEADLINE_EXCEEDED wherever it happens to be sitting — in the queue, mid-serialization, waiting on your database. The two habits that make deadlines real: SET THEM ALWAYS (a call without a deadline is a call that can hang forever, and the bridge's 2s budget is the in-file example), and know that the deadline PROPAGATES only if you forward it — service A calling service B should subtract its remaining time, or a fast-failing front door can sit behind a slow hallway (metadata key grpc-timeout travels the wire for exactly this). CANCELLATION is the client-side sibling: context.cancel() (or closing the client) ends the call early — the same mechanism a browser tab close or a load balancer reset triggers — and a well-behaved handler checks call.cancelled before doing expensive work.`,
        },
        {
          kind: 'code',
          id: 'grpc-errors:verbatim',
          language: 'ts',
          caption: 'Verbatim — this app\'s third error translation table and the wire-facts function (presentation/grpc/grpc_server.ts)',
          source: 'server/src/presentation/grpc/grpc_server.ts',
          code: `// The gRPC counterpart of FAILURE_HTTP_STATUS — exhaustive over the one
// taxonomy, so a new FailureKind must pick a status here to compile:
export const FAILURE_GRPC_STATUS: Readonly<Record<FailureKind, number>> = {
  validation: status.INVALID_ARGUMENT, // 3  — REST's 400
  unauthorized: status.UNAUTHENTICATED, // 16 — REST's 401
  forbidden: status.PERMISSION_DENIED, // 7  — REST's 403
  not_found: status.NOT_FOUND, // 5  — REST's 404
  conflict: status.ALREADY_EXISTS, // 6  — REST's 409
  rate_limited: status.RESOURCE_EXHAUSTED, // 8  — REST's 429
  unavailable: status.UNAVAILABLE, // 14 — REST's 503
  internal: status.INTERNAL, // 13 — REST's 500
};

// How a Failure crosses the wire: grpc-js sends error.details (when present)
// as the status MESSAGE — so the human text goes there — while this app's
// own facts ride the TRAILERS (the metadata channel after the body):
export function failureToGrpcError(source: Failure): GrpcStatusError {
  const error = new Error(source.message) as GrpcStatusError;
  error.code = FAILURE_GRPC_STATUS[source.kind];
  error.details = source.message;
  const metadata = new Metadata();
  metadata.add('x-failure-kind', source.kind);
  metadata.add('x-error-code', FAILURE_ERROR_CODE[source.kind]);
  error.metadata = metadata;
  return error;
}
// A raw client then reports:  5 NOT_FOUND: no post with id "post_0000"
//                      plus trailers x-failure-kind: not_found
// The demo bridge reads those trailers back out and shows { kind, errorCode }.`,
        },
      ],
    },
    {
      id: 'grpc-codegen',
      title: 'Codegen vs runtime loading',
      lead: 'Everything above needs the .proto turned into callable code, and there are exactly two ways: compile it ahead of time, or load it at runtime. This app picks runtime loading — and the tradeoff is worth making consciously, because production teams usually pick the other one.',
      blocks: [
        {
          kind: 'text',
          id: 'grpc-codegen:tradeoff',
          body: `RUNTIME LOADING (what this app does): @grpc/proto-loader parses the .proto AT PROCESS START and hands grpc-js a dynamic service definition — no build step, no generated files to commit, one dependency pair (@grpc/grpc-js + @grpc/proto-loader), and the contract stays a readable text file beside the code. The costs are exactly what you would expect from "types at runtime only": NO TypeScript types for messages or stubs (this app's bridge casts the client through a small structural type — one honest line where a generated client would have full types), slower startup (proto parsing at boot — milliseconds here, measurable with hundreds of protos), and the canonical options to keep straight (keepCase decides whether created_at arrives as createdAt; longs/enums as String keep values JSON-safe without a Long library). CODEGEN (the production default): protoc (or the friendlier ts-proto / grpc-tools plugins) compiles the .proto into .ts/.js ahead of time — messages become interfaces, services become typed client CLASSES and server interfaces, a typo'd field is a COMPILE error not a 3am surprise, and there is no runtime parsing at all. The costs: a build step wired into CI and Docker, generated artifacts committed or regenerated deterministically, and the discipline of regenerating on every proto change (a stale generated file is the codegen world's own drift bug).\n\nTHE HONEST GUIDANCE: this guide chooses runtime loading because its goal is a codebase you can read top to bottom with zero toolchain ceremony — the proto, the server, and the bridge are all plain source you have now read. A production service with many consumers should choose codegen for the typing alone: the moment a second team consumes your contract, compile-time enforcement of that contract is the entire value proposition of gRPC over documented REST, and codegen is where that enforcement lives. The two worlds interoperate freely — a runtime-loading server speaks to codegen'd clients and vice versa (the wire contract is the .proto, not the toolchain) — so the choice is per-repository, not per-system. The one thing NOT to do is drift into the middle: hand-rolled fetch-to-gRPC wrappers per endpoint deserve to be replaced by one of the two real paths.`,
        },
        {
          kind: 'code',
          id: 'grpc-codegen:both-ways',
          language: 'ts',
          caption: 'Runtime loading as this app really does it (posts_proto.ts), then the codegen equivalent you would write in a typed production repo (illustrative)',
          source: 'server/src/presentation/grpc/posts_proto.ts',
          code: `// RUNTIME LOADING — verbatim from posts_proto.ts: parse at boot, cast once.
const LOADER_OPTIONS = {
  keepCase: false, // posts.proto's created_at arrives as createdAt
  longs: String,   // no Long library — values stay JSON-safe
  enums: String,
  defaults: true,  // unset proto3 fields come back as their zero values
  oneofs: true,
} as const;

const packageDefinition = loadSync(stageProtoFile(), LOADER_OPTIONS);
const loaded = loadPackageDefinition(packageDefinition) as unknown as {
  guide: { v1: { PostsService: LoadedPostsService } };   // dotted packages NEST
};
// …and the bridge's one honest cast (no generated types):
//   const client = new postsService(target, credentials.createInsecure());
//   stub = client as unknown as PostsServiceStub;

// CODEGEN — illustrative, what the same call looks like after protoc/ts-proto
// generates guide/v1/posts_pb.ts + posts_grpc_pb.ts from the SAME .proto:
//
//   import { PostsServiceClient } from './guide/v1/posts_grpc_pb';
//   import { ListPostsRequest } from './guide/v1/posts_pb';
//
//   const client = new PostsServiceClient('127.0.0.1:50051',
//     credentials.createInsecure());
//   const request = new ListPostsRequest();        // typed message class
//   client.listPosts(request, { deadline: … },     // typed method, typed options
//     (err, response) => {                          // response: PostsList
//       response.getPostsList().map((post) => post.getTitle());  // typed getters
//     });
//
// Same .proto, same wire bytes — the difference is WHEN the contract became
// code: at boot (loader) vs at build (codegen).`,
        },
      ],
    },
    {
      id: 'grpc-live',
      title: 'See it live',
      lead: 'A real gRPC console: the browser picks a method and payload, an HTTP bridge relays the instruction as a real grpc-js call, and the outcome — OK or a status code with its message — comes back exactly as a gRPC client would see it.',
      blocks: [
        {
          kind: 'text',
          id: 'grpc-live:intro',
          body: `The console below drives the REAL guide.v1.PostsService this topic built. The STATUS PANEL reports whether the gRPC listener is running and on which port, lists the three rpcs with their full wire paths, and shows the proto source itself — the exact text the server loaded at runtime, byte-identical to posts.proto in the repository. Pick a method: LISTPOSTS sends the empty request and renders the PostsList message (the seeded posts, camelCase fields — watch created_at become createdAt, the loader's keepCase conversion you read about); GETPOST takes an id (copy one from a ListPosts response first — the prefilled placeholder id will come back NOT_FOUND, which is itself the demo); CREATEPOST takes title/body/author and mints a post through the same use-case validation REST and GraphQL use. The INVOKE button runs browser → HTTP bridge → real gRPC call over HTTP/2 → PostsUseCase, and the result panel shows the gRPC status as a chip — OK in green, error codes in red — with the message and, for failures, the app's failure-kind read back out of the trailers. Turn on failure injection in the REST workbench topic first and every invoke here answers UNAVAILABLE — the same scenario switch, proving the surfaces share one spine. The curl block below plays the same calls from a terminal, no browser involved.`,
        },
        {
          kind: 'demo',
          id: 'grpc-live:console-demo',
          demoId: 'api:grpc-console',
          title: 'The gRPC console',
          description:
            'Invoke guide.v1.PostsService from the browser: pick ListPosts / GetPost / CreatePost, edit the JSON payload, and watch the real gRPC outcome — status chip (OK green, error codes red), the response message, and failure kinds read back from the trailers. The trip is browser → HTTP bridge → real gRPC over HTTP/2 → the same posts use case.',
        },
        {
          kind: 'code',
          id: 'grpc-live:curl',
          language: 'bash',
          caption: 'The same console, from a terminal — the bridge relays to the real service (or grpcurl posts.proto directly against :50051)',
          code: `# boot the guide (HTTP on :4000, gRPC on :50051), then:

# 1. the contract, served verbatim from the running server:
curl -s localhost:4000/api/demo/grpc/status | jq '{running, port, service}'

# 2. a unary call through the bridge — the seeded posts, camelCase fields:
curl -s -X POST localhost:4000/api/demo/grpc/invoke \\
  -H 'content-type: application/json' \\
  -d '{"method":"ListPosts"}' | jq '.status, .response.posts[0].createdAt'

# 3. the dark path — a well-formed id that matches nothing:
curl -s -X POST localhost:4000/api/demo/grpc/invoke \\
  -H 'content-type: application/json' \\
  -d '{"method":"GetPost","payload":{"id":"post_0000"}}' | jq '{status, code, message, failure}'

# 4. create through gRPC, then see it listed:
curl -s -X POST localhost:4000/api/demo/grpc/invoke \\
  -H 'content-type: application/json' \\
  -d '{"method":"CreatePost","payload":{"title":"Over HTTP/2","body":"via the bridge","author":"curl"}}' \\
  | jq '.response.id'

# against the gRPC listener directly (needs grpcurl + the proto file):
#   grpcurl -plaintext -proto server/src/presentation/grpc/posts.proto \\
#     -d '{}' 127.0.0.1:50051 guide.v1.PostsService/ListPosts`,
        },
      ],
    },
  ],
};
