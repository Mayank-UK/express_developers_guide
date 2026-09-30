import { Router, type Request, type Response } from 'express';
import { status } from '@grpc/grpc-js';
import { ValidationException } from '../../core/error_handling/exceptions.js';
import {
  getRunningGrpcServer,
  startGrpcServer,
} from '../grpc/grpc_server.js';
import {
  GRPC_FULL_SERVICE_NAME,
  GRPC_METHODS,
  GRPC_METHOD_PATHS,
  POSTS_PROTO_SOURCE,
  createPostsServiceClient,
  type GrpcClientError,
  type GrpcMethodName,
} from '../grpc/posts_proto.js';

/**
 * The gRPC topic's HTTP bridge (the `grpc` topic's live demo endpoints).
 *
 * Browsers speak fetch, not HTTP/2-framed gRPC — so the demo cannot call the
 * gRPC service directly. This bridge is the pattern real teams use for that
 * last mile (grpc-web proxies like Envoy do it at the infrastructure level):
 * the browser POSTs an "invoke this rpc" instruction over ordinary HTTP, and
 * the bridge runs a REAL grpc-js client call in-process against the guide's
 * running guide.v1.PostsService, then relays the outcome.
 *
 * - GET  /api/demo/grpc/status → { running, port, service, methods, proto }
 * - POST /api/demo/grpc/invoke → { method, status, code, response | message }
 *
 * Error policy (deliberate, the gRPC-flavored version of the GraphQL topic's
 * decision): the bridge always answers HTTP 200 with the gRPC OUTCOME — a
 * NOT_FOUND is a successful observation of a failed call, and rendering it as
 * an HTTP 4xx/5xx would lie twice. Only a malformed instruction (unknown
 * method name, payload that is not a JSON object) is a 400 error envelope.
 */

/** The invoke deadline: every bridge call carries one, so a hung rpc can't hang the browser tab. */
const BRIDGE_DEADLINE_MS = 2_000;

/** status code number → its canonical name (5 → 'NOT_FOUND'), built from grpc-js's own table. */
const STATUS_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(status)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([name, code]) => [code, name]),
);

function statusName(code: number | undefined): string {
  if (code === undefined) return 'UNKNOWN';
  return STATUS_NAMES.get(code) ?? 'UNKNOWN';
}

/**
 * The gRPC server this bridge calls. server.ts starts the real one on
 * GRPC_PORT; when it has not (vitest boots routes without server.ts, or the
 * configured port was taken) the bridge lazily starts an ephemeral port-0
 * singleton — never colliding with anything, identical behavior.
 */
async function ensureBridgeServer() {
  return getRunningGrpcServer() ?? (await startGrpcServer(0));
}

function statusController(_req: Request, res: Response): void {
  const running = getRunningGrpcServer();
  res.json({
    running: running !== undefined,
    port: running?.port ?? null,
    service: GRPC_FULL_SERVICE_NAME,
    methods: GRPC_METHODS.map((method) => ({ method, path: GRPC_METHOD_PATHS[method] })),
    proto: POSTS_PROTO_SOURCE,
    note: 'proto-loader loads this source at runtime — no codegen step. The invoke bridge adds a '
      + `${BRIDGE_DEADLINE_MS}ms deadline to every call.`,
  });
}

/** Reads and validates the instruction envelope { method, payload? }. Throws ValidationException. */
function readInvokeBody(body: unknown): { method: GrpcMethodName; payload: Record<string, unknown> } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationException(
      'the invoke bridge needs a JSON object body (Content-Type: application/json)',
      { parameter: 'body' },
    );
  }
  const { method, payload } = body as Record<string, unknown>;

  if (typeof method !== 'string' || !(GRPC_METHODS as readonly string[]).includes(method)) {
    throw new ValidationException(
      `"method" must be one of ${GRPC_METHODS.map((name) => `"${name}"`).join(', ')}`,
      { parameter: 'method', received: method, service: GRPC_FULL_SERVICE_NAME },
    );
  }

  if (payload === undefined) {
    return { method: method as GrpcMethodName, payload: {} };
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationException('"payload" must be a JSON object matching the method\'s request message', {
      parameter: 'payload',
      received: payload,
    });
  }
  return { method: method as GrpcMethodName, payload: payload as Record<string, unknown> };
}

/** The human message from a client error: the status message grpc-js delivered in `details`. */
function statusMessageFrom(error: GrpcClientError): string {
  if (typeof error.details === 'string' && error.details !== '') return error.details;
  // Fallback: strip the "14 UNAVAILABLE: " prefix grpc-js bakes into message.
  return error.message.replace(/^\d+\s+[A-Z_]+:\s*/, '');
}

/** Reads one trailer value as a string, tolerant of Map and plain-object getMap shapes. */
function metadataValue(raw: unknown, key: string): string | undefined {
  const value: unknown =
    raw instanceof Map ? raw.get(key) : typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? String(value[0]) : String(value);
}

/** Reads this app's own taxonomy back out of the trailer metadata, when the server sent it. */
function failureFactsFrom(error: GrpcClientError): { kind: string; errorCode: string } | undefined {
  const raw: unknown = error.metadata?.getMap();
  const kind = metadataValue(raw, 'x-failure-kind');
  const errorCode = metadataValue(raw, 'x-error-code');
  if (kind === undefined || errorCode === undefined) return undefined;
  return { kind, errorCode };
}

async function invokeController(req: Request, res: Response): Promise<void> {
  const instruction = readInvokeBody(req.body);
  const server = await ensureBridgeServer();
  const client = createPostsServiceClient(server.port);

  try {
    const outcome = await new Promise<{ error: GrpcClientError | null; response?: unknown }>(
      (resolve) => {
        client.stub[instruction.method](
          instruction.payload,
          { deadline: Date.now() + BRIDGE_DEADLINE_MS },
          (error, response) => resolve({ error, response }),
        );
      },
    );

    if (outcome.error !== null) {
      const error = outcome.error;
      const failure = failureFactsFrom(error);
      res.json({
        method: instruction.method,
        status: statusName(error.code),
        code: error.code ?? status.UNKNOWN,
        message: statusMessageFrom(error),
        ...(failure !== undefined && { failure }),
      });
      return;
    }

    res.json({
      method: instruction.method,
      status: 'OK',
      code: status.OK,
      response: outcome.response,
    });
  } finally {
    // One client per call: no channel reuse, nothing left listening.
    client.close();
  }
}

export const grpcDemoRouter = Router();
grpcDemoRouter.get('/demo/grpc/status', statusController);
grpcDemoRouter.post('/demo/grpc/invoke', invokeController);
