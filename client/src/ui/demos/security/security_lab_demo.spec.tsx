import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SecurityLabDemo from './security_lab_demo';

afterEach(() => {
  vi.unstubAllGlobals();
});

const HEADERS_URL = '/api/demo/security/headers';
const PING_URL = '/api/demo/security/ping';
const HANDMADE_URL = '/api/demo/security/handmade-ping';

function jsonLike(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  const text = JSON.stringify(body);
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
    json: async () => JSON.parse(text) as unknown,
  };
}

/** The real limiter's behavior, statefully: 5×200 then 429s with Retry-After. */
function stubSecurityServer(
  overrides: {
    headersBody?: unknown;
    pingLimit?: number;
    onPing?: (seq: number) => void;
  } = {},
) {
  const pingLimit = overrides.pingLimit ?? 5;
  let pings = 0;
  let handmade = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === HEADERS_URL) {
      return jsonLike(
        overrides.headersBody ?? {
          headers: {
            'content-security-policy': "default-src 'self'; script-src 'self'",
            'strict-transport-security': 'max-age=31536000; includeSubDomains',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'SAMEORIGIN',
            'referrer-policy': 'no-referrer',
            'x-request-id': 'test-req-id',
          },
        },
      );
    }
    if (url === PING_URL) {
      pings += 1;
      overrides.onPing?.(pings);
      if (pings <= pingLimit) {
        return jsonLike(
          { ok: true, remaining: pingLimit - pings },
          200,
          { 'ratelimit-limit': '5', 'ratelimit-remaining': String(pingLimit - pings) },
        );
      }
      return jsonLike(
        {
          error: {
            code: 'rate_limited',
            message: 'too many requests',
            retryAfterSeconds: 42,
            requestId: 'test',
          },
        },
        429,
        { 'retry-after': '42', 'ratelimit-limit': '5', 'ratelimit-remaining': '0' },
      );
    }
    if (url === HANDMADE_URL) {
      handmade += 1;
      if (handmade <= 3) return jsonLike({ ok: true, count: handmade, remaining: 3 - handmade });
      return jsonLike(
        { error: { code: 'rate_limited', message: 'too many requests', retryAfterSeconds: 21 } },
        429,
        { 'retry-after': '21', 'x-ratelimit-remaining': '0' },
      );
    }
    if (url.startsWith('/api/demo/security/cors-check')) {
      const origin = decodeURIComponent(url.split('origin=')[1] ?? '');
      const allowed = origin === 'https://example.com' || origin === 'http://localhost:5173';
      return jsonLike({
        origin,
        allowed,
        accessControlAllowOrigin: allowed ? origin : null,
        credentials: true,
        note: allowed ? 'on the allowlist' : 'not on the allowlist — the BROWSER blocks',
      });
    }
    if (url.startsWith('/api/demo/security/ssrf-guard')) {
      const target = decodeURIComponent(url.split('url=')[1] ?? '');
      const isMetadata = target.includes('169.254.169.254');
      const isHex = target.includes('0x7f000001');
      const isAllowed = target.includes('httpbin.org');
      return jsonLike({
        url: target,
        allowed: isAllowed,
        kind: isAllowed ? 'allowed' : isMetadata ? 'private_or_loopback_ip' : isHex ? 'ip_literal_evasion' : 'not_allowlisted',
        reason: isAllowed
          ? 'host is on the exact-match allowlist (canonical spelling)'
          : isMetadata
            ? 'link-local (169.254/16) — 169.254.169.254 is the cloud instance-metadata address (the classic SSRF target)'
            : 'hex IP literal (0x7f000001 = 127.0.0.1)',
        host: isAllowed ? 'httpbin.org' : isMetadata ? '169.254.169.254' : '127.0.0.1',
      });
    }
    return jsonLike({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
  });
}

