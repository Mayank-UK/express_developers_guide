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
 *
 * The beacon script is async (defer + runtime-inserted): events emitted in
 * the window between injection and evaluation — exactly a cold deep link's
 * mount-time `topic-open` — find `window.umami` still undefined. Those
 * events are QUEUED in order and flushed by the script's load event (or by
 * the next trackEvent once the global exists); a failed/blocked load drops
 * the queue so nothing leaks or replays stale.
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
 * Events captured before the beacon finished evaluating, in emission
 * order. Drained by the script's load event or by the first trackEvent
 * that sees the global — without this, mount-time events on cold deep
 * links would race the async script and silently drop.
 */
const pendingEvents: Array<[AnalyticsEvent['name'], Record<string, unknown>]> = [];

/**
 * Drain the queue in order through the beacon. The queue is cleared
 * BEFORE sending so a re-entrant flush (a track call that itself fires
 * trackEvent) can never double-send an entry.
 */
function flushPendingEvents(): void {
  if (pendingEvents.length === 0) {
    return;
  }
  const queued = pendingEvents.splice(0, pendingEvents.length);
  for (const [name, data] of queued) {
    window.umami?.track(name, data);
  }
}

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

/** localStorage key for the per-browser visitor identity (see getDistinctId). */
const VISITOR_ID_STORAGE_KEY = 'mcw_vid';

/**
 * Stable per-browser visitor id, generated on first read and persisted in
 * localStorage. Rendered as the beacon's data-distinct-id attribute, which
 * the Umami tracker picks up when the script evaluates (auto-identify) —
 * this stitches one visitor back together across IP churn instead of
 * leaving that to Umami's IP+UA fingerprint.
 */
function getDistinctId(): string | undefined {
  // localStorage throws in privacy modes / sandboxed frames / blocked
  // storage — the beacon must still work, just without a stable id.
  try {
    const existing = localStorage.getItem(VISITOR_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const id =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'v-' +
          Date.now() +
          '-' +
          Math.random().toString(36).slice(2) +
          Math.random().toString(36).slice(2);
    localStorage.setItem(VISITOR_ID_STORAGE_KEY, id);
    return id;
  } catch {
    return undefined;
  }
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
  // Must be set BEFORE append: the tracker reads data-distinct-id off the
  // tag as it executes and fires its identify call then and there.
  const vid = getDistinctId();
  if (vid) {
    script.setAttribute('data-distinct-id', vid);
  }
  document.head.appendChild(script);
  // Async beacon: load → flush what queued during the cold-start window;
  // error (blocked/failed request) → drop the queue, never replay it.
  script.addEventListener('load', flushPendingEvents);
  script.addEventListener('error', () => {
    pendingEvents.length = 0;
  });
}

/** topic-open is once-per-topic-per-window by contract: a remount or refetch
 * must not double-count a single visit (proven live on a sibling guide: a
 * pathname-keyed effect re-ran on layout remount and fired twice 8s apart).
 * Rapid genuine re-opens inside the window are intentionally collapsed into
 * one event. */
const TOPIC_OPEN_DEDUPE_WINDOW_MS = 30_000;
const lastTopicOpenAt = new Map<string, number>();

function isDuplicateTopicOpen(topic: string): boolean {
  const now = Date.now();
  const at = lastTopicOpenAt.get(topic);
  if (at !== undefined && now - at < TOPIC_OPEN_DEDUPE_WINDOW_MS) {
    return true;
  }
  lastTopicOpenAt.set(topic, now);
  return false;
}

export function trackEvent(name: 'topic-open', data: EventData<'topic-open'>): void;
export function trackEvent(name: 'copy-code', data: EventData<'copy-code'>): void;
export function trackEvent(name: 'demo-run', data: EventData<'demo-run'>): void;
/**
 * Typed wrapper over `window.umami.track(name, data)` — a no-op when
 * analytics is unconfigured (dev/test default). When the beacon has not
 * evaluated yet (`window.umami` undefined: jsdom, the cold-start frames
 * after injection, blocked requests) the event is QUEUED and flushed in
 * order once the script loads — a failed script drops the queue. Never
 * throws.
 */
export function trackEvent(
  name: AnalyticsEvent['name'],
  data: Record<string, unknown>,
): void {
  if (analyticsConfig() === null) {
    return;
  }
  if (name === 'topic-open' && isDuplicateTopicOpen(String(data.topic))) {
    return;
  }
  if (typeof window.umami?.track !== 'function') {
    pendingEvents.push([name, data]);
    return;
  }
  // Flush-first so earlier queued events keep their chronological place
  // ahead of this one.
  flushPendingEvents();
  window.umami.track(name, data);
}
