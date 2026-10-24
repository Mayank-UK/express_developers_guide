import { afterEach, describe, expect, it, vi } from 'vitest';
import { initAnalytics, trackEvent } from './analytics';

/* Both vars non-empty = configured; every other combination must disable
 * analytics entirely (the dev/test/default path). The env is stubbed per
 * test because the module reads it at CALL time — see analyticsConfig. */
const SRC = 'https://umami.mayankcodeworks.com/script.js';
const ID = 'e6c1f2a3-8b4d-4c9e-9f0a-1b2c3d4e5f67';

/** Installs a capturing stand-in for the beacon's global and returns the
 * track spy — the loader never runs in jsdom, so the global is whatever a
 * test puts there. */
function installUmami(): ReturnType<typeof vi.fn> {
  const track = vi.fn();
  window.umami = { track };
  return track;
}

describe('analytics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete window.umami;
    document.getElementById('umami-analytics')?.remove();
  });

  describe('unconfigured = complete no-op', () => {
    it('injects no script tag and trackEvent does not crash or send', () => {
      const track = installUmami();

      initAnalytics();
      expect(document.querySelectorAll('head script')).toHaveLength(0);

      // No crash without a global, and — stronger — nothing is sent
      // even if some other script happened to install one: an
      // unconfigured build never reports.
      trackEvent('topic-open', { topic: 'authentication' });
      expect(track).not.toHaveBeenCalled();
    });

    it('stays a no-op when only ONE of the two vars is set', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      initAnalytics();
      expect(document.querySelectorAll('head script')).toHaveLength(0);

      vi.stubEnv('VITE_UMAMI_ID', ID);
      vi.stubEnv('VITE_UMAMI_SRC', '');
      initAnalytics();
      expect(document.querySelectorAll('head script')).toHaveLength(0);
    });

    it('trackEvent is a no-op without the beacon global (jsdom-safe)', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      // window.umami undefined — must not throw.
      expect(() => trackEvent('copy-code', { topic: '/topics/authentication' })).not.toThrow();
    });
  });

  describe('configured beacon', () => {
    it('injects exactly one deferred script tag with both attributes', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);

      initAnalytics();
      // Repeated calls (StrictMode double-mount, remounts) never
      // stack a second beacon.
      initAnalytics();
      initAnalytics();

      const scripts = document.querySelectorAll('head script#umami-analytics');
      expect(scripts).toHaveLength(1);
      const script = scripts[0] as HTMLScriptElement;
      expect(script.getAttribute('src')).toBe(SRC);
      expect(script.getAttribute('data-website-id')).toBe(ID);
      expect(script.defer).toBe(true);
    });

    it('trackEvent passes name + data straight through to the beacon', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      const track = installUmami();

      // One call per union member — also proves each payload shape
      // compiles against its overload (no dynamic strings).
      trackEvent('topic-open', { topic: 'authentication' });
      trackEvent('copy-code', { topic: '/topics/authentication' });
      trackEvent('demo-run', { demo: 'auth:jwt' });

      expect(track).toHaveBeenCalledTimes(3);
      expect(track).toHaveBeenNthCalledWith(1, 'topic-open', { topic: 'authentication' });
      expect(track).toHaveBeenNthCalledWith(2, 'copy-code', { topic: '/topics/authentication' });
      expect(track).toHaveBeenNthCalledWith(3, 'demo-run', { demo: 'auth:jwt' });
    });
  });
});
