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

/** The injected beacon element (call only after initAnalytics in a
 * configured env — asserts it exists so the cast below is honest). */
function injectedScript(): HTMLScriptElement {
  const scripts = document.querySelectorAll('head script#umami-analytics');
  expect(scripts).toHaveLength(1);
  return scripts[0] as HTMLScriptElement;
}

describe('analytics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete window.umami;
    // Drop anything a test queued while the beacon was absent — the
    // queue is module-level and would otherwise leak into the next
    // test. A detached script's listeners still fire, so the error
    // handler clears it before the element goes away.
    document.getElementById('umami-analytics')?.dispatchEvent(new Event('error'));
    document.getElementById('umami-analytics')?.remove();
  });

  describe('unconfigured = complete no-op', () => {
    it('injects no script tag and trackEvent does not crash, send, or queue', () => {
      const track = installUmami();

      initAnalytics();
      expect(document.querySelectorAll('head script')).toHaveLength(0);

      // No crash without a global, and — stronger — nothing is sent
      // or queued even if some other script happened to install a
      // track global: an unconfigured build never reports.
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
  });

  describe('pre-load event queue (cold deep-link window)', () => {
    it('queues events instead of sending or throwing while the global is absent', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      // Script injected, but jsdom never evaluates it — exactly the
      // cold deep-link race: window.umami still undefined.
      initAnalytics();

      expect(() => trackEvent('topic-open', { topic: 'authentication' })).not.toThrow();

      // The queued event is NOT eagerly flushed by the global merely
      // appearing — only the load event (or a later trackEvent) does.
      const track = installUmami();
      expect(track).not.toHaveBeenCalled();
    });

    it("flushes queued events in order on the script's load event", () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      initAnalytics();

      // Two events queue during the cold window… (topic unique to this
      // test: the topic-open dedupe guard is module-level state and would
      // otherwise swallow a topic another test already fired.)
      trackEvent('topic-open', { topic: 'middleware' });
      trackEvent('copy-code', { topic: '/topics/middleware' });

      // …then the beacon evaluates (jsdom never runs it, so simulate
      // its load event) and its global exists.
      const track = installUmami();
      injectedScript().dispatchEvent(new Event('load'));

      expect(track).toHaveBeenCalledTimes(2);
      expect(track).toHaveBeenNthCalledWith(1, 'topic-open', { topic: 'middleware' });
      expect(track).toHaveBeenNthCalledWith(2, 'copy-code', {
        topic: '/topics/middleware',
      });
    });

    it('drops the queue when the script fails to load (no stale replay)', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      initAnalytics();
      trackEvent('topic-open', { topic: 'deployment' });
      trackEvent('copy-code', { topic: '/topics/deployment' });

      // Blocked beacon: the queue is discarded…
      injectedScript().dispatchEvent(new Event('error'));

      // …so when a global appears anyway (or a later event fires),
      // only the NEW event is sent — nothing replays.
      const track = installUmami();
      trackEvent('demo-run', { demo: 'auth:jwt' });
      expect(track).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenNthCalledWith(1, 'demo-run', { demo: 'auth:jwt' });
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
      // compiles against its overload (no dynamic strings). Topic unique
      // to this test (dedupe guard is module-level state).
      trackEvent('topic-open', { topic: 'routing' });
      trackEvent('copy-code', { topic: '/topics/routing' });
      trackEvent('demo-run', { demo: 'auth:jwt' });

      expect(track).toHaveBeenCalledTimes(3);
      expect(track).toHaveBeenNthCalledWith(1, 'topic-open', { topic: 'routing' });
      expect(track).toHaveBeenNthCalledWith(2, 'copy-code', { topic: '/topics/routing' });
      expect(track).toHaveBeenNthCalledWith(3, 'demo-run', { demo: 'auth:jwt' });
    });
  });

  describe('topic-open dedupe (view-remount double-fire guard)', () => {
    it('collapses a second topic-open for the same topic within the window', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      const track = installUmami();

      trackEvent('topic-open', { topic: 'observability' });
      // The remount case: same topic re-fired seconds later.
      trackEvent('topic-open', { topic: 'observability' });

      expect(track).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenNthCalledWith(1, 'topic-open', { topic: 'observability' });
    });

    it('sends again for the same topic once the window has passed', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      const track = installUmami();

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
      trackEvent('topic-open', { topic: 'best-practices' });
      vi.setSystemTime(new Date('2026-10-24T12:00:31Z'));
      trackEvent('topic-open', { topic: 'best-practices' });
      vi.useRealTimers();

      expect(track).toHaveBeenCalledTimes(2);
    });

    it('does not suppress different topics in the same window', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      const track = installUmami();

      trackEvent('topic-open', { topic: 'performance' });
      trackEvent('topic-open', { topic: 'api-design' });

      expect(track).toHaveBeenCalledTimes(2);
    });

    it('never suppresses repeated copy-code or demo-run (guard is topic-open only)', () => {
      vi.stubEnv('VITE_UMAMI_SRC', SRC);
      vi.stubEnv('VITE_UMAMI_ID', ID);
      const track = installUmami();

      trackEvent('copy-code', { topic: '/topics/messaging' });
      trackEvent('copy-code', { topic: '/topics/messaging' });
      trackEvent('demo-run', { demo: 'db:sql-lab' });
      trackEvent('demo-run', { demo: 'db:sql-lab' });

      expect(track).toHaveBeenCalledTimes(4);
    });
  });
});
