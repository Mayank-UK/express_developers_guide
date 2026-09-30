import { useMemo, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `auth:oauth` — the Authentication topic's OAuth
 * authorization-code flow, act I launcher. The flow itself spans origins and
 * pages, which is the point: the button navigates the BROWSER (a top-level
 * navigation, not a fetch) to the local authorization server's consent page;
 * after approve/deny the provider redirects to /demos/oauth/callback, where
 * oauth_callback_view renders the four acts' results as numbered steps.
 *
 * This demo runs on the Vite dev server (port 5173) while the API lives on
 * the Express server (port 4000) — the authorize URL must therefore point at
 * the API ORIGIN, computed exactly the way docs_link_demo does (same-origin
 * in prod/Docker where one server fronts both; port 4000 in dev).
 */

const CLIENT_ID = 'guide_client';

/** The API origin — the docs-link demo's cross-origin approach, reused. */
function apiOrigin(): string {
  if (typeof window === 'undefined') return '';
  const { origin, port } = window.location;
  return port === '5173' ? 'http://localhost:4000' : origin;
}

/** The client's registered redirect — the callback route this app adds. */
function redirectUri(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/demos/oauth/callback`;
}

/** Random state — the CSRF defense of the whole redirect dance. */
function makeState(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const ACTS: { title: string; body: string }[] = [
  {
    title: 'Act I — redirect to the provider',
    body: 'Your browser navigates to /api/demo/oauth/authorize with client_id, redirect_uri, response_type=code, scope, and a random state (the CSRF defense).',
  },
  {
    title: 'Act II — consent at the provider',
    body: 'The provider (this guide\'s local authorization server) shows a REAL server-rendered consent page: the client name, the scope, and alice/bob/carol. Approve or deny.',
  },
  {
    title: 'Act III — the back-channel exchange',
    body: 'The provider redirects back here with a single-use, 60-second ?code=…&state=… — and the demo\'s stand-in for YOUR backend trades it (plus the client_secret it keeps server-side) for an access token.',
  },
  {
    title: 'Act IV — call the API',
    body: 'The callback page calls /api/demo/oauth/userinfo with Authorization: Bearer <token> — an HS256 JWT from the previous section, sub = the user who consented.',
  },
];

const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const START_BUTTON =
  'inline-flex w-fit items-center gap-xs rounded-md border border-outline bg-primary px-md py-xs text-body-sm font-semibold text-on-primary hover:opacity-90';
const PRE =
  'max-h-64 overflow-auto rounded-md border border-outline bg-surface-variant p-sm font-mono text-body-sm whitespace-pre-wrap break-all';

export default function OauthFlowDemo(): ReactNode {
  const state = useMemo(makeState, []);
  const callback = redirectUri();
  const authorizeUrl =
    typeof window === 'undefined'
      ? ''
      : `${apiOrigin()}/api/demo/oauth/authorize?response_type=code&client_id=${CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(callback)}&state=${state}`;

  return (
    <div className="flex flex-col gap-md">
      <p data-testid="oauth-summary" className="text-body-sm text-on-surface">
        The authorization-code flow, run for real against the guide's local OAuth provider: one
        click starts the four-act redirect dance, and the callback page renders every act's result
        as it happens. Deny works too — access_denied is a first-class outcome.
      </p>

      <ol data-testid="oauth-acts" className="flex flex-col gap-sm">
        {ACTS.map((act, index) => (
          <li key={act.title} data-testid={`oauth-act-${index + 1}`} className="flex flex-col gap-xxs rounded-md border border-outline p-sm">
            <span className="font-mono text-body-sm font-semibold text-on-surface">
              {act.title}
            </span>
            <span className="text-body-sm text-on-surface-variant">{act.body}</span>
          </li>
        ))}
      </ol>

      <section className="flex flex-col gap-sm rounded-md border border-outline p-sm">
        <div className="flex flex-wrap items-center gap-xs">
          <h3 className="font-mono text-body-sm font-semibold text-on-surface">Client registration</h3>
          <span className="text-caption text-on-surface-variant">
            (the fixed confidential client this guide plays)
          </span>
        </div>
        <div className="flex flex-wrap gap-xxs">
          <span className={CHIP}>client_id: {CLIENT_ID}</span>
          <span className={CHIP}>secret: guide_demo_secret (server-side only — the browser never sees it)</span>
          <span className={CHIP}>scope: profile</span>
          <span data-testid="oauth-redirect-chip" className={CHIP}>
            redirect_uri: {callback}
          </span>
        </div>

        {typeof window !== 'undefined' && window.location.port === '5173' && (
          <p className="text-caption text-on-surface-variant">
            You are on the Vite dev server, so the authorize URL points straight at the Express
            origin (localhost:4000) — the only way a browser can reach the provider's consent page
            when the API lives on another port.
          </p>
        )}
      </section>

      {/* A top-level NAVIGATION (an anchor, not fetch): the flow's whole shape
          is "the browser goes there and comes back with ?code=…". */}
      <a
        data-testid="oauth-start"
        href={authorizeUrl}
        className={START_BUTTON}
      >
        Start the OAuth flow → consent page
      </a>

      <p className="text-caption text-on-surface-variant">
        After you approve or deny, the provider redirects to{' '}
        <code className="font-mono">/demos/oauth/callback</code> — this app's registered redirect —
        and the four acts' results render there as numbered steps. Come back here (or use the
        callback's link) to run it again as a different user.
      </p>

      <details className="rounded-md border border-outline p-sm">
        <summary className="cursor-pointer font-mono text-body-sm text-on-surface">
          the authorize URL you are about to visit
        </summary>
        <pre data-testid="oauth-authorize-url" className={PRE}>
          {authorizeUrl}
        </pre>
      </details>
    </div>
  );
}
