import express, { type Express } from 'express';

/**
 * Teaching exhibit (deployment topic — "The headers that keep the app
 * honest").
 *
 * Behind a reverse proxy, Express must be told to TRUST the proxy's
 * X-Forwarded-* headers, or req.ip / req.protocol / req.secure keep reporting
 * the PROXY's truth (its IP, plain http). `app.set('trust proxy', 1)` says
 * "exactly ONE proxy sits in front of me; believe its forwarded headers" —
 * the number must match the real hop count, or clients can forge the header.
 *
 * The main app (src/app.ts) deliberately does NOT set it: the guide must be
 * equally correct with no proxy at all, as in dev. This exhibit pins the
 * one-line change the deployment topic shows — the proxy half of the contract
 * (forwarding X-Real-IP / X-Forwarded-For / X-Forwarded-Proto) lives in the
 * nginx conf the topic quotes.
 */
export function createProxyAwareApp(): Express {
  const app = express();
  // Behind exactly ONE proxy (the nginx container), its X-Forwarded-* headers
  // are the visitor's truth; without a proxy the setting must be absent, or
  // any client could forge req.ip with a header.
  app.set('trust proxy', 1);
  return app;
}
