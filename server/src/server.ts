import { app } from './app.js';
import { appConfig } from './core/config/app_config.js';
import { logger } from './core/logging/logger.js';
import { closeOutboxDatabase } from './data/messaging/outbox_service.js';
import { closeMongoConnection } from './data/mongo/mongo_client.js';
import { closeSqlite } from './data/posts/sqlite_client.js';
import { closeRedis } from './data/redis/redis_client.js';
import { attachChatHub, type ChatHub } from './data/realtime/chat_hub.js';
import { startGrpcServer, type GrpcServerHandle } from './presentation/grpc/grpc_server.js';

const server = app.listen(appConfig.port, '0.0.0.0', () => {
  logger.info(
    { port: appConfig.port, nodeEnv: appConfig.nodeEnv },
    'express_developers_guide server listening',
  );
});

server.on('error', (err: Error) => {
  logger.fatal({ err }, 'server failed to start');
  process.exit(1);
});

// The third surface: WebSockets. The upgrade handshake rides THIS HTTP
// server's port (a WebSocket connection starts life as an HTTP GET with
// Upgrade: websocket), routed by attachChatHub — noServer + a manual
// 'upgrade' listener, so ONLY /api/demo/realtime/chat becomes a socket and
// every other upgrade path is declined at the socket level. Express never
// sees any of it: upgrades bypass the middleware chain entirely.
const chatHub: ChatHub = attachChatHub(server);

// The second listener: gRPC (HTTP/2) on its own port, started AFTER the HTTP
// server so Express's port errors win. tryAddPort-style: a gRPC bind failure
// (say GRPC_PORT is taken) degrades — the HTTP guide keeps serving and the
// demo bridge lazily starts an ephemeral server instead of crashing the app.
const grpcServerPromise: Promise<GrpcServerHandle | null> = startGrpcServer(appConfig.grpcPort)
  .then((handle) => {
    logger.info({ grpcPort: handle.port }, 'grpc demo service started');
    return handle;
  })
  .catch((err: Error) => {
    logger.error(
      { err, grpcPort: appConfig.grpcPort },
      'grpc server failed to start — the HTTP guide keeps serving; the demo bridge will retry on an ephemeral port',
    );
    return null;
  });

/** Graceful shutdown: stop accepting connections, finish in-flight work, exit. */
function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down gracefully');
  // Stop the gRPC listener first (it only fronts the same use cases), then
  // drain the optional mongo connection, then BOTH redis connections (the
  // commands client and the pub/sub subscriber — a no-op each when never
  // opened), then close the chat hub (its websockets would otherwise hold
  // server.close() open until the force-exit timer), then the local sqlite
  // stores (the outbox demo's process-global :memory: handle and the primary
  // posts database — cheap synchronous closers, safe to run last, after every
  // writer above has drained), then close HTTP — a failure on any path still
  // reaches server.close().
  void grpcServerPromise
    .then((handle) => handle?.stop())
    .catch(() => undefined)
    .finally(() => {
      void closeMongoConnection()
        .catch(() => undefined)
        .finally(() => {
          void closeRedis()
            .catch(() => undefined)
            .finally(() => {
              void chatHub
                .close()
                .catch(() => undefined)
                .finally(() => {
                  void Promise.resolve()
                    .then(() => closeOutboxDatabase())
                    .catch(() => undefined)
                    .then(() => closeSqlite())
                    .catch(() => undefined)
                    .finally(() => {
                      server.close(() => {
                        logger.info('http server closed');
                        process.exit(0);
                      });
                    });
                });
            });
        });
    });
  // Safety net: server.close() waits on keep-alive connections; don't hang forever.
  const forceExitTimer = setTimeout(() => {
    logger.warn('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Process-level safety nets — the LAST line of defense (the exception-handling
// topic documented their absence as a deliberate deferral; this is the
// observability task landing them). An exception that unwinds past every
// handler, or a rejected promise nobody awaited, means the process's state is
// SUSPECT: locks may be held, invariants may be half-applied, memory may be
// leaking. The honest move is NOT "log it and keep running" — a corrupted
// process serving traffic is worse than a gap in traffic — it is: log FATAL
// with everything we know, then exit non-zero and let the supervisor (Docker
// restart policy, compose, pm2, Kubernetes — the deployment topic's cast)
// start a CLEAN process. The 100ms grace gives the stdout pipe a beat to
// flush the fatal line before the exit truncates it.
process.on('uncaughtException', (err: Error) => {
  logger.fatal({ err }, 'uncaught exception — exiting so the supervisor restarts a clean process');
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal(
    { err: reason },
    'unhandled promise rejection — exiting so the supervisor restarts a clean process',
  );
  setTimeout(() => process.exit(1), 100);
});
