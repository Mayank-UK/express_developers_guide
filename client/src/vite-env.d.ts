/// <reference types="vite/client" />

/**
 * Narrow the `VITE_*` env vars (Vite's default `ImportMetaEnv` index signature
 * types them as `any`) to `string | undefined` so config parsing is type-checked.
 * Vite only exposes `VITE_`-prefixed vars to client code.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ENABLE_LOGS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
