/**
 * Self-hosted Umami analytics — a runtime beacon loader + a typed event
 * wrapper. NO npm dependency: the beacon is a plain `<script defer>` tag
 * injected into <head> once per document, and events call the global
 * `window.umami.track(name, data)` that the beacon installs.
 *
 * CONFIGURATION (Vite build-time env — values are baked into the bundle at
 * build time, hence the Dockerfile ARG/ENV plumbing):
 * - `VITE_UMAMI_SRC` — the beacon script URL (e.g. https://umami…/script.js)
 * - `VITE_UMAMI_ID`  — the Umami website id (rendered as data-website-id)
 *
 * BOTH must be non-empty for analytics to exist at all. The dev/test
 * default (both unset) is a COMPLETE no-op: no script tag is injected and
 * `trackEvent` sends nothing — specs and local dev stay silent without a
 * single conditional at the call sites. Both values are PUBLIC (visible in
 * the served page source anyway), so they ride repository variables, never
 * secrets.
 */

/** Marks the injected beacon so initAnalytics stays idempotent per
 * document (StrictMode's dev double-mount, remounts). */
const UMAMI_SCRIPT_ID = 'umami-analytics';

/** The Umami beacon's global handle — absent until the script loads (and
 * forever, when analytics is unconfigured). Narrowed to the one method we
 * call; the real object carries more, never less. */
declare global {
  interface Window {
    umami?: {
      track: (name: string, data?: Record<string, unknown>) => void;
    };
  }
}

/**
 * The guide's analytics vocabulary — a CLOSED discriminated union: every
 * trackable interaction is exactly one of these, with its typed payload.
 * No dynamic strings ever reach the beacon.
 */
export type AnalyticsEvent =
  /** A topic screen finished loading — fires for home-card clicks, direct
   * links, and refreshes alike (TopicView). The payload is the served
   * topic id (e.g. "authentication"). */
  | { readonly name: 'topic-open'; readonly topic: string }
  /** A CodeBlock copy succeeded (code-block.tsx). CodeBlock has no topic
   * prop — it renders served content — so the payload is the current route
   * path ("/topics/<id>" on topic screens, "/" or "/about" elsewhere). */
  | { readonly name: 'copy-code'; readonly topic: string }
  /** RESERVED, not yet wired: demos auto-mount inline beside their teaching
   * sections, so no single user-triggered "run" action exists to report.
   * The member documents the payload (the demoId, e.g. "auth:jwt") for the
   * call site that eventually lands. */
  | { readonly name: 'demo-run'; readonly demo: string };

/** Payload type per event name, derived from the union above (single
 * source of truth for the trackEvent overloads). */
type EventData<N extends AnalyticsEvent['name']> = Omit<
  Extract<AnalyticsEvent, { name: N }>,
  'name'
>;

/**
 * The env is read at CALL time, not module load, so vitest's vi.stubEnv
 * can drive specs (and a stale answer is never cached). An empty string
 * counts as unset — the Dockerfile's empty ARG defaults must disable
 * analytics exactly like an absent variable.
 */
function analyticsConfig(): { readonly src: string; readonly id: string } | null {
  const src = import.meta.env.VITE_UMAMI_SRC;
  const id = import.meta.env.VITE_UMAMI_ID;
  if (typeof src !== 'string' || src === '') {
    return null;
  }
  if (typeof id !== 'string' || id === '') {
    return null;
  }
  return { src, id };
}

/**
 * Inject the Umami beacon into <head> — once per document, only when BOTH
 * env vars are set. Called from the app shell's mount effect
 * (root-layout); unconfigured environments (dev, test, CI without the
 * build args) never see a script tag.
 */
export function initAnalytics(): void {
  const config = analyticsConfig();
  if (config === null) {
    return;
  }
  if (document.getElementById(UMAMI_SCRIPT_ID) !== null) {
    return;
  }
  const script = document.createElement('script');
  script.id = UMAMI_SCRIPT_ID;
  script.defer = true;
  script.src = config.src;
  script.setAttribute('data-website-id', config.id);
  document.head.appendChild(script);
}

export function trackEvent(name: 'topic-open', data: EventData<'topic-open'>): void;
export function trackEvent(name: 'copy-code', data: EventData<'copy-code'>): void;
export function trackEvent(name: 'demo-run', data: EventData<'demo-run'>): void;
/**
 * Typed wrapper over `window.umami.track(name, data)` — a no-op when
 * analytics is unconfigured (dev/test default) or when the beacon has not
 * loaded yet (`window.umami` undefined: jsdom, pre-load frames, blocked
 * requests). Never throws.
 */
export function trackEvent(
  name: AnalyticsEvent['name'],
  data: Record<string, unknown>,
): void {
  if (analyticsConfig() === null) {
    return;
  }
  window.umami?.track(name, data);
}
