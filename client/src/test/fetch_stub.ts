import { vi } from 'vitest';

/**
 * URL-dispatching fetch stub for jsdom specs: each route matches an exact
 * request URL and answers either as JSON (body) or as raw text with headers
 * (text + headers — for components that read response.text() and headers).
 * Any unstubbed URL answers with a 404 error envelope so a missing mock fails
 * loudly instead of hanging. Callers must `vi.unstubAllGlobals()` in
 * afterEach — this file deliberately does not own test lifecycle hooks.
 */

export interface StubRoute {
  url: string;
  /**
   * When set, the route only answers requests with this HTTP method — for
   * endpoints where GET and POST share a URL but answer differently.
   * Unset routes match any method (the historical behavior).
   */
  method?: string;
  status?: number;
  /** JSON body — the stub answers with json(). */
  body?: unknown;
  /**
   * When set, the stub answers with a text body plus response headers
   * (case-insensitive get()) instead of JSON — for streaming-style endpoints.
   */
  text?: string;
  headers?: Record<string, string>;
}

export function stubApiFetch(routes: readonly StubRoute[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      // A route without an explicit method matches ANY method (the historical
      // behavior); a method-pinned route only answers that method (with an
      // absent init.method counting as GET, fetch's own default).
      const method = init?.method ?? 'GET';
      const route = routes.find(
        (candidate) =>
          candidate.url === url &&
          (candidate.method === undefined || candidate.method === method),
      );
      if (route === undefined) {
        return jsonResponse({ error: { code: 'not_found', message: `no fetch stub for ${url}` } }, 404);
      }
      if (route.text !== undefined) {
        return textResponse(route.text, route.headers ?? {}, route.status ?? 200);
      }
      return jsonResponse(route.body, route.status ?? 200);
    }),
  );
}

/** A fetch that never leaves the machine: exercises the status-0 error path. */
export function stubNetworkFailure(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
}

/**
 * Minimal Response stand-in: the API layer only reads `ok`, `status`, and
 * `json()`, so a plain object keeps the stub independent of whether the test
 * environment provides the real Response global.
 */
function jsonResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * Minimal text Response stand-in: adds `text()` and case-insensitive
 * `headers.get(name)` (null when absent — the real Headers contract), for
 * components that consume raw bodies and response headers. Also exposes
 * `headers.entries()` so components that ITERATE response headers (the real
 * Headers contract supports it) work against the stub unmodified.
 */
function textResponse(text: string, headers: Record<string, string>, status: number) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string): string | null => lower[name.toLowerCase()] ?? null,
      entries: (): Array<[string, string]> => Object.entries(lower),
    },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}
