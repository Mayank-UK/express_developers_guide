/**
 * Hand-rolled cookie parse/serialize helpers — the two things a session
 * mechanism needs from cookies and nothing more. Express ships res.cookie()
 * (used by the reqres topic's response-side demo), but the auth demos set and
 * read cookies BY HAND because the raw Set-Cookie header is the lesson: every
 * attribute below changes what a browser does with the cookie, and seeing the
 * exact header string is how those choices become real.
 */

/** The auth demos' session cookie name. */
export const SESSION_COOKIE_NAME = 'guide_session';

/** Parses a Cookie request header (`a=1; b=2`) into a record. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined || header === '') return cookies;

  for (const rawPair of header.split(';')) {
    const pair = rawPair.trim();
    if (pair === '') continue;
    const equalsAt = pair.indexOf('=');
    if (equalsAt <= 0) continue; // attribute-only fragments and malformed pairs
    const name = pair.slice(0, equalsAt).trim();
    const rawValue = pair.slice(equalsAt + 1).trim();
    if (name === '') continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue; // malformed escapes: keep the raw value, never throw
    }
  }
  return cookies;
}

/**
 * Serializes ONE Set-Cookie header for the session cookie with the teaching
 * attribute set: HttpOnly (JS — including an XSS payload — cannot read it),
 * SameSite=Lax (sent on top-level cross-site navigations, withheld on
 * cross-site POSTs — the pragmatic CSRF default), Path=/ (site-wide).
 *
 * Secure is deliberately ABSENT here because the guide serves plain HTTP on
 * localhost — in production behind TLS this line grows `, Secure` (and the
 * __Host- prefix note in the topic content explains the strictest variant).
 */
export function serializeSessionCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * The clearing cookie: an empty value with Max-Age=0 tells the browser to
 * drop the cookie immediately (expires in the past). Same attributes as the
 * setter — a browser may treat a mismatched Path/Domain as a DIFFERENT cookie
 * and keep the original, so clearing must mirror setting.
 */
export function serializeClearingCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Reads one cookie's value from a request's Cookie header (undefined when absent). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  return parseCookieHeader(header)[name];
}
