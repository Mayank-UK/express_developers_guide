/**
 * Grafana Faro browser-crash telemetry — a runtime beacon loader, the
 * canary for frontend observability. NO npm dependency: the SDK is the
 * official CDN IIFE bundle (jsdelivr, pinned to major @1 — same
 * philosophy as the env-driven Umami beacon in analytics.ts), injected
 * into <head> as a plain `<script defer>` once per document and
 * initialized with the MINIMAL config once it evaluates.
 *
 * CONFIGURATION (Vite build-time env — values are baked into the bundle at
 * build time, hence the Dockerfile ARG/ENV plumbing):
 * - `VITE_FARO_URL` — the collector endpoint (e.g. https://faro…/collect)
 * - `VITE_FARO_APP` — the app name registered with the collector
 *
 * BOTH must be non-empty for telemetry to exist at all. The dev/test
 * default (both unset) is a COMPLETE no-op: no script tag is injected and
 * nothing initializes — byte-clean, exactly the Umami discipline. Both
 * values are PUBLIC (the browser ships them to the collector anyway), so
 * they ride repository variables, never secrets.
 *
 * The CDN bundle installs `window.GrafanaFaroWebSdk` — NOT `window.Faro`
 * (that shape is Grafana's outdated docs; verified against the shipped @1
 * bundle and the official use-cdn-library tutorial). `initializeFaro`'s
 * DEFAULTS already capture uncaught errors (captureErrors on by default);
 * we pass only url + app — no transports, no tracing, no extra
 * instrumentations — keeping the payload minimal.
 */

/**
 * The pinned-major CDN bundle. Unlike the Umami src (deployment-specific),
 * the SDK URL is a constant — only the collector endpoint and app name
 * vary per deployment, so they are the env vars.
 */
const FARO_SDK_SRC =
  'https://cdn.jsdelivr.net/npm/@grafana/faro-web-sdk@1/dist/bundle/faro-web-sdk.iife.js';

/** Marks the injected beacon so initCrashTelemetry stays idempotent per
 * document (StrictMode's dev double-mount, remounts). */
const FARO_SCRIPT_ID = 'faro-crash-telemetry';

/** The SDK's global handle — absent until the bundle evaluates (and
 * forever, when telemetry is unconfigured). Narrowed to the one method we
 * call; the real object carries more, never less. */
declare global {
  interface Window {
    GrafanaFaroWebSdk?: {
      initializeFaro: (config: {
        url: string;
        app: { name: string; environment: string };
      }) => void;
    };
  }
}

/**
 * The env is read at CALL time, not module load, so vitest's vi.stubEnv
 * can drive specs (and a stale answer is never cached). An empty string
 * counts as unset — the Dockerfile's empty ARG defaults must disable
 * telemetry exactly like an absent variable.
 */
function crashTelemetryConfig(): { readonly url: string; readonly app: string } | null {
  const url = import.meta.env.VITE_FARO_URL;
  const app = import.meta.env.VITE_FARO_APP;
  if (typeof url !== 'string' || url === '') {
    return null;
  }
  if (typeof app !== 'string' || app === '') {
    return null;
  }
  return { url, app };
}

/**
 * Inject the Faro beacon into <head> — once per document, only when BOTH
 * env vars are set. Called from the app shell's mount effect
 * (root-layout); unconfigured environments (dev, test, CI without the
 * build args) never see a script tag. initializeFaro runs on the bundle's
 * load event — the global only exists once the bundle evaluated — so the
 * config is captured in the closure at injection time (the baked value).
 */
export function initCrashTelemetry(): void {
  const config = crashTelemetryConfig();
  if (config === null) {
    return;
  }
  if (document.getElementById(FARO_SCRIPT_ID) !== null) {
    return;
  }
  const script = document.createElement('script');
  script.id = FARO_SCRIPT_ID;
  script.defer = true;
  script.src = FARO_SDK_SRC;
  document.head.appendChild(script);
  // Bundle evaluated → global appeared → initialize once with the minimal
  // payload. A failed/blocked load simply never initializes (once: true
  // also makes a stray duplicate load event inert).
  script.addEventListener(
    'load',
    () => {
      window.GrafanaFaroWebSdk?.initializeFaro({
        url: config.url,
        app: { name: config.app, environment: 'production' },
      });
    },
    { once: true },
  );
}
