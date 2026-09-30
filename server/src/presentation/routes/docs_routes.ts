import { Router } from 'express';
import { serve as swaggerServe, setup as swaggerSetup } from 'swagger-ui-express';
import { openApiDocument } from './openapi_document.js';

/**
 * Documentation surface — Swagger UI backed by the hand-written OpenAPI
 * document in openapi_document.ts:
 * - GET /docs              → Swagger UI (the bare form redirects to /docs/ —
 *                            the UI's asset URLs are relative, so the
 *                            trailing slash is where they resolve)
 * - GET /docs/openapi.json → the raw spec, for tooling and curl
 *
 * Unlike every other router here, docs routes mount on the ROOT app (in
 * src/app.ts), not under /api: Swagger UI resolves its own CSS/JS relative to
 * the mount path, and a /api/docs mount would advertise API paths that then
 * double the prefix. /docs beside /api is the conventional split.
 */

export const DOCS_UI_PATH = '/docs';
export const DOCS_SPEC_PATH = '/docs/openapi.json';

export const docsRouter = Router();

// The raw spec first — exact route wins over the static-asset fallthrough.
docsRouter.get(DOCS_SPEC_PATH, (_req, res) => {
  res.json(openApiDocument);
});

// Bare /docs → /docs/ (301), as a middleware BEFORE the mount: Express's
// non-strict routing cannot express "match /docs but not /docs/" as a route
// pattern, but req.path can tell them apart. Without this, the UI page would
// serve at /docs with ./swagger-ui.css resolving to /swagger-ui.css — 404s.
docsRouter.use((req, res, next) => {
  if (req.method === 'GET' && req.path === DOCS_UI_PATH) {
    res.redirect(301, `${DOCS_UI_PATH}/`);
    return;
  }
  next();
});

// Serve (static assets, index disabled) then the generated HTML page —
// both /docs/ (req.url '/') and every asset path land here.
docsRouter.use(DOCS_UI_PATH, swaggerServe, swaggerSetup(openApiDocument));
