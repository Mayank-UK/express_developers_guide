import { createRequire } from 'node:module';
import pino from 'pino';
import { appConfig } from '../config/app_config.js';
import { ringDestination } from './log_ring.js';

const nodeRequire = createRequire(import.meta.url);

/**
 * The app-wide pino logger, tee'd to TWO destinations (pino.multistream):
 *
 * 1. the human/operator destination — pino-pretty in development (same
 *    options the previous worker-thread transport carried, so the console
 *    output is unchanged), raw JSON on stdout in staging/production;
 * 2. the in-memory ring destination (log_ring.ts) — EVERY environment, so
 *    the observability demo's log viewer renders exactly what this process
 *    logged, at the same moment the console printed it.
 *
 * pino-pretty is a DEV dependency and is therefore loaded with require()
 * INSIDE the development branch — a production install (--omit=dev) never
 * resolves it. The pretty stream runs in-process now instead of a worker
 * thread; the trade (one extra transform on the main thread per log line) is
 * nothing at this app's volume and buys synchronous tee-ing to the ring.
 */
export const logger =
  appConfig.nodeEnv === 'development'
    ? pino(
        { level: appConfig.logLevel },
        pino.multistream([
          {
            stream: nodeRequire('pino-pretty')({
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            }),
            // multistream entries default their own level to info — pin it to
            // the logger's, or a LOG_LEVEL=debug dev session would silently
            // lose its debug lines at the stream boundary.
            level: appConfig.logLevel,
          },
          { stream: ringDestination, level: appConfig.logLevel },
        ]),
      )
    : pino(
        { level: appConfig.logLevel },
        pino.multistream([
          { stream: process.stdout, level: appConfig.logLevel },
          { stream: ringDestination, level: appConfig.logLevel },
        ]),
      );
