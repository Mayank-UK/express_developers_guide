import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSync } from '@grpc/proto-loader';
import {
  Client,
  ServiceDefinition,
  UntypedServiceImplementation,
  credentials,
  loadPackageDefinition,
  type ChannelCredentials,
} from '@grpc/grpc-js';

/**
 * Runtime proto loading for the guide's gRPC surface — the "zero build step"
 * half of the codegen-vs-runtime-loading tradeoff the gRPC topic teaches.
 *
 * POSTS_PROTO_SOURCE is the runtime source of truth for the contract. The
 * physical posts.proto beside this file is the same text, byte for byte —
 * the demo route's spec asserts string equality, so the two can never drift
 * apart silently.
 */

export const GRPC_PACKAGE = 'guide.v1';
export const GRPC_SERVICE = 'PostsService';
export const GRPC_FULL_SERVICE_NAME = `${GRPC_PACKAGE}.${GRPC_SERVICE}`;

/** The three unary methods guide.v1.PostsService exposes. */
export const GRPC_METHODS = ['ListPosts', 'GetPost', 'CreatePost'] as const;
export type GrpcMethodName = (typeof GRPC_METHODS)[number];

export const POSTS_PROTO_SOURCE = `syntax = "proto3";

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
}
`;

/**
 * The canonical proto-loader options (they are the ones the gRPC docs use):
 * - keepCase: false — posts.proto's created_at arrives as createdAt, the
 *   JavaScript naming this app uses everywhere else
 * - longs/enums as String — no Long library dependency, values stay JSON-safe
 * - defaults: true — unset proto3 fields come back as their zero values
 * - oneofs: true — oneof members surface as plain fields
 */
const LOADER_OPTIONS = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

/**
 * proto-loader is file-oriented: loadSync wants a PATH, not source text. So
 * the embedded source is staged to a temp file once per process — identical
 * behavior under tsx (running src), vitest (src) and the compiled dist,
 * which tsc does not copy .proto assets into.
 */
function stageProtoFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guide-grpc-'));
  const protoPath = join(dir, 'posts.proto');
  writeFileSync(protoPath, POSTS_PROTO_SOURCE);
  return protoPath;
}

/** What loadPackageDefinition hands back for guide.v1.PostsService, loosely typed (no codegen). */
interface LoadedPostsService {
  service: ServiceDefinition<UntypedServiceImplementation>;
  new (address: string, channelCredentials: ChannelCredentials): Client;
}

const packageDefinition = loadSync(stageProtoFile(), LOADER_OPTIONS);
// loadPackageDefinition nests dotted package names: pkg.guide.v1.PostsService.
const loaded = loadPackageDefinition(packageDefinition) as unknown as {
  guide: { v1: { PostsService: LoadedPostsService } };
};
const postsService = loaded.guide.v1.PostsService;

/** The service definition a grpc-js Server.addService call wants. */
export const POSTS_SERVICE_DEFINITION: ServiceDefinition<UntypedServiceImplementation> =
  postsService.service;

/** The full method paths as they appear on the wire, derived from the loaded proto. */
export const GRPC_METHOD_PATHS: Readonly<Record<GrpcMethodName, string>> = Object.freeze({
  ListPosts: String(POSTS_SERVICE_DEFINITION.ListPosts?.path ?? ''),
  GetPost: String(POSTS_SERVICE_DEFINITION.GetPost?.path ?? ''),
  CreatePost: String(POSTS_SERVICE_DEFINITION.CreatePost?.path ?? ''),
});

/** A post as proto-loader shapes it after keepCase conversion. */
export interface GrpcPostMessage {
  id: string;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface GrpcPostsList {
  posts: GrpcPostMessage[];
}

/** The error a grpc-js client hands its callback: code + details + trailer metadata. */
export interface GrpcClientError extends Error {
  code?: number;
  details?: string;
  metadata?: { getMap(): Map<string, unknown> };
}

export type GrpcUnaryCallback = (error: GrpcClientError | null, response?: unknown) => void;

/** Structural type for one unary method on the generated client class. */
export type GrpcUnaryMethod = (
  payload: unknown,
  options: { deadline: number },
  callback: GrpcUnaryCallback,
) => unknown;

export type PostsServiceStub = Readonly<Record<GrpcMethodName, GrpcUnaryMethod>>;

export interface PostsServiceClientHandle {
  stub: PostsServiceStub;
  close(): void;
}

/**
 * Builds a one-shot client for guide.v1.PostsService over insecure local
 * credentials. No codegen means no typed client class — the structural cast
 * is the runtime-loading tradeoff made visible (one line of it).
 */
export function createPostsServiceClient(port: number): PostsServiceClientHandle {
  const client = new postsService(`127.0.0.1:${port}`, credentials.createInsecure());
  return {
    stub: client as unknown as PostsServiceStub,
    close: () => client.close(),
  };
}
