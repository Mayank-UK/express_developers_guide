import type { ReactNode } from 'react';

/**
 * Demo for DemoBlock `api:docs-link` — the api-documentation topic's link-out
 * panel. The docs are REAL and served by the same Express app this client
 * talks to: Swagger UI at /docs/ and the raw OpenAPI document at
 * /docs/openapi.json. No fetch, no state — just an honest pair of links and
 * what to do with them.
 */

/**
 * Where the docs live, resolved per browser: same-origin when the guide is
 * served beside the API (Docker/prod fronts both), and the Express origin
 * (port 4000) when this page runs on the Vite dev server, which proxies /api
 * only. Visiting the server directly (localhost:4000) always works.
 */
function docsOrigin(): string {
  if (typeof window === 'undefined') return '';
  const { origin, port } = window.location;
  return port === '5173' ? 'http://localhost:4000' : origin;
}

const LINK_BUTTON =
  'inline-flex w-fit items-center gap-xs rounded-md border border-outline bg-primary px-md py-xs text-body-sm font-semibold text-on-primary hover:opacity-90';
const LINK_SECONDARY =
  'inline-flex w-fit items-center gap-xs rounded-md border border-outline px-sm py-xs font-mono text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface';

export default function DocsLinkDemo(): ReactNode {
  const origin = docsOrigin();

  return (
    <div className="flex flex-col gap-sm">
      <a
        data-testid="docs-link-open"
        href={`${origin}/docs/`}
        target="_blank"
        rel="noopener noreferrer"
        className={LINK_BUTTON}
      >
        Open the API docs — Swagger UI at /docs
      </a>

      <a
        data-testid="docs-link-spec"
        href={`${origin}/docs/openapi.json`}
        target="_blank"
        rel="noopener noreferrer"
        className={LINK_SECONDARY}
      >
        /docs/openapi.json — the raw contract as JSON
      </a>

      <p data-testid="docs-link-notes" className="text-body-sm text-on-surface">
        What you will find there: every path this app really serves (health, content, posts, the demo
        scenario), each with its parameters, request bodies, response schemas, and the ONE reusable
        error envelope every failure answers with. Use <span className="font-mono">try it out</span>{' '}
        on <span className="font-mono">GET /api/posts</span> right in the page — toggle failure
        injection (<span className="font-mono">PATCH /api/demo/scenario</span>) first and try again
        to watch the documented 503 envelope arrive exactly as described. The JSON link is the same
        contract as data: feed it to a client generator, a linter, or jq. The suite checks the spec
        against the routes, so what you read there is what the server does.
      </p>

      {origin === 'http://localhost:4000' && (
        <p className="text-caption text-on-surface-variant">
          You are on the Vite dev server, which proxies /api only — these links point straight at
          the Express origin (localhost:4000), where the docs are served.
        </p>
      )}
    </div>
  );
}
