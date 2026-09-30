import {
  Metadata,
  Server,
  ServerCredentials,
  status,
  handleUnaryCall,
} from '@grpc/grpc-js';
import { getContainer } from '../../di/container.js';
import {
  FAILURE_ERROR_CODE,
  type Failure,
  type FailureKind,
} from '../../core/error_handling/failures.js';
import { logger } from '../../core/logging/logger.js';
import type { Post } from '../../domain/posts/post.js';
import {
  POSTS_SERVICE_DEFINITION,
  type GrpcPostMessage,
  type GrpcPostsList,
} from './posts_proto.js';

/**
 * The guide's REAL gRPC server (the `grpc` topic's working example): a
 * grpc-js Server speaking HTTP/2 on its own port, implementing guide.v1.
 * PostsService by delegating to the SAME PostsUseCase the REST and GraphQL
 * surfaces use (via the container) — so fake/live data and failure injection
 * apply here exactly as everywhere else.
 *
 * Why a SECOND port: gRPC wants HTTP/2 end to end, while the Express app
 * speaks HTTP/1.1 cleartext. Serving both from one Node process cleanly means
 * two listeners: :4000 is the HTTP/1.1 guide, :50051 (GRPC_PORT) is this
 * HTTP/2 listener. The demo browser drives it through the HTTP bridge in
 * grpc_demo_routes.ts, which runs a real gRPC client in-process.
 */

/**
 * The app's one Failure taxonomy, translated to gRPC status codes — the
 * gRPC counterpart of FAILURE_HTTP_STATUS in failures.ts. Exhaustive on
 * purpose: a new FailureKind must decide its gRPC status here to compile.
 */
export const FAILURE_GRPC_STATUS: Readonly<Record<FailureKind, number>> = {
  validation: status.INVALID_ARGUMENT, // 3  — the caller sent a bad request
  unauthorized: status.UNAUTHENTICATED, // 16 — the caller proved nothing
  forbidden: status.PERMISSION_DENIED, // 7  — authenticated but not allowed
  not_found: status.NOT_FOUND, // 5  — well-formed id, nothing behind it
  conflict: status.ALREADY_EXISTS, // 6  — the resource state conflicts
  rate_limited: status.RESOURCE_EXHAUSTED, // 8  — quota / throttling
  unavailable: status.UNAVAILABLE, // 14 — the service cannot answer now
  internal: status.INTERNAL, // 13 — our bug, not the caller's
};

/** The error shape grpc-js handlers pass to callback(err). */
interface GrpcStatusError extends Error {
  code: number;
  details: string;
  metadata: Metadata;
}

/**
 * Converts a Failure into a gRPC error. Two wire facts shape this function:
 * grpc-js sends error.details (when present) as the status message — so the
 * HUMAN message goes there — while structured facts ride the trailer
 * metadata (the gRPC-native channel for extra error context). A raw client
 * then sees "5 NOT_FOUND: no post with id …" and can still read the app's
 * own kind/error-code from the trailers.
 */
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

/** Domain Post → wire PostMessage (snake_case fields became camelCase in the loader). */
function postToMessage(post: Post): GrpcPostMessage {
  return {
    id: post.id,
    title: post.title,
    body: post.body,
    author: post.author,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

/** Runs one use case and answers the gRPC callback with its Result — the thin-controller pattern, gRPC edition. */
async function answerWith<T>(
  callback: (error: GrpcStatusError | null, response?: T) => void,
  run: () => Promise<{ ok: true; value: T } | { ok: false; error: Failure }>,
): Promise<void> {
  const result = await run();
  if (!result.ok) {
    callback(failureToGrpcError(result.error));
    return;
  }
  callback(null, result.value);
}

// --- the three handlers: parse nothing (the proto did), delegate, map -------

const listPostsHandler: handleUnaryCall<unknown, GrpcPostsList> = async (_call, callback) => {
  await answerWith(callback, async () => {
    const result = await getContainer().postsUseCase.list();
    return result.ok
      ? { ok: true as const, value: { posts: result.value.map(postToMessage) } }
      : result;
  });
};

const getPostHandler: handleUnaryCall<{ id?: unknown }, GrpcPostMessage> = async (call, callback) => {
  await answerWith(callback, async () => {
    const result = await getContainer().postsUseCase.getById(call.request.id);
    return result.ok ? { ok: true as const, value: postToMessage(result.value) } : result;
  });
};

const createPostHandler: handleUnaryCall<Record<string, unknown>, GrpcPostMessage> = async (
  call,
  callback,
) => {
  // The proto already guaranteed an object of strings; the USE CASE still
  // owns validation (lengths, unknown fields) exactly as for REST/GraphQL.
  await answerWith(callback, async () => {
    const result = await getContainer().postsUseCase.create(call.request);
    return result.ok ? { ok: true as const, value: postToMessage(result.value) } : result;
  });
};

/** A started gRPC server: the port it bound and how to stop it. */
export interface GrpcServerHandle {
  readonly port: number;
  stop(): Promise<void>;
}

/** The one running instance (server.ts starts it; the demo bridge lazily can too). */
let running: GrpcServerHandle | undefined;

/** The running server, if this process already started one. */
export function getRunningGrpcServer(): GrpcServerHandle | undefined {
  return running;
}

/**
 * Starts guide.v1.PostsService on `port`. Port 0 asks the OS for an ephemeral
 * port (tests, and the bridge's lazy fallback, never collide with a real
 * GRPC_PORT). Idempotent: a second call returns the already-running server.
 */
export async function startGrpcServer(port: number): Promise<GrpcServerHandle> {
  if (running !== undefined) return running;

  const server = new Server();
  server.addService(POSTS_SERVICE_DEFINITION, {
    ListPosts: listPostsHandler,
    GetPost: getPostHandler,
    CreatePost: createPostHandler,
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`127.0.0.1:${port}`, ServerCredentials.createInsecure(), (err, bound) => {
      if (err !== undefined && err !== null) reject(err);
      else resolve(bound);
    });
  });

  logger.info(
    { port: boundPort, service: 'guide.v1.PostsService' },
    'grpc server listening (insecure — local teaching only; production uses TLS)',
  );

  let handle: GrpcServerHandle;
  handle = {
    port: boundPort,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve());
      });
      // Clear the singleton so nobody is handed a dead server — but only if
      // this handle is still the current one (stopGrpcServer may have beaten us).
      if (running === handle) running = undefined;
    },
  };
  running = handle;
  return handle;
}

/** Stops the running instance, if any (graceful shutdown + test cleanup). */
export async function stopGrpcServer(): Promise<void> {
  const handle = running;
  running = undefined;
  if (handle !== undefined) await handle.stop();
}
