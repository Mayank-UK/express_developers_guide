/// <reference types="vite/client" />

/**
 * Narrow the `VITE_*` env vars (Vite's default `ImportMetaEnv` index signature
 * types them as `any`) to `string | undefined` so config parsing is type-checked.
 * Vite only exposes `VITE_`-prefixed vars to client code.
 *
 * VITE_UMAMI_* are PUBLIC by design (an analytics beacon's URL and website
 * id are visible in the served page source anyway): BOTH unset/empty means
 * analytics is disabled — no script injected, trackEvent a complete no-op.
 * See src/ui/analytics/analytics.ts. VITE_FARO_* follow the same
 * discipline for the crash-telemetry beacon (both unset/empty = no script,
 * no initialization — see src/ui/analytics/crash-telemetry.ts).
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ENABLE_LOGS?: string;
  readonly VITE_UMAMI_SRC?: string;
  readonly VITE_UMAMI_ID?: string;
  readonly VITE_FARO_URL?: string;
  readonly VITE_FARO_APP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
