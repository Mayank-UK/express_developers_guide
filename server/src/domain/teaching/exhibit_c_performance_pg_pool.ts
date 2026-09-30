/**
 * Teaching exhibit (performance topic — "Pooling and connection discipline"):
 * the pg.Pool pattern this app would adopt the day a server-based database
 * replaces sqlite. better-sqlite3 needs NO pool — the database is an
 * in-process C call — but postgres has a CONNECTION CAP and a per-connection
 * handshake cost, the two numbers a pool exists to manage.
 *
 * Deliberately NOT executed, and pg deliberately NOT installed (the sql
 * topics teach raw SQL over sqlite first; a pg demo would need a live server
 * to be honest). The exhibit pins the SHAPE as real, compilable code: the
 * configuration knobs with their reasons, plus the usage and shutdown-drain
 * blocks that ride along in production (as comments — the construction is a
 * one-liner the day postgres arrives).
 */

/** The pool's configuration, in pg's own field names. */
export const PG_POOL_CONFIG = {
  // Sized deliberately: small enough to respect the database's connection
  // cap, big enough that request spikes queue at the pool (cheap) instead of
  // the TCP handshake (expensive). Start ~20–50 and let p95 tell you where
  // to move it.
  max: 20,
  idleTimeoutMillis: 30_000,
  // Checkout waits at most 5s — then a failure, not a hang.
  connectionTimeoutMillis: 5_000,
  // Where the connection string lives: env, per the environments topic.
  connectionString: process.env.PG_DATABASE_URL,
} as const;

// The construction, the day postgres arrives:
//   import { Pool } from 'pg';
//   export const pool = new Pool({ ...PG_POOL_CONFIG });
//
// Usage borrows and returns in one expression — connections can never leak:
//   const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [id]);
//
// Graceful shutdown drains the pool BEFORE the process exits (the same
// discipline as server.ts draining gRPC → mongo → redis → hub → http):
//   await pool.end();