describe('SecurityLabDemo — four panels, real verdicts', () => {
  it('renders the headers table with the security explainers', async () => {
    vi.stubGlobal('fetch', stubSecurityServer());
    render(<SecurityLabDemo />);

    const table = await screen.findByTestId('security-headers-table');
    const rows = screen.getAllByTestId('security-headers-row');
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(table).toHaveTextContent('content-security-policy');
    expect(table).toHaveTextContent('strict-transport-security');
    expect(table).toHaveTextContent('what this page may load/execute');
    expect(table).toHaveTextContent('https only, for max-age seconds');
    expect(table).toHaveTextContent('x-request-id');
  });

  it('trips the rate limit: 8 chips — 200×5 then 429×3 — with Retry-After in the summary', async () => {
    vi.stubGlobal('fetch', stubSecurityServer());
    render(<SecurityLabDemo />);

    await screen.findByTestId('security-headers-table');
    fireEvent.click(screen.getByTestId('security-ping-button'));

    const results = await screen.findByTestId('security-ping-results');
    expect(await screen.findAllByTestId('security-ping-chip')).toHaveLength(8);
    expect(results).toHaveTextContent('200200200200200429429429');

    const summary = screen.getByTestId('security-ping-summary');
    expect(summary).toHaveTextContent('Retry-After: 42');
    expect(summary).toHaveTextContent('RateLimit-Limit: 5');
    expect(summary).toHaveTextContent('RateLimit-Remaining: 0');
    expect(summary).toHaveTextContent('CLIENT IP');
  });

  it('the handmade twin trips at 3 — its own budget, its own chips', async () => {
    vi.stubGlobal('fetch', stubSecurityServer());
    render(<SecurityLabDemo />);

    await screen.findByTestId('security-headers-table');
    fireEvent.click(screen.getByTestId('security-handmade-button'));

    expect(await screen.findAllByTestId('security-handmade-chip')).toHaveLength(4);
    expect(screen.getByTestId('security-handmade-results')).toHaveTextContent('200200200429');
  });

  it('CORS verdicts: allowed origin gets its ACAO, disallowed gets none', async () => {
    vi.stubGlobal('fetch', stubSecurityServer());
    render(<SecurityLabDemo />);

    await screen.findByTestId('security-headers-table');

    // The prefilled allowed origin — one click, one verdict:
    fireEvent.click(screen.getByTestId('security-cors-button'));
    const allowed = await screen.findByTestId('security-cors-verdict');
    expect(allowed).toHaveTextContent('ALLOWED');
    expect(screen.getByTestId('security-cors-acao')).toHaveTextContent('ACAO → https://example.com');

    // Switch to a disallowed origin via the preset chip and re-check:
    fireEvent.click(screen.getByTestId('security-cors-preset-evil'));
    fireEvent.click(screen.getByTestId('security-cors-button'));
    const denied = await screen.findByTestId('security-cors-verdict');
    expect(denied).toHaveTextContent('DENIED');
    expect(screen.getByTestId('security-cors-acao')).toHaveTextContent('(none');
    expect(denied).toHaveTextContent('BROWSER');
  });

  it('SSRF guard denies the cloud metadata IP by name; the allowed host passes', async () => {
    vi.stubGlobal('fetch', stubSecurityServer());
    render(<SecurityLabDemo />);

    await screen.findByTestId('security-headers-table');

    // The input is prefilled with the metadata URL — press check:
    fireEvent.click(screen.getByTestId('security-ssrf-button'));
    const denied = await screen.findByTestId('security-ssrf-verdict');
    expect(denied).toHaveTextContent('DENIED');
    expect(screen.getByTestId('security-ssrf-reason')).toHaveTextContent('169.254.169.254');
    expect(screen.getByTestId('security-ssrf-reason')).toHaveTextContent('metadata');

    // Switch to the allowed host → ALLOWED:
    fireEvent.click(screen.getByTestId('security-ssrf-preset-allowed'));
    fireEvent.click(screen.getByTestId('security-ssrf-button'));
    const ok = await screen.findByTestId('security-ssrf-verdict');
    expect(ok).toHaveTextContent('ALLOWED');

    // And the hex disguise is named for what it is:
    fireEvent.click(screen.getByTestId('security-ssrf-preset-hex'));
    fireEvent.click(screen.getByTestId('security-ssrf-button'));
    const hex = await screen.findByTestId('security-ssrf-verdict');
    expect(hex).toHaveTextContent('DENIED');
    expect(hex).toHaveTextContent('ip_literal_evasion');
  });

  it('degrades to reachable-server messages per panel, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<SecurityLabDemo />);

    expect(await screen.findByTestId('security-headers-failed')).toHaveTextContent(
      'could not reach the server',
    );

    fireEvent.click(screen.getByTestId('security-ping-button'));
    expect(await screen.findByTestId('security-ping-results')).toHaveTextContent(
      'could not reach the server',
    );

    fireEvent.click(screen.getByTestId('security-cors-button'));
    expect(await screen.findByTestId('security-cors-failed')).toHaveTextContent(
      'could not reach the server',
    );

    fireEvent.click(screen.getByTestId('security-ssrf-button'));
    expect(await screen.findByTestId('security-ssrf-failed')).toHaveTextContent(
      'could not reach the server',
    );
  });
});
