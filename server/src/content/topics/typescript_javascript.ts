import type { Topic } from '../types.js';

/**
 * The language-layer topic: the TypeScript and JavaScript a backend developer
 * actually uses daily. Code samples are the real patterns running in this
 * repo's server/ package (tsconfig, Result, guards, controllers, ESM imports);
 * distilled snippets are marked illustrative in their captions.
 */
export const topicTypescriptJavascript: Topic = {
  id: 'typescript-javascript',
  title: 'TypeScript and JavaScript Fundamentals',
  subtitle:
    'The language layer every Express server is written in: types, modules, and the runtime gaps TypeScript fills.',
  group: 'fundamentals',
  order: 1,
  sections: [
    {
      id: 'ts-why',
      title: 'Why TypeScript on the server',
      lead: 'JavaScript checks types while the request is already in flight. TypeScript moves that check to before the process ever boots.',
      blocks: [
        {
          kind: 'text',
          id: 'ts-why:concept',
          body: `Concept first: JavaScript is dynamically typed — every type check happens at runtime, at the moment the code runs. For a server that means while a real request is sitting inside your process, halfway through a response. A mistyped property name, a missing null check, a function called with arguments in the wrong order: in JavaScript those are all runtime errors, discovered by a client or by whoever is on call.\n\nTypeScript adds a compile-time layer on top. You describe the shapes of your values; the compiler proves that every file in the program agrees with those descriptions before anything ships. The descriptions themselves are erased — Node never executes a single type annotation — but the proof already happened. That is the whole trade: a typecheck step in your build, in exchange for a class of bugs becoming impossible to deploy instead of possible to hit in production.`,
        },
        {
          kind: 'code',
          id: 'ts-why:strict',
          language: 'ts',
          caption: 'server/tsconfig.json — the switch that matters, from this repo config',
          source: 'server/tsconfig.json',
          code: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",  // real ES modules; .js import specifiers (see the modules section)
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,        // the master switch — non-negotiable for server code
    // strict turns on the checks that catch real outages, among them:
    //   strictNullChecks           -> null and undefined become distinct types
    //   noImplicitAny              -> unannotated values can't silently be any
    //   useUnknownInCatchVariables -> caught errors start as unknown, not any
    // (esModuleInterop, skipLibCheck, forceConsistentCasingInFileNames omitted)
  },
  // "include": ["src"] omitted
}`,
        },
        {
          kind: 'text',
          id: 'ts-why:payoff',
          body: `On a server, strict pays off exactly where mistakes are most expensive. strictNullChecks forces every value that can be absent to say so — the null check you forgot becomes a compile error at your desk instead of a stack trace mid-request. noImplicitAny stops an untyped value from silently infecting everything it touches. And because the compiler sees the whole program, a refactor — renaming a DTO field, changing a use case signature — lists every call site that must change, across every layer.\n\nOne boundary matters more than all of this, and it gets its own section at the end of this topic: TypeScript proves things at compile time. At runtime, when JSON arrives from a network client, none of those types exist anymore. Hold that thought.`,
        },
      ],
    },
    {
      id: 'ts-types',
      title: 'Types you will actually use',
      lead: 'The day-to-day toolkit is small: interfaces and aliases, unions with narrowing, literal types, generics, readonly, optional vs nullable.',
      blocks: [
        {
          kind: 'text',
          id: 'ts-types:concept',
          body: `Concept first: you need fewer type tools than you think. Nearly all of this repository is written with six: interfaces and type aliases for shapes; unions with narrowing for values that can legally be more than one thing; literal types for closed sets of options; generics for code that works the same over many shapes; readonly to promise not to mutate; and the distinction between optional (a field may be absent) and nullable (a field is present but null) — different conditions that cause real bugs when conflated.\n\nThe showcase is this repo's Result — the value every use case in the domain layer returns. It is a union of two object shapes, discriminated by a literal boolean, generic over the success and failure types:`,
        },
        {
          kind: 'code',
          id: 'ts-types:result',
          language: 'ts',
          caption: 'server/src/core/result/result.ts — verbatim, the most-used generic in this repo',
          source: 'server/src/core/result/result.ts',
          code: `export type Result<T, E extends Failure = Failure> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<E extends Failure>(error: E): Result<never, E> {
  return { ok: false, error };
}`,
        },
        {
          kind: 'text',
          id: 'ts-types:narrowing',
          body: `Read the union the way the compiler does: a Result is either { ok: true, value: T } or { ok: false, error: E } — never both, never neither. The literal types true and false are the discriminant. After an if (result.ok) check, TypeScript knows which shape it is holding: result.value exists and is a T, and result.error does not exist at all — referencing it is a compile error. That move — test a discriminant, shrink the union — is called narrowing, and it is the single highest-value habit in TypeScript. You will meet it again in runtime form in the next section.\n\nThe generics are doing quiet work: T says the success shape is decided by the caller. The same Result definition carries a Post from one use case and a health snapshot from another, and ok()/fail() even narrow it — Result<T, never> is a Result that provably cannot fail, so error-handling code for it gets flagged.`,
        },
        {
          kind: 'code',
          id: 'ts-types:map',
          language: 'ts',
          caption: 'server/src/core/result/result.ts — verbatim; generics keep helpers shape-agnostic',
          source: 'server/src/core/result/result.ts',
          code: `/** Transforms the success value, passing failures through untouched. */
export function mapResult<T, U, E extends Failure>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Returns the success value, or a fallback when the result is a failure. */
export function unwrapOr<T, E extends Failure>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}`,
        },
        {
          kind: 'text',
          id: 'ts-types:readonly-optional',
          body: `The smaller tools earn their keep in one-liners. A literal union like 'fake' | 'live' makes the scenario's dataMode a two-value type — any other string is a compile error, and after a comparison the value narrows to exactly one of the two. A field marked readonly may not be reassigned by any consumer, which is how shared state defends itself. Optional and nullable are different things: { title?: string } may omit title entirely; { title: string | null } must have it, possibly as null.\n\nThis repo puts several of those together in one real line — the demo routes build a mutable patch object out of the readonly scenario-state type:`,
        },
        {
          kind: 'code',
          id: 'ts-types:readonly',
          language: 'ts',
          caption: 'server/src/presentation/routes/demo_routes.ts — verbatim',
          source: 'server/src/presentation/routes/demo_routes.ts',
          code: `// Mutable mirror of Partial<ScenarioState> — the interface's readonly
// modifiers apply to consumers, not to the code assembling the patch.
const patch: { -readonly [K in keyof ScenarioState]?: ScenarioState[K] } = {};`,
        },
        {
          kind: 'text',
          id: 'ts-types:mapped',
          body: `Unpack it: keyof ScenarioState is the union of field names; the mapped type walks that union; -readonly strips the readonly modifier and the trailing ? makes each field optional; ScenarioState[K] looks up each field's own type — an indexed access. Mapped types are the advanced end of the language and you will not write them daily, but knowing the compiler can compute types from other types is what keeps large type definitions DRY.`,
        },
      ],
    },
    {
      id: 'ts-any-unknown',
      title: 'any, unknown, and type guards',
      lead: 'any switches the compiler off. unknown keeps it on and makes you prove what a value is before using it.',
      blocks: [
        {
          kind: 'text',
          id: 'ts-any-unknown:concept',
          body: `Concept first: every value you did not produce yourself — request bodies, query parameters, environment variables, JSON from another service — has a type you cannot know in advance. TypeScript offers two ways to hold such a value. any declares "treat this as every type at once", which in practice switches the compiler off: the value flows anywhere, unchecked, and the eventual error surfaces far from its cause. unknown declares "this could be anything, so prove what it is before using it" — the same flexibility, the opposite discipline. This repo treats any as banned: input at the edges stays unknown until it is narrowed.\n\nThe canonical narrow runs in the demo routes, deciding whether a query parameter may become a FailureKind. Every step is a check the compiler can follow:`,
        },
        {
          kind: 'code',
          id: 'ts-any-unknown:narrow',
          language: 'ts',
          caption: 'server/src/presentation/routes/demo_routes.ts — verbatim',
          source: 'server/src/presentation/routes/demo_routes.ts',
          code: `function parseFailureKind(raw: unknown): FailureKind {
  if (typeof raw === 'string' && (FAILURE_KINDS as readonly string[]).includes(raw)) {
    return raw as FailureKind; // the cast is earned: the runtime check ran, but
                               // Array.includes cannot narrow for the compiler
  }
  throw new ValidationException('unknown or missing "failure" query parameter', {
    parameter: 'failure',
    validValues: [...FAILURE_KINDS],
  });
}`,
        },
        {
          kind: 'text',
          id: 'ts-any-unknown:guards',
          body: `Two language features make narrowing reusable across a codebase. A type predicate — a return type written value is T — lets a plain function narrow its argument's type for the caller. An assertion signature — asserts value is T — does the same job while throwing instead of returning a boolean. Both live in this repo's guards, the small runtime-check library every layer shares:`,
        },
        {
          kind: 'code',
          id: 'ts-any-unknown:guards-code',
          language: 'ts',
          caption: 'server/src/core/error_handling/guards.ts — verbatim; predicates that throw',
          source: 'server/src/core/error_handling/guards.ts',
          code: `export function assert(condition: unknown, failure: Failure): asserts condition {
  if (!condition) throw failureToException(failure);
}

export function assertDefined<T>(
  value: T | null | undefined,
  failure: Failure,
): asserts value is T {
  if (value === null || value === undefined) throw failureToException(failure);
}`,
        },
        {
          kind: 'text',
          id: 'ts-any-unknown:after',
          body: `After assertDefined(someValue, someFailure) returns, the compiler treats someValue as T for the rest of the block — a null check written once and reused everywhere, impossible to forget at a call site. Note what the guards throw: not just anything, but typed exceptions built from Failure values, so even "impossible" input flows into the same error pipeline as every other failure. That is the payoff of unknown plus guards: no unchecked values, and no second error path.`,
        },
      ],
    },
    {
      id: 'ts-async',
      title: 'Async JavaScript',
      lead: 'One thread, thousands of requests: promises, async/await, and not serializing work that could run together.',
      blocks: [
        {
          kind: 'text',
          id: 'ts-async:concept',
          body: `Concept first: a Node process runs your JavaScript on a single thread, and that thread is the scarcest resource the process owns. Every I/O — reading a file, querying a database, calling another HTTP service — is handed to the operating system, and the thread moves on to other work until the result is ready. The event loop is the scheduler underneath: it drains completed I/O events between your units of JavaScript. The one unforgivable sin is blocking the thread — a synchronous operation that takes 200ms stalls every request the process is serving for those 200ms.\n\nPromises are the language's model for a value that arrives later; async/await is syntax layered on them. An async function always returns a promise. await pauses just that function — never the thread — until the awaited promise settles. A rejected promise propagates out of the await exactly like a thrown exception, which is what lets this repo's controllers stay straight-line code:`,
        },
        {
          kind: 'code',
          id: 'ts-async:controller',
          language: 'ts',
          caption:
            'server/src/presentation/controllers/posts_controllers.ts — verbatim (dedented from the frozen object), a real async controller',
          source: 'server/src/presentation/controllers/posts_controllers.ts',
          code: `/** POST /api/posts → 201 created post */
async create(httpRequest: HttpRequest): Promise<HttpResponse> {
  const result = await createPost(httpRequest.body);
  if (!result.ok) throw failureToException(result.error); // failure -> error middleware
  return { status: 201, body: result.value };
}`,
        },
        {
          kind: 'text',
          id: 'ts-async:parallel',
          body: `The other half of async discipline is choosing the right shape of concurrency. Awaiting inside a loop serializes the work: each iteration waits for the previous one, and the total latency is the sum of every step. When the operations are independent, start them all and await once — the total latency becomes the slowest single operation:`,
        },
        {
          kind: 'code',
          id: 'ts-async:all',
          language: 'ts',
          caption:
            'server/src/presentation/routes/obs_demo_routes.ts — verbatim: this app probes two optional services at once (the sequential shape, and when it is right, sketched in the comments)',
          source: 'server/src/presentation/routes/obs_demo_routes.ts',
          code: `// Sequential — two round trips, total time = the sum. Right when the
// second call needs the first one's result; wasteful when they are independent:
//   const mongo = await checkMongo();
//   const redis = await checkRedis();

// Parallel — independent probes started together, total time = the slowest.
// (Real lines from the readiness endpoint: each probe is independently
// bounded — fail-fast clients — so worst case is the slowest, never the sum.)
const [mongo, redis] = await Promise.all([checkMongo(), checkRedis()]);`,
        },
        {
          kind: 'text',
          id: 'ts-async:errors',
          body: `Error propagation has one twist worth memorizing: Promise.all rejects as soon as any member rejects, so one failure fails the batch — usually the right semantics on a server. (This repo's use cases go one step further and report failures as Result values rather than thrown exceptions, so a failure arrives as data the caller branches on.) And one Express-5-specific fact: the framework forwards a rejected promise from an async route handler straight to the error middleware — that is why the create controller above can simply throw (the makeExpressCallback adapter awaits it inside its own try, and the throw rides next(err) out). Outside routes — startup code, schedulers, event handlers — nothing catches for you; that is precisely what the withGuards wrapper in this repo's guards.ts exists for.`,
        },
      ],
    },
    {
      id: 'ts-modules',
      title: 'Modules: ESM on Node',
      lead: 'import, not require: how ES modules work in a TypeScript project, and the one escape hatch you may still need.',
      blocks: [
        {
          kind: 'text',
          id: 'ts-modules:concept',
          body: `Concept first: a module system answers two questions — how a program splits into files, and how those files find each other. Node grew up on CommonJS: require() and module.exports, files loaded on demand and synchronously, exports copied at load time. The language itself later standardized ES modules: import and export, statically analyzable, with live bindings and top-level await. ESM is what won — browsers, bundlers, and modern Node all speak it, and static imports are what let tooling understand your dependency graph without executing it.\n\nThis repo is ESM end to end: package.json declares "type": "module" and tsconfig uses module: "NodeNext". That combination produces the one convention that trips every newcomer: TypeScript files import each other by their compiled path. You import ./app.js — never ./app.ts — because the specifier must name the file as it will exist at runtime, after tsc has erased the types and emitted JavaScript:`,
        },
        {
          kind: 'code',
          id: 'ts-modules:specifiers',
          language: 'ts',
          caption: 'server/src/presentation/controllers/posts_controllers.ts — real imports, verbatim',
          source: 'server/src/presentation/controllers/posts_controllers.ts',
          code: `import type { Failure } from '../../core/error_handling/failures.js';
import { failureToException } from '../../core/error_handling/exceptions.js';
import type { Result } from '../../core/result/result.js';
import type { Post } from '../../domain/posts/post.js';
import type { Controller, HttpRequest, HttpResponse } from '../routes/make_express_callback.js';`,
        },
        {
          kind: 'text',
          id: 'ts-modules:specifier-note',
          body: `Two details in that snippet deserve a second look. Relative imports carry the .js extension even though the source files are .ts — including the climb into a sibling directory, '../routes/make_express_callback.js'. And \`import type\` marks a whole type-only import: Failure, Result, Post, HttpRequest exist only in the type system, and importing them as types guarantees they are erased from the output instead of becoming runtime imports of things that do not exist. (The inline form — \`import { type Request } from 'express'\` — does the same job for a single name inside a value import.)\n\nESM has no require — which becomes a small problem the moment you need something only CommonJS exposes. The real case in this repo: reading the installed express package's version at runtime for the app-info demo. The escape hatch is createRequire, which builds a require function anchored to the current file's URL — note import.meta.url, ESM's replacement for __dirname:`,
        },
        {
          kind: 'code',
          id: 'ts-modules:createrequire',
          language: 'ts',
          caption: 'server/src/presentation/routes/demo_routes.ts — verbatim, the ESM escape hatch',
          source: 'server/src/presentation/routes/demo_routes.ts',
          code: `import { createRequire } from 'node:module';

// Express's own version, read once per process. createRequire is the ESM-safe
// way to load a CommonJS dependency manifest (no JSON import attributes, no
// tsconfig changes); the value can never change while the process lives.
const expressVersion: string = (() => {
  const nodeRequire = createRequire(import.meta.url);
  return nodeRequire('express/package.json').version as string;
})();`,
        },
      ],
    },
    {
      id: 'ts-erasure',
      title: 'Types are erased',
      lead: "TypeScript's types do not exist at runtime — which is why untrusted input stays unknown and validation lives at the boundary.",
      blocks: [
        {
          kind: 'text',
          id: 'ts-erasure:concept',
          body: `Concept first: TypeScript's compiler output is just JavaScript. Every annotation, interface, generic, and type alias is erased — run the build and dist/ contains plain ES modules with no trace of them. This is not a limitation you work around; it is the design, and it is why runtime behavior stays exactly what Node already knows how to run.\n\nThe consequence is the most important fact in this topic: a type annotation provides zero runtime protection. Write interface CreatePostInput { title: string } and a client can still POST { "title": 42 } or { } — the interface was erased long before the server accepted the connection. Whatever arrives in the request body is exactly what JSON parsing produced, no more, no less — the controller's httpRequest DTO types it unknown and passes it through untouched:`,
        },
        {
          kind: 'code',
          id: 'ts-erasure:boundary',
          language: 'ts',
          caption:
            'server/src/presentation/controllers/posts_controllers.ts — the trust boundary, verbatim (annotation added, dedented)',
          source: 'server/src/presentation/controllers/posts_controllers.ts',
          code: `/** POST /api/posts → 201 created post */
async create(httpRequest: HttpRequest): Promise<HttpResponse> {
  // httpRequest.body is untyped JSON straight off the network — the DTO
  // types it \`unknown\`, and no annotation protects the value. It is handed
  // to the use case unvalidated; the domain owns validation and answers
  // with a Result whose validation failure maps to a 400 through the error
  // pipeline.
  const result = await createPost(httpRequest.body);
  if (!result.ok) throw failureToException(result.error);
  return { status: 201, body: result.value };
}`,
        },
        {
          kind: 'text',
          id: 'ts-erasure:layering',
          body: `That is why validation lives where it does in this guide's layering. The presentation edge treats input as unknown and stays thin. The domain use case — the first layer that must guarantee invariants — validates the runtime value's shape and rules and returns a typed failure instead of trusting anything. Whether the checks are hand-rolled, as in this repo, or expressed with a schema library like zod, the placement is identical: at the boundary, on runtime values, in the one place types cannot help you.\n\nThe live demo below makes erasure visible. Post any JSON you like and watch the server report what actually arrived — every typeof, every array, every null — information no compile-time type ever had.`,
        },
      ],
    },
    {
      id: 'ts-live',
      title: 'See it live',
      lead: 'Two endpoints, one lesson: what the compiler proves versus what the runtime knows.',
      blocks: [
        {
          kind: 'text',
          id: 'ts-live:intro',
          body: `Everything above splits into two worlds: what the compiler proves before the process starts, and what the runtime knows while a request is being served. Both endpoints below are part of this server. The echo endpoint accepts any JSON you send and reports the types it received at runtime — proof that the types are gone. The types endpoint returns a real Result value, serialized, plus a narrowing trace running the same runtime checks this topic showed you.`,
        },
        {
          kind: 'code',
          id: 'ts-live:curl',
          language: 'bash',
          caption: 'drive both endpoints yourself',
          code: `# What the runtime knows about whatever you send:
curl -s -X POST localhost:4000/api/demo/ts/echo \\
  -H 'content-type: application/json' \\
  -d '{"title": 42, "tags": ["a", null]}'

# A serialized Result plus a live narrowing trace:
curl -s localhost:4000/api/demo/ts/types`,
        },
        {
          kind: 'demo',
          id: 'ts-live:demo',
          demoId: 'ts:runtime-types',
          title: 'Runtime type inspection',
          description:
            'POST any JSON body and watch the server report the types it actually received — proof that TypeScript types are erased at runtime — alongside a serialized Result value and a narrowing trace from the types endpoint.',
        },
      ],
    },
  ],
};
