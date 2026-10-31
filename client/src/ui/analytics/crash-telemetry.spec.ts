import { afterEach, describe, expect, it, vi } from 'vitest';
import { initCrashTelemetry } from './crash-telemetry';

/* Both vars non-empty = configured; every other combination must disable
 * telemetry entirely (the dev/test/default path). The env is stubbed per
 * test because the module reads it at CALL time — see crashTelemetryConfig. */
const COLLECTOR_URL = 'https://faro.mayankcodeworks.com/collect';
const APP_NAME = 'expressdevelopersguide';

/** The pinned CDN bundle the loader must inject — pinned HERE as a literal
 * (not imported from the module) so a careless URL edit fails this spec,
 * not production. */
const CDN_SRC =
  'https://cdn.jsdelivr.net/npm/@grafana/faro-web-sdk@1/dist/bundle/faro-web-sdk.iife.js';

/** Installs a capturing stand-in for the SDK's global and returns the
 * initializeFaro spy — the bundle never runs in jsdom, so the global is
 * whatever a test puts there. */
function installFaro(): ReturnType<typeof vi.fn> {
  const initializeFaro = vi.fn();
  window.GrafanaFaroWebSdk = { initializeFaro };
  return initializeFaro;
}

/** The injected beacon element (call only after initCrashTelemetry in a
 * configured env — asserts it exists so the cast below is honest). */
function injectedScript(): HTMLScriptElement {
  const scripts = document.querySelectorAll('head script#faro-crash-telemetry');
  expect(scripts).toHaveLength(1);
  return scripts[0] as HTMLScriptElement;
}

describe('crash telemetry (Faro beacon)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete window.GrafanaFaroWebSdk;
    document.getElementById('faro-crash-telemetry')?.remove();
  });

  describe('unconfigured = complete no-op', () => {
    it('injects no script tag', () => {
      initCrashTelemetry();
      expect(document.querySelectorAll('head script')).toHaveLength(0);
    });

    it('stays a no-op when only ONE of the two vars is set', () => {
      vi.stubEnv('VITE_FARO_URL', COLLECTOR_URL);
      initCrashTelemetry();
      expect(document.querySelectorAll('head script')).toHaveLength(0);

      vi.stubEnv('VITE_FARO_APP', APP_NAME);
      vi.stubEnv('VITE_FARO_URL', '');
      initCrashTelemetry();
      expect(document.querySelectorAll('head script')).toHaveLength(0);
    });
  });

  describe('configured beacon', () => {
    it('injects exactly one deferred script tag pinned to the major-1 CDN bundle', () => {
      vi.stubEnv('VITE_FARO_URL', COLLECTOR_URL);
      vi.stubEnv('VITE_FARO_APP', APP_NAME);

      initCrashTelemetry();
      // Repeated calls (StrictMode double-mount, remounts) never stack a
      // second beacon.
      initCrashTelemetry();
      initCrashTelemetry();

      const script = injectedScript();
      expect(script.getAttribute('src')).toBe(CDN_SRC);
      expect(script.defer).toBe(true);
    });

    it("initializes once with url + app name on the bundle's load event", () => {
      vi.stubEnv('VITE_FARO_URL', COLLECTOR_URL);
      vi.stubEnv('VITE_FARO_APP', APP_NAME);
      initCrashTelemetry();

      // The bundle evaluates (jsdom never runs it, so simulate its load
      // event) and its global appears.
      const initializeFaro = installFaro();
      injectedScript().dispatchEvent(new Event('load'));
      // A stray duplicate load event is inert (once: true).
      injectedScript().dispatchEvent(new Event('load'));

      expect(initializeFaro).toHaveBeenCalledTimes(1);
      expect(initializeFaro).toHaveBeenCalledWith({
        url: COLLECTOR_URL,
        app: { name: APP_NAME, environment: 'production' },
      });
    });

    it('does not throw or initialize when the global is still absent at load', () => {
      vi.stubEnv('VITE_FARO_URL', COLLECTOR_URL);
      vi.stubEnv('VITE_FARO_APP', APP_NAME);
      initCrashTelemetry();

      expect(() => injectedScript().dispatchEvent(new Event('load'))).not.toThrow();

      const initializeFaro = installFaro();
      expect(initializeFaro).not.toHaveBeenCalled();
    });

    it('never initializes when the bundle fails to load (blocked/failed request)', () => {
      vi.stubEnv('VITE_FARO_URL', COLLECTOR_URL);
      vi.stubEnv('VITE_FARO_APP', APP_NAME);
      initCrashTelemetry();

      injectedScript().dispatchEvent(new Event('error'));

      const initializeFaro = installFaro();
      expect(initializeFaro).not.toHaveBeenCalled();
    });
  });
});
