import type { Topic } from '../types.js';

/**
 * The Authentication topic, complete: PART 1 = sessions + API keys (hand-rolled
 * session store, HttpOnly cookie login flow you can complete in the UI, fixed
 * demo keys with scopes); PART 2 = JWTs (hand-rolled HS256) and OAuth 2.0 (a
 * local authorization-code provider with a real consent page), plus the
 * decision section comparing all three credential families.
 */
export const topicAuthentication: Topic = {
  id: 'authentication',
  title: 'Authentication',
  subtitle:
    'Sessions, JWTs, OAuth, and API keys — proving who the caller is, with working login flows.',
  group: 'auth-security',
  order: 1,
  sections: [
    {
      id: 'auth-what-it-is',
      title: 'What authentication is (and isn\'t)',
      lead: 'Authentication answers WHO is calling (authn). Authorization answers WHAT they may do (authz) — the authorization topic owns the second question. Confusing the two is how "check the user is logged in" ends up guarding admin endpoints.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-what-it-is:definition',
          body: `AUTHENTICATION (authn) is the act of verifying a claimed identity: the caller says "I am alice" and presents EVIDENCE — a password, a key, a signed token — and the server checks that evidence against what it knows. The output is an identity: a username, a user id, a machine id. WHAT THAT IDENTITY MAY DO is a different question — authorization (authz) — and it is asked on EVERY request, per resource: alice may delete this post, carol may not. Same two words in "auth", two completely different jobs; this topic builds the first (who), and the authorization topic builds the second (may). The classic failure of conflating them: an endpoint that checks "is there a valid session?" and calls it access control — logged-in carol passes too, and the bug ships. THE THREE FACTORS authentication evidence comes in: KNOWLEDGE (something you know — a password, a PIN), POSSESSION (something you have — an API key, a phone, a hardware token), and INHERENCE (something you are — biometrics). Two different factors together are two-factor authentication (2FA/MFA): a password plus a one-time code from a phone is knowledge + possession, so stealing just the database of passwords is not enough. Every mechanism in this topic is single-factor by design — the lesson is the machinery, not the strength — and the security topic returns to MFA properly. WHERE AUTH LIVES IN THIS APP'S LAYERING: identity is a DOMAIN concept (server/src/domain/auth/demo_users.ts owns the user records, their roles and API keys; session_store.ts owns the session state), while CHECKING credentials sits at the PRESENTATION edge — the auth demo routes read the cookie or the x-api-key header, consult the domain, and either reject with the standard 401/403 envelope or attach an identity to the request. That split is the dependency rule doing its job: routes know HTTP, the domain knows identity, and neither reaches into the other's pocket. A production app factors the edge-check into middleware (requireSession / requireScope) so every protected route gets it identically — the middleware topic built exactly that pattern, and the authorization topic will reuse this same fixture to gate with it.`,
        },
      ],
    },
    {
      id: 'auth-session-model',
      title: 'The session model',
      lead: 'The server remembers; the browser carries a claim ticket. Login creates state on the server and hands back an opaque token in a cookie; every later request presents the cookie and the server looks the token up. Logout deletes the state. That is the whole machine.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-session-model:lifecycle',
          body: `THE MODEL: server-side state plus an opaque cookie token. LOGIN: the server verifies credentials, creates a session record (a random 32-byte token as the key, the username, a createdAt, an expiresAt 30 minutes out), stores it, and sends the token back in a Set-Cookie header. EVERY LATER REQUEST: the browser attaches the cookie automatically; the server parses it, looks the token up in the store, checks the expiry, and — hit — knows exactly who is calling without the password ever crossing the wire again. LOGOUT: delete the store entry; the cookie becomes a claim ticket for a session that no longer exists, and every subsequent request is anonymous again (the demo also clears the cookie so the browser stops sending it). WHY THE TOKEN IS OPAQUE AND RANDOM: it carries NO information — it is pure pointer. Nothing can be learned from it except by asking the server that issued it, which is precisely what makes revocation trivial (delete the row) and forgery hopeless (32 bytes of crypto randomness — guessing is not a strategy). Contrast that with JWTs, where the token itself CARRIES the identity signed but not encrypted — Part 2's story. EXPIRY IS LAZY in this app's store: getSession() checks the clock on every read and DELETES an expired entry the moment it is touched, plus a sweep runs whenever a new session is created — no timers, no background jobs, and the store never serves a stale entry. Production adds a periodic sweep for entries nobody ever touches again (or, with a Redis store, a per-key TTL where the server does the deleting for you). THE HONEST SCALING CAVEAT — read it twice: this store is IN-MEMORY, so its state is PER-PROCESS. Start two app replicas behind a load balancer and a login that lands on replica A produces a cookie replica B has never heard of: the user is logged in and logged out at the same time, depending on which hop answers. The production answers, in order of frequency: (1) a SHARED store — Redis with TTLs is the canonical session store, and this guide's Redis topic builds exactly that machinery (keys with expirations, the lazy-or-server-side TTL question answered live); (2) sticky sessions at the load balancer (pin each user to one replica — a patch that survives one replica dying); (3) stateless tokens — JWTs, Part 2 — which trade revocability for scale. The demo store also caps itself at 100 sessions, evicting the oldest, because an unbounded Map is a slow-motion memory leak that production stores solve with the same expiry discipline.`,
        },
        {
          kind: 'code',
          id: 'auth-session-model:verbatim-store',
          language: 'ts',
          source: 'server/src/domain/auth/session_store.ts',
          caption: 'Verbatim — the session store\'s core (domain/auth/session_store.ts): creation, lazy expiry, and the cap',
          code: `// Every response echoes a MASK — never the token:
export function maskSessionToken(token: string): string {
  return \`…\${token.slice(-4)}\`;
}

// CREATE — token is 32 random bytes, urlsafe base64: unguessable, opaque.
export function createSession(
  username: string,
  options: CreateSessionOptions = {},
): StoredSession {
  sweepExpiredSessions();                       // auto-cleanup on every create
  while (sessions.size >= MAX_SESSIONS) {       // cap 100: evict the OLDEST
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  const createdAt = Date.now();
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;  // 30 min; ttlMs exists for
  const session: StoredSession = {                // the expiry SPECS only
    token: randomBytes(32).toString('base64url'),
    username,
    createdAt,
    expiresAt: createdAt + ttlMs,
  };
  sessions.set(session.token, session);
  return session;
}

// READ — LAZY EXPIRY: an expired session is deleted the moment it is touched,
// then reported absent. No timer — correctness from one check.
export function getSession(token: string): StoredSession | null {
  const session = sessions.get(token);
  if (session === undefined) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}`,
        },
      ],
    },
    {
      id: 'auth-cookies',
      title: 'Cookies done right',
      lead: 'The session cookie is the one piece of auth state that lives on the CLIENT — so the cookie\'s attributes are a security policy, not a formality. HttpOnly, Secure, SameSite, Path: each attribute is a threat it neutralizes.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-cookies:attributes',
          body: `THE REAL SET-COOKIE THIS APP ISSUES ON LOGIN: guide_session=<43-char-token>; Path=/; HttpOnly; SameSite=Lax — hand-serialized in cookie_utils.ts, not res.cookie(), because the raw header is the lesson. WHAT EACH ATTRIBUTE BUYS: HTTPONLY — the browser withholds this cookie from document.cookie and every other JavaScript API, which defuses the most common post-XSS move: an injected script that exfiltrates session cookies. With HttpOnly, the script can still MAKE REQUESTS in the victim's session (the cookie rides them — XSS is not magically solved), but it cannot READ the token and ship it to the attacker's server. The login demo leans on this honestly: the page's own JS cannot show you the cookie, and that limitation IS the feature. SECURE — the cookie is only ever sent over HTTPS, so a token can never leak onto plain HTTP where anyone on the wire reads it. This guide serves localhost HTTP, so the attribute is deliberately absent HERE — but its absence is the one line you must change behind TLS in production, and the deployment topic's reverse proxy makes it real. SAMESITE — a cross-site request policy that is the cheapest CSRF defense there is: Lax (this app's choice, and the modern browser default) sends the cookie on top-level navigations (clicking a link from another site to your app works) but WITHHOLDS it on cross-site POSTs — the exact shape of a CSRF attack, where evil.com's form posts to your-bank.com while your browser helpfully attaches the session. STRICT withholds it on top-level navigation too (following a link from a chat app logs the clicker in "fresh") — maximum isolation, occasionally spooky UX. NONE disables the protection entirely and REQUIRES Secure — the cross-site embedding case (third-party checkout iframes), to be chosen knowingly and rarely. PATH=/ — the cookie is scoped to the whole site, which for a session cookie is what you want; a narrower path only narrows where the browser SENDS it, it is not a security boundary. THE COOKIE PREFIXES, one note each: a cookie named __Host- MUST be set with Secure, Path=/, and no Domain attribute — browsers refuse to accept it otherwise, which makes the prefix a tamper-guard against subdomains sneaking cookies onto your origin; __Secure- is the softer "must be Secure" variant. A DOMAIN attribute, deliberately absent here, would WIDEN the cookie to sibling subdomains (app.example.com and api.example.com share it) — exactly what __Host- exists to prevent, so set Domain only when you truly mean it. THE CLEARING COOKIE on logout mirrors the setter's attributes exactly (guide_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0): cookies are identified by name AND attributes, so a clearing cookie with a different Path would create a SECOND cookie and leave the original alive — a real logout bug, and the reason clearing must mirror setting.`,
        },
        {
          kind: 'code',
          id: 'auth-cookies:verbatim-serialize',
          language: 'ts',
          source: 'server/src/presentation/middleware/cookie_utils.ts',
          caption: 'Verbatim — the two header serializers and the request-side parser (presentation/middleware/cookie_utils.ts)',
          code: `// Parsing the request side — Cookie: a=1; b=2 → a record. Split on ';', then
// on the FIRST '=' (values may contain '='), decode, never throw:
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined || header === '') return cookies;
  for (const rawPair of header.split(';')) {
    const pair = rawPair.trim();
    if (pair === '') continue;
    const equalsAt = pair.indexOf('=');
    if (equalsAt <= 0) continue;
    const name = pair.slice(0, equalsAt).trim();
    const rawValue = pair.slice(equalsAt + 1).trim();
    if (name === '') continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;   // malformed escapes: keep raw, never throw
    }
  }
  return cookies;
}

// Setting: the exact attribute set, hand-serialized — Secure is absent
// because the guide serves plain HTTP on localhost; behind TLS this line
// grows ", Secure".
export function serializeSessionCookie(name: string, value: string): string {
  return \`\${name}=\${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax\`;
}

// Clearing: EMPTY value + Max-Age=0 (expires immediately). Attributes mirror
// the setter — a mismatched Path would be a DIFFERENT cookie, and the real
// one would survive the "logout".
export function serializeClearingCookie(name: string): string {
  return \`\${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0\`;
}`,
        },
      ],
    },
    {
      id: 'auth-login-flow',
      title: 'The login flow in this app',
      lead: 'A walkthrough of the real code the demo runs: the login controller, the session store it creates, and the constant-time password compare — with the timing attack it exists to stop.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-login-flow:walkthrough',
          body: `THE FLOW, REQUEST BY REQUEST. (1) The login panel (or curl) POSTs {username, password} to /api/demo/auth/login — the password is the fixed teaching value guide-demo-pw, shown right in the user picker, because completing a REAL login flow is the demo's whole point. (2) The controller parses and validates the body (a 400 validation envelope for anything malformed), looks the username up in the fixture, and compares the password in CONSTANT TIME (below). (3) On success it calls createSession(username), sets the Set-Cookie header with the serialized session cookie, and answers 200 {user, session} — where session carries only expiresAt and a MASKED token (…last4). The full token crosses the wire exactly once, inside that HttpOnly cookie, and never appears in any JSON body — check the sessions list and /me: masked everywhere. (4) Every subsequent request from the browser carries the cookie automatically (same-origin fetch does this by default — no code on the client manages it, which is the point); /me parses it, resolves the live session, and answers with the identity — or the standard 401 envelope when there is no session, an expired one, or a forged token. (5) Logout destroys the store entry and sets the clearing cookie; the old token is dead server-side even if a malicious client kept a copy — revocation is DELETE, the whole reason sessions are revocable at all. THE TIMING ATTACK, and why the compare is constant-time: a naive password check (candidate === expected, or a memcmp that bails at the first wrong byte) takes MICROSCOPICALLY longer the more leading characters match — and over a network, statistical noise can be averaged away by an attacker who sends thousands of requests and watches response times: every additional correct leading byte shifts the mean, and the password falls byte by byte without a single guess being "accepted". The fix is to make every comparison take the same time regardless of where (or whether) the strings differ: node:crypto's timingSafeEqual compares two buffers in a fixed number of operations. But timingSafeEqual THROWS when the buffers differ in length — and catching that leak would just reintroduce the signal through the error path — so demo_users.ts hashes BOTH sides with sha256 first (a digest is always 32 bytes) and compares the digests: match, mismatch, and length-mismatch paths all run in indistinguishable time. The same trick powers the webhooks topic's HMAC check. ONE MORE ENUMERATION GUARD: when the USERNAME is unknown, the controller still burns the same constant-time compare against a dummy password, and both failures return the identical 401 "invalid username or password" — otherwise an attacker could list valid usernames by timing (or by differing error messages), then concentrate password attacks on accounts that exist.`,
        },
        {
          kind: 'code',
          id: 'auth-login-flow:verbatim-login',
          language: 'ts',
          source: 'server/src/presentation/routes/auth_demo_routes.ts',
          caption: 'Verbatim — the login controller (presentation/routes/auth_demo_routes.ts)',
          code: `function loginController(req: Request, res: Response): void {
  const { username, password } = parseLoginBody(req.body);   // 400s malformed input

  // Timing-equalized verification: an unknown username burns the SAME
  // constant-time compare as a wrong password (see demo_users.ts), so the
  // endpoint cannot be used to enumerate valid usernames by response time.
  const user = findUser(username);
  const passwordOk =
    user !== undefined ? verifyPassword(user, password) : verifyDummyPassword(password);
  if (user === undefined || !passwordOk) {
    // ONE message for both failures — never reveal which half was wrong.
    throw new UnauthorizedException('invalid username or password', { scheme: 'session' });
  }

  const session = createSession(user.username);

  // Hand-rolled Set-Cookie (not res.cookie): the raw header is the lesson —
  // HttpOnly + SameSite=Lax + Path=/, serialized by cookie_utils.ts.
  res.setHeader('Set-Cookie', serializeSessionCookie(SESSION_COOKIE_NAME, session.token));
  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    session: {
      expiresAt: new Date(session.expiresAt).toISOString(),
      tokenMasked: toSessionPublicView(session).tokenMasked,   // masked — never the token
    },
  });
}`,
        },
        {
          kind: 'code',
          id: 'auth-login-flow:verbatim-compare',
          language: 'ts',
          source: 'server/src/domain/auth/demo_users.ts',
          caption: 'Verbatim — the constant-time compare (domain/auth/demo_users.ts)',
          code: `// BOTH sides are hashed to a fixed length first, then compared with
// node:crypto's timingSafeEqual. Hashing solves the two traps of a naive
// timingSafeEqual(a, b) over raw strings:
// (1) timingSafeEqual THROWS when the buffers differ in length — catching
//     that leak would reintroduce the timing signal through the error path;
// (2) comparing raw bytes leaks the LENGTH of the expected secret via how
//     much of the candidate got compared before bailing.
// sha256 digests are always 32 bytes, so both compare paths — match and
// mismatch, equal lengths and not — run in indistinguishable time.
export function constantTimeEquals(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}`,
        },
        {
          kind: 'text',
          id: 'auth-login-flow:catalog',
          body: `THE LIBRARY CATALOG, one honest paragraph: EXPRESS-SESSION is the ecosystem's standard session middleware — it implements exactly this model (a store, a cookie, a lookup per request) with pluggable stores (MemoryStore for dev, connect-redis for production) and sane cookie defaults. This guide hand-rolls the same machine because the MECHANISM is the curriculum — but reaching for express-session + a Redis store in a real app is a good default, not a compromise. PASSPORT (and its modern successor) is the strategy pattern for the LOGIN STEP — local, OAuth, OIDC, SAML plug in behind one API — and Part 2 covers it. What no library replaces: the discipline that the password compare is constant-time, the cookie carries HttpOnly/Secure/SameSite, the token never appears in a body, and logout actually deletes server-side state. Those four are the review checklist; this app does all four where you can watch.`,
        },
      ],
    },
    {
      id: 'auth-api-keys',
      title: 'API keys',
      lead: 'A session proves a human logged in; an API key grants a MACHINE an identity — a fixed secret sent in a header, with SCOPES attached that say what this particular key may do. Same fixture, second credential family.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-api-keys:model',
          body: `WHAT AN API KEY IS: a long random string a server issues once, a script or service presents on every call (here: the x-api-key header), and the server resolves to an identity plus a SCOPE SET. The demo fixture ships three, one per user — gsk_demo_alice_2mFnQ7xK (scopes read:profile, write:profile, admin:demos), gsk_demo_bob_3kQw9zRt (read:profile, write:profile), gsk_demo_carol_8vXp4mLb (read:profile) — and GET /api/demo/auth/keys lists them, deliberately public, exactly like the password hint: the lesson is the mechanism, not the secrecy. THE FIXED-PREFIX CONVENTION: real vendors prefix keys by KIND so a leaked key is recognizable at a glance in logs, bug reports, and secret-scanner rules — stripe's sk_live_/sk_test_, GitHub's ghp_, Slack's xoxb-. The demo mirrors the convention: gsk_ reads "guide secret key", and the _demo_ segment marks it a teaching fixture that could never be confused with production material. A prefix is also the hook for secret scanning: CI can grep for gsk_ and refuse a commit that embeds a key. SCOPES ARE THE KEY'S PERMISSION SET — and notice they are attached to the KEY, not just the user: alice-the-person could hold two keys, one read-only for a dashboard and one full-power for admin scripts, and revoking the risky one never touches the account. Scope checks are per endpoint: /api/demo/auth/api-protected accepts ANY valid key (it only asks "who is calling"); /api/demo/auth/api-admin additionally requires the admin:demos scope — alice's key passes with a 200, bob's is REJECTED with 403 and an envelope that names the missing scope, so the demo lets you watch a scope check fail. That 401-vs-403 split is the authn/authz distinction from the first section, in one status code pair: 401 means "I don't know who you are" (bad or missing key), 403 means "I know exactly who you are, and that identity may not do this" (valid key, missing scope). WHEN KEYS BEAT SESSIONS: server-to-server calls where no browser exists to hold a cookie; scripts and CLIs that run unattended; CI pipelines — anywhere a credential must be put in a config once and used for months. Sessions expire in minutes and ride cookies; keys live long, ride headers, and are granted narrowly. WHEN THEY LOSE: anywhere a human types them repeatedly (they end up in shell history — note every curl in this guide's snippets would leak a real key the same way; production rotates, and the security topic covers scanning), and any browser context, where HttpOnly cookies are strictly safer than anything JS can read. HASHING AT REST — the production note this demo deliberately skips: we show the keys in plaintext because you need to COPY them to use the demo. A real system stores only (a) a lookup prefix — the first few characters, so the UI can show "gsk_demo_alice_…" next to its entry — and (b) a HASH of the full key (sha256 is enough; keys are high-entropy, unlike passwords, so no slow hash is needed). Lookup re-hashes the presented key and compares hashes; a database leak then yields prefixes and hashes, not credentials. This is exactly how stripe and GitHub describe their key storage, and it costs about ten lines.`,
        },
        {
          kind: 'code',
          id: 'auth-api-keys:verbatim-guard',
          language: 'ts',
          source: 'server/src/presentation/routes/auth_demo_routes.ts',
          caption: 'Verbatim — the two API-key endpoints (auth_demo_routes.ts): authenticate, THEN authorize',
          code: `// Step 1 — AUTHENTICATION: resolve the header to an identity, or 401.
function requireApiKey(req: Request): { user: DemoUser; scopes: readonly DemoScope[] } {
  const candidate = req.header('x-api-key');
  if (candidate === undefined || candidate === '') {
    throw new UnauthorizedException('the x-api-key header is required', { scheme: 'api-key' });
  }
  const match = findUserByApiKey(candidate); // constant-time per key
  if (match === undefined) {
    throw new UnauthorizedException('unknown API key', { scheme: 'api-key' });
  }
  return { user: match.user, scopes: match.apiKey.scopes };
}

// Step 2 — AUTHORIZATION: a VALID key with the WRONG scope is 403, and the
// envelope names what was missing so the failure is watchable, not mysterious.
function apiAdminController(req: Request, res: Response): void {
  const { user, scopes } = requireApiKey(req);
  if (!scopes.includes('admin:demos')) {
    throw new ForbiddenException('this endpoint requires the admin:demos scope', {
      requiredScope: 'admin:demos',
      keyScopes: scopes,
      scheme: 'api-key',
    });
  }
  res.status(200).json({
    user: { username: user.username, displayName: user.displayName, roles: user.roles },
    // …note: the success line that names the scope…
  });
}`,
        },
        {
          kind: 'code',
          id: 'auth-api-keys:curl',
          language: 'bash',
          caption: 'The key tour from a terminal — including the 403 you are supposed to see',
          code: `# The public key list (fixed teaching material, like the password hint):
curl -s localhost:4000/api/demo/auth/keys | jq

# Any valid key authenticates (carol's read-only key is fine here):
curl -s -H 'x-api-key: gsk_demo_carol_8vXp4mLb' \\
  localhost:4000/api/demo/auth/api-protected | jq '{user: .user.username, scopes}'

# No header → 401 (unknown identity); unknown key → 401 too:
curl -s -o /dev/null -w '%{http_code}\\n' localhost:4000/api/demo/auth/api-protected   # 401
curl -s -o /dev/null -w '%{http_code}\\n' -H 'x-api-key: gsk_demo_forged_000' \\
  localhost:4000/api/demo/auth/api-protected                                            # 401

# Alice's key carries admin:demos → 200:
curl -s -H 'x-api-key: gsk_demo_alice_2mFnQ7xK' \\
  localhost:4000/api/demo/auth/api-admin | jq '{user: .user.username, note}'

# Bob's key is VALID but lacks the scope → 403 forbidden envelope:
curl -s -H 'x-api-key: gsk_demo_bob_3kQw9zRt' \\
  localhost:4000/api/demo/auth/api-admin | jq '.error | {code, requiredScope, keyScopes}'`,
        },
      ],
    },
    {
      id: 'auth-credentials-preview',
      title: 'Sessions vs keys vs tokens (preview)',
      lead: 'Two credential families down, one to go. The sections after this one add JWTs — the self-contained token — and OAuth, the delegated dance that issues them. Here is the map so the third family lands in context.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-credentials-preview:map',
          body: `THE ONE-PARAGRAPH PREVIEW: a SESSION (this page, above) keeps state on the server and hands the client an opaque pointer — revocable by delete, but the server must be consulted on every request and the state must live somewhere shared if you scale out. An API KEY (also above) is the same idea for machines: a fixed long-lived secret with scopes, presented in a header. A JWT (JSON Web Token — the next section) flips the direction entirely: the server SIGNS a packet containing the identity and its claims, and the client presents it on every call; the server verifies the SIGNATURE — no store lookup, no shared state, any replica can validate — which is why JWTs dominate service-to-service meshes and mobile backends. The trade is the mirror of sessions': a JWT is valid until it EXPIRES, and short of a denylist (which reintroduces the store you were escaping) it cannot be revoked — logout, properly done, is a client-side token discard plus short expiry windows and refresh tokens. OAUTH 2.0 (the section after) is the DELEGATION protocol: "let this third-party app act as me, narrowly" — the redirect dance you have done a hundred times ("Sign in with GitHub/Google") that ends by handing the client a token, which is very often a JWT. Passport is the strategy layer that wires local, OAuth, and OIDC logins behind one API. WHEN EACH WINS, the short version to hold while you read: server-rendered web app with sessions available → sessions (revocable, boring, correct); machine-to-machine and scripts → API keys with scopes; stateless multi-service or mobile → JWTs with short expiry + refresh; "log in with someone else" → OAuth. The sections ahead build the JWT signing and verification and a real OAuth redirect against a local provider — on these same demo users; the refresh-token flow is taught conceptually where revocation comes up, and the deciding section at the end of the topic compares all three families side by side.`,
        },
      ],
    },
    {
      id: 'auth-jwt',
      title: 'JSON Web Tokens',
      lead: 'The self-contained credential: the server SIGNS a packet of claims, the client carries it, and any replica can verify it with zero shared state. Everything a JWT is fits in three base64url segments and one HMAC — this topic\'s implementation is ~40 lines you will read in full.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-jwt:structure',
          body: `THE STRUCTURE: a JWT is three base64url segments joined by dots — header.payload.signature. The HEADER is JSON naming the algorithm ({alg:'HS256', typ:'JWT'}). The PAYLOAD is JSON carrying the claims — the token's entire meaning: SUB (subject — who the token speaks for, alice's username here), IAT (issued-at, epoch seconds), EXP (expiry, epoch seconds), JTI (jwt-id — a random unique id per token, the hook a denylist would key on), plus any private claims this issuer wants (our demo carries ROLES, which the authorization topic will gate on). The SIGNATURE is neither encoded nor encrypted data — it is HMAC-SHA256(secret, headerSegment + '.' + payloadSegment), base64url-encoded: the one part derived from a secret, and the only part that makes the other two trustworthy. Paste any token this demo issues into the verifier panel and watch the three segments colored and decoded — the payload was readable the whole time (more on that below). HOW SIGNING WORKS (HS256): symmetric — the SAME secret signs and verifies. Sign: HMAC the two segments with the secret. Verify: recompute the HMAC over the received segments and compare (constant time, same trick as the password compare). If a single byte of header or payload changed, the recomputed HMAC differs and the token is refused. The demo secret is FIXED AND EXPORTED (jwt_demo_secret_teaching_only, right in domain/auth/jwt_service.ts) because a secret committed to a public repository signs nothing of value — the honest lesson is that in production the secret is a LONG random value read from the environment at boot, treated like every other secret (the environments topic builds that config validation), and HS256 keys want at least 32 bytes of entropy. WHY JWTs EXIST — THE STATELESSNESS TRADE, read carefully because it is the whole decision: a session (above) forces the server to LOOK SOMETHING UP on every request, so the session state must live somewhere every replica can see. A JWT inverts that: verification is pure computation over the token itself, so ANY replica — any process, any machine, any service sharing nothing but the secret or public key — can authenticate the caller with no store, no network hop, no shared anything. That is why JWTs dominate service-to-service meshes, mobile backends, and API gateways. THE PRICE IS THE MIRROR IMAGE: a valid-and-unexpired JWT CANNOT BE REVOKED. Logout for a JWT is, honestly, the client deleting its copy — the token itself still verifies. The standard mitigations, in order of how often they are combined: (1) SHORT TTLs — 5–15 minutes, so exposure windows are small (our demo defaults to 300s); (2) REFRESH TOKENS — a second, longer-lived credential whose ONLY job is to mint new short access tokens, and which the server CAN refuse (it lives in a store — a session, effectively — so it is revocable, rotatable, and per-client); (3) DENYLISTS — a store of revoked JTIs checked on every request, which reintroduces exactly the shared state you adopted JWTs to escape, so it is reserved for the "this token must die NOW" cases (a fired admin, a detected breach). There is no free lunch: statelessness and revocability are the two ends of one seesaw, and refresh tokens are the industry's compromise — stateless fast path, revocable slow path. SIGNED IS NOT ENCRYPTED — the mistake that leaks credentials: base64url is an ENCODING, not a cipher. Anyone who obtains the token — from a browser's localStorage, a proxy log, a screenshot — can decode and READ the payload with no secret at all (paste one into the demo's verifier: the decoded claims appear instantly). A JWT proves the claims were ISSUED by the key holder; it hides nothing. Never put a secret, a password, a raw API key, or anything sensitive in the payload; put the identity and the minimum of what authorization needs. The related standard, JWE (encrypted tokens), exists for the rare case confidentiality is actually required — and it is a different, heavier machine. THE ALG=NONE HISTORY — why verify PINS the algorithm: a JWT's header names its own algorithm, and early libraries HONORED it. The attacker's move: take a payload, set the header to {"alg":"none"}, drop the signature segment — and those libraries accepted the token as validly "signed" with no signature at all. The family that followed is alg-confusion: claim RS256 (asymmetric) so a naive verifier uses the server's PUBLIC key as an HMAC secret — a secret the attacker also knows, because it is public — and forge HMAC tokens the verifier accepts. The fix is structural and our verifyJwt embodies it: the accepted algorithm is a CONSTANT the verifier chooses, the header's alg field is treated as ATTACKER INPUT that must EQUAL that constant (anything else is rejected before any crypto runs), and there is no negotiation, no "whatever the token says". The same pin-the-algorithm rule applies when you use a library: configure the expected algorithm(s) explicitly, never derive them from the token. CATALOG: jsonwebtoken is the ecosystem's standard signer/verifier (pin algorithms in its verify options); jose is the modern, maintained alternative with JWE support; Passport is the login-strategy layer that can hand you JWTs (passport-jwt). This topic hand-rolls HS256 because the format is the curriculum — and because after reading these forty lines, the library is a convenience, not a mystery.`,
        },
        {
          kind: 'code',
          id: 'auth-jwt:verbatim-sign-verify',
          language: 'ts',
          source: 'server/src/domain/auth/jwt_service.ts',
          caption: 'Verbatim — signJwt and the load-bearing half of verifyJwt (domain/auth/jwt_service.ts)',
          code: `// The signature — the only secret-derived bytes in the whole token:
function hmacSignature(headerSegment: string, payloadSegment: string): string {
  return createHmac('sha256', JWT_DEMO_SECRET)
    .update(\`\${headerSegment}.\${payloadSegment}\`)
    .digest('base64url');
}

// SIGN — the whole format in one function:
export function signJwt(
  sub: string,
  roles: readonly string[],
  ttlSeconds: number = JWT_DEFAULT_TTL_SECONDS,   // 300 — short on purpose
  clock: JwtClock = realJwtClock,                 // time is a dependency
): SignedJwt {
  const iat = clock.now();                        // numeric dates are SECONDS
  const payload: JwtPayload = {                   // the claims — readable by
    sub,                                          // ANYONE holding the token
    roles: [...roles],
    iat,
    exp: iat + ttlSeconds,
    jti: randomBytes(16).toString('hex'),         // unique id (denylist hook)
  };
  const header = { alg: JWT_ALGORITHM, typ: 'JWT' };   // HS256, our constant
  const headerSegment = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    token: \`\${headerSegment}.\${payloadSegment}.\${hmacSignature(headerSegment, payloadSegment)}\`,
    /* … header, payload, expiresAt for the demo's decoded view … */
  };
}

// VERIFY (the load-bearing half — structure check first, then THE ALG PIN):
export function verifyJwt(
  token: string,
  clock: JwtClock = realJwtClock,
): Result<{ payload: JwtPayload }, JwtVerificationFailure> {
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment === '')) {
    return jwtFail('malformed', 'malformed token: expected three non-empty base64url segments');
  }
  /* … decode header + payload JSON (undecodable → 'malformed') … */

  // THE ALG PIN: the header is attacker-controlled input. A real forgery
  // starts by editing it ("alg":"none", or an asymmetric alg hoping the
  // verifier treats the public key as the HMAC key) — so the check is against
  // OUR algorithm constant, never against the token's own claim.
  if (header.alg !== JWT_ALGORITHM) {
    return jwtFail(
      'unsupported_algorithm',
      \`rejected algorithm "\${String(header.alg)}" — this issuer signs HS256 only, and the header is attacker input\`,
    );
  }

  // Constant-time compare (sha256 → timingSafeEqual, as in demo_users.ts).
  const expected = hmacSignature(headerSegment, payloadSegment);
  if (!constantTimeEquals(signatureSegment, expected)) {
    return jwtFail('signature_mismatch', 'signature mismatch');
  }

  // …exp's type check, then: exp is epoch SECONDS; "on or after" means
  // refused — at exactly exp the token is already dead (>=, not >).
  if (clock.now() >= exp) {
    return jwtFail('token_expired', 'token expired');
  }
  /* … claims shape checks, then ok({ payload }) … */
}`,
        },
        {
          kind: 'code',
          id: 'auth-jwt:curl',
          language: 'bash',
          caption: 'The token tour from a terminal — issue, verify (both verdicts), the Bearer call, and expiry',
          code: `# Issue a 5-minute token for alice. NOTE: no password — a JWT is issued
# AFTER some other mechanism proved who you are (a login, an OAuth code):
TOKEN=$(curl -s -X POST localhost:4000/api/demo/auth/jwt/issue \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"alice"}' | jq -r .token)

# Verify — 200 BOTH ways: the verdict is data, not an error state.
curl -s -X POST localhost:4000/api/demo/auth/jwt/verify \\
  -H 'Content-Type: application/json' -d "{\\"token\\":\\"$TOKEN\\"}" | jq
# → { "valid": true, "payload": { "sub": "alice", "roles": ["admin"], … } }

# The Bearer call — stateless auth: no store lookup, just the HMAC check:
curl -s -H "Authorization: Bearer $TOKEN" \\
  localhost:4000/api/demo/auth/jwt-protected | jq
# → { "user": {"username":"alice",…}, "issuedAt": "…", "expiresAt": "…" }

# Forge the claims (edit the payload, keep the signature) → signature mismatch:
FORGED=$(node -e '
  const [h, p, s] = process.argv[1].split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  claims.sub = "admin";                             // the dream of every token thief
  const f = Buffer.from(JSON.stringify(claims)).toString("base64url");
  console.log(h + "." + f + "." + s);' "$TOKEN")
curl -s -X POST localhost:4000/api/demo/auth/jwt/verify \\
  -H 'Content-Type: application/json' -d "{\\"token\\":\\"$FORGED\\"}" | jq '.reason'
# → "signature mismatch"

# Expiry you can watch: a 2-second token, then verify → expired.
SHORT=$(curl -s -X POST localhost:4000/api/demo/auth/jwt/issue \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"bob","ttlSeconds":2}' | jq -r .token)
sleep 3
curl -s -X POST localhost:4000/api/demo/auth/jwt/verify \\
  -H 'Content-Type: application/json' -d "{\\"token\\":\\"$SHORT\\"}" | jq '.reason'
# → "token expired"`,
        },
      ],
    },
    {
      id: 'auth-oauth',
      title: 'The OAuth 2.0 authorization-code flow',
      lead: '"Sign in with GitHub/Google" is a four-act redirect dance: the user consents at the provider, a one-time code comes back through the browser, the client\'s BACKEND trades it (plus its secret) for a token. This guide runs the whole play locally — a real consent page, single-use codes, a spec-shaped token endpoint — on the same three demo users.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-oauth:four-acts',
          body: `THE PROBLEM OAUTH SOLVES is DELEGATION, not authentication of your own users: "let THIS third-party application act as me, narrowly" — read my profile, never my password. You have lived this as "Sign in with GitHub": the app never sees your GitHub password; it receives permission and a scoped token instead. THE FOUR ACTS OF THE AUTHORIZATION-CODE FLOW, as this guide's demo runs them: ACT I — REDIRECT TO THE AUTHORIZATION SERVER: the app sends the user's browser to the provider's /authorize endpoint carrying client_id (WHO is asking — a registered public identifier), redirect_uri (WHERE the provider should send the user back — registered, allowlisted), response_type=code (WHICH flow), scope (WHAT access is requested), and STATE (a random value the app generates and remembers — echoed back later, the CSRF defense for the whole dance). ACT II — THE USER CONSENTS AT THE PROVIDER: the provider shows who is asking and for what, the user is authenticated THERE (their session with the provider — that is why you are already logged into GitHub and the consent page appears instantly), and approves or denies. Deny → redirect back with error=access_denied. Approve → the provider mints a short-lived, single-use AUTHORIZATION CODE and redirects the browser to redirect_uri?code=…&state=…. ACT III — THE BACK-CHANNEL EXCHANGE: the client's BACKEND POSTs the code to the provider's /token endpoint together with client_id, client_secret (the client's PASSWORD, proof of who is cashing the code) and the SAME redirect_uri. Success → {access_token, token_type: 'Bearer', expires_in, scope}. ACT IV — THE API CALL: the client calls the provider's API with Authorization: Bearer <access_token> — in this guide the token is literally one of the HS256 JWTs from the previous section (sub = the consenting demo user), and the API is /api/demo/oauth/userinfo. WHY THE CODE EXISTS — THE FRONT-CHANNEL/BACK-CHANNEL SPLIT, the design insight that makes the whole flow make sense: the FRONT CHANNEL is the browser — every URL that passes through it is visible to the user, to browser history, to extensions, to anything that can read the address bar or referrer headers; it must NEVER carry a secret. The BACK CHANNEL is a direct server-to-server POST — invisible to the browser, able to carry the client_secret. If the provider handed the TOKEN back through the redirect, the token would cross the front channel — so instead it hands back a CODE: a value that is USELESS ALONE (single-use, 60 seconds, bound to client + redirect_uri at creation), and only worth something when combined with the client_secret on the back channel. An attacker who glimpses the redirect URL gets a dead-end; the code they steal cannot be cashed without the secret, dies in a minute, and dies on first use anyway. THE DEMO'S THREE OAUTH-ICIAN RULES, all enforced in domain/auth/oauth_store.ts and visible in the specs: (1) SINGLE USE — the code is BURNED on first exchange and its value moved to a used-registry, so a replay answers invalid_grant (run the same exchange twice in the curl block below and watch the second one fail); (2) SHORT LIFE — 60 seconds, and lazily swept like the session store; (3) BOUND AT BIRTH — username + client_id + redirect_uri are stored with the code and re-checked at exchange, so a code issued to one client, for one redirect, cannot be cashed by another. PKCE (PROOF OF KEY CODE EXCHANGE) — the paragraph you must not skip: OAuth 2.0 was designed for CONFIDENTIAL clients (apps with a backend that can hold a secret — this demo's client, guide_client, is one, and that is exactly why the demo can SKIP PKCE). PUBLIC clients — SPAs and mobile apps — HAVE no back channel and no place to hide a client_secret, so for them the classic flow's secret leg is impossible. PKCE replaces the secret with a proof the attacker in the middle cannot replay: before redirecting, the client generates a random code_verifier, sends its SHA-256 (the code_challenge) with the authorization request, and presents the original verifier at the token endpoint — the provider checks hash(verifier) === challenge, binding the code exchange to the SAME browser session that started the flow. An attacker who steals the code from the redirect cannot answer the verifier challenge. RULE: real public clients MUST use PKCE (it is mandatory in OAuth 2.1) — the demo skips it only because it also PLAYS the confidential client's backend (the demo-exchange endpoint), and adding it would blur which secret is doing the work. SCOPES AND CONSENT: the scope parameter is the NARROWNESS in "act as me, narrowly" — a space-separated list of permissions the client requests, the consent page DISPLAYS, and the token carries. This demo has exactly one scope, profile (granted wholesale on approve); real providers have families (read:user, repo, …) and the authorization server may grant FEWER than requested. Notice the consent page IS the security decision the whole protocol exists to make: the user saw the client name, the scope, and chose — the code that comes back is the RECEIPT of that choice, and the token's scope claim is what it purchased. THE ENDPOINTS YOU ARE ABOUT TO READ (all under /api/demo/oauth/): /authorize renders the consent page as SERVER-RENDERED HTML — deliberately, per this guide's architecture: SSR stays in the curriculum through dedicated Express-rendered routes like this one, not as the guide's shell; /authorize/decision is the consent form's target and answers ONLY in redirects (302 with code+state, or error=access_denied); /token is the spec-conformant back channel — and note its ERRORS deliberately do NOT use this app's error envelope, because /token's audience is not this app's frontend but ANY spec-following OAuth client library: those parse {error: 'invalid_grant'} per RFC 6749 §5.2 and act on the error code (refresh, re-auth, give up), so the endpoint speaks the SPEC's error shape — the rule being: your app's endpoints speak your envelope; endpoints you implement ON BEHALF OF A SPEC speak the spec's language; /userinfo is the Bearer-protected resource; and /demo-exchange is the demo's honesty helper — it performs act III in-process, with the client_secret applied server-side playing YOUR backend, because this guide's browser demo is a public-ish client that must never see the secret. In a real app, YOUR backend is that code.`,
        },
        {
          kind: 'code',
          id: 'auth-oauth:verbatim-store',
          language: 'ts',
          source: 'server/src/domain/auth/oauth_store.ts',
          caption: 'Verbatim — the single-use code store (domain/auth/oauth_store.ts)',
          code: `// ISSUE — 16 random bytes, bound at birth to user + client + redirect:
export function createAuthorizationCode(
  input: Omit<StoredAuthorizationCode, 'code' | 'createdAt' | 'expiresAt'>,
  options: CreateAuthorizationCodeOptions = {},
): StoredAuthorizationCode {
  const createdAt = Date.now();
  const stored: StoredAuthorizationCode = {
    ...input,
    code: randomBytes(16).toString('base64url'),
    createdAt,
    expiresAt: createdAt + (options.ttlMs ?? OAUTH_CODE_TTL_MS),   // 60 seconds
  };
  activeCodes.set(stored.code, stored);
  return stored;
}

// CONSUME — validates, then BURNS. A used value is remembered in a registry
// so the REPLAY is answered as a replay:
export function consumeAuthorizationCode(code: string): ConsumeAuthorizationCodeResult {
  if (usedCodes.has(code)) {
    return { ok: false, reason: 'used' };        // single-use, second time 'round
  }
  const stored = activeCodes.get(code);
  if (stored === undefined) {
    return { ok: false, reason: 'unknown' };     // never issued (or long gone)
  }
  if (stored.expiresAt <= Date.now()) {
    activeCodes.delete(code);
    usedCodes.add(code);                          // a dead code can never come back
    return { ok: false, reason: 'expired' };
  }
  activeCodes.delete(code);                       // THE BURN
  usedCodes.add(code);
  return { ok: true, code: stored };
}`,
        },
        {
          kind: 'code',
          id: 'auth-oauth:verbatim-token',
          language: 'ts',
          source: 'server/src/presentation/routes/oauth_demo_routes.ts',
          caption: 'Verbatim — the back channel\'s client authentication (oauth_demo_routes.ts): HTTP Basic (the RFC\'s preferred method) OR body credentials, and the secret compare is constant-time, like every secret in this topic. 401 + {error:\'invalid_client\'} is the RFC\'s contract',
          code: `const basic = basicCredentials(req.headers.authorization);
const clientId = basic?.clientId ?? stringField(req.body, 'client_id');
const clientSecret = basic?.clientSecret ?? stringField(req.body, 'client_secret');

const clientKnown =
  clientId === OAUTH_CLIENT.client_id &&
  clientSecret !== undefined &&
  constantTimeEquals(clientSecret, OAUTH_CLIENT.client_secret);
if (!clientKnown) {
  // 401 + invalid_client is the RFC's contract for failed client auth.
  oauthError(res, 401, 'invalid_client', 'client authentication failed (unknown client or wrong client_secret)');
  return;
}`,
        },
        {
          kind: 'code',
          id: 'auth-oauth:verbatim-exchange',
          language: 'ts',
          source: 'server/src/presentation/routes/oauth_demo_routes.ts',
          caption: 'Verbatim — the exchange itself (oauth_demo_routes.ts): every binding is RE-CHECKED at cash time, and the access token IS one of the previous section\'s HS256 JWTs',
          code: `function exchangeCode(code: string, redirectUri: string):
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string; description: string } {
  const consumed = consumeAuthorizationCode(code);
  if (!consumed.ok) {
    const descriptions = {
      unknown: 'unknown authorization code',
      used: 'authorization code already used — codes are single-use by design',
      expired: 'authorization code expired (they live 60 seconds)',
    } as const;
    return { ok: false, status: 400, error: 'invalid_grant', description: descriptions[consumed.reason] };
  }
  const stored = consumed.code;

  // The binding checks: the code is only cashable by the client it was issued
  // to, over the redirect it bounced through.
  if (stored.clientId !== OAUTH_CLIENT.client_id) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'the code was issued to a different client' };
  }
  if (stored.redirectUri !== redirectUri) {
    return { ok: false, status: 400, error: 'invalid_grant', description: 'redirect_uri does not match the authorization request' };
  }

  // …the user lookup (a code naming a deleted user → invalid_grant), then:
  const signed = signJwt(user.username, user.roles, JWT_DEFAULT_TTL_SECONDS);
  return {
    ok: true,
    body: {
      access_token: signed.token,
      token_type: 'Bearer',
      expires_in: JWT_DEFAULT_TTL_SECONDS,   // 300
      scope: stored.scope,                   // 'profile'
    },
  };
}`,
        },
        {
          kind: 'code',
          id: 'auth-oauth:curl',
          language: 'bash',
          caption: 'The four acts from a terminal (act I is HTML — open it in a browser)',
          code: `# ACT I — the consent page (SERVER-RENDERED HTML — open in a browser):
open 'http://localhost:4000/api/demo/oauth/authorize?response_type=code&client_id=guide_client&redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fdemos%2Foauth%2Fcallback&state=curl-demo'
# Approve as alice → the browser lands on the callback with ?code=…&state=curl-demo.
# (The UI demo below does this whole dance for you, rendered act by act.)

# ACT III — the BACK-CHANNEL exchange. -u sends Basic auth (client password!),
# -d sends the form-encoded body the spec requires:
CODE='paste-the-code-from-the-redirect-url'
curl -si -X POST localhost:4000/api/demo/oauth/token \\
  -u guide_client:guide_demo_secret \\
  -d grant_type=authorization_code \\
  -d "code=$CODE" \\
  -d 'redirect_uri=http://localhost:5173/demos/oauth/callback'
# 200 → { "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 300, "scope": "profile" }

# ACT IV — the API call with the token (a JWT from the previous section):
TOKEN='paste-the-access_token'
curl -s -H "Authorization: Bearer $TOKEN" \\
  localhost:4000/api/demo/oauth/userinfo | jq
# → { "username": "alice", "displayName": "Alice Admin", "roles": ["admin"] }

# The two failures the protocol is DESIGNED to produce:
# (1) REPLAY the same code → 400 invalid_grant (codes are single-use):
curl -si -X POST localhost:4000/api/demo/oauth/token \\
  -u guide_client:guide_demo_secret \\
  -d grant_type=authorization_code -d "code=$CODE" \\
  -d 'redirect_uri=http://localhost:5173/demos/oauth/callback' | head -3
# (2) WRONG client secret → 401 invalid_client (OAuth's error shape, not the
#     app envelope — spec-conformant endpoints answer spec-following clients):
curl -si -X POST localhost:4000/api/demo/oauth/token \\
  -u guide_client:wrong-secret \\
  -d grant_type=authorization_code -d "code=$CODE" \\
  -d 'redirect_uri=http://localhost:5173/demos/oauth/callback' | head -3`,
        },
      ],
    },
    {
      id: 'auth-choosing',
      title: 'Sessions vs JWT vs API keys — deciding',
      lead: 'Three credential families, one decision each time you add a caller. The honest answer in most real systems is "all three, each in its place" — here is the map that tells you which place is whose.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-choosing:comparison',
          body: `THE COMPARISON, ROW BY ROW. SERVER STATE: a SESSION is a store entry the server must consult on every request (deletable — instant revocation; but shared-state required when you scale out, which is why Redis is the canonical session store); a JWT is pure computation — zero state, any replica verifies (scale forever, but nothing to delete); an API KEY is a store entry consulted rarely — it changes on a months cadence, not per request, and production stores only a hash + lookup prefix. WHO CARRIES IT: the session's token rides an HttpOnly cookie the browser manages automatically (nothing for JS to steal or misplace); a JWT rides whatever you put it in — a Bearer header, dangerously often localStorage (an XSS payload reads localStorage; the security topic returns to this — Bearer headers are the one place a JWT should live in a browser, and memory + refresh-token-in-cookie beats storage); an API key rides a header a human pastes into a config once. REVOCATION: sessions — DELETE, done; JWTs — impossible without a denylist (short TTLs + refresh tokens are the mitigation; see the JWT section); API keys — delete/rotate the row, and well-run systems auto-expire them. EXPIRY SHAPE: sessions are minutes-to-hours; JWT access tokens should be MINUTES (5–15) with a revocable refresh token behind them; keys are months. WHERE EACH WINS — the short table: HUMAN IN A BROWSER → sessions: the cookie is managed for you, HttpOnly defends against XSS exfiltration, SameSite against CSRF, revocation is one delete, and every serious session store is battle-tested. MOBILE APP / SPA TALKING TO ITS OWN API → JWTs with short access TTLs + refresh tokens: no cookie jar to fight on mobile, tokens work across services, and the backend stays stateless. SERVICE-TO-SERVICE / SCRIPTS / CI → API keys with scopes (or mTLS where the infrastructure exists): a stable identity you can rotate on a schedule, scopes narrower than "act as the whole user", and audit logs that say WHICH key did what. DELEGATING TO A THIRD PARTY → OAuth: never hand out your users' passwords; the consent screen, the scoped token, and the revocable grant are the entire point. THE HYBRID REALITY — because this is what you will actually build: most production systems run ALL THREE AT ONCE. The web app uses sessions; the mobile client gets JWTs from the same identity provider behind a refresh flow; machine integrations use scoped API keys; and "log in with Google" rides OAuth to mint whatever the system's native credential is (Google's own ID token is a JWT — OAuth for the transport, JWT for the credential — and the openid-connect layer on top is what makes OAuth double as authentication: an ID TOKEN with a documented sub claim, versus plain OAuth where all you know is "this token works"). The one warning that outranks every convenience: PICK ONE PRIMARY CREDENTIAL PER CLIENT TYPE. A browser session AND a bearer token AND a key all accepted by the same endpoint is three attack surfaces where one would do — the authorization topic's middleware will assume exactly this: resolve the identity ONCE, from the scheme that endpoint is documented to accept.`,
        },
      ],
    },
    {
      id: 'auth-password-hashing',
      title: 'Password hashing',
      lead: 'The database that holds logins WILL someday be dumped — so it must never hold passwords, only DERIVATIONS of them that are slow to compute and salted per user. This guide hand-rolls scrypt from node:crypto because the encoded format and the verify discipline are the lesson; argon2id and bcrypt are the ecosystem names for the same discipline.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-password-hashing:model',
          body: `WHY NOT JUST HASH WITH SHA-256: a fast hash is wrong on purpose here. An attacker with the dump tests guesses OFFLINE at billions per second against sha256(password) — so a password hash must be a KEY DERIVATION FUNCTION: deliberately EXPENSIVE (tens to hundreds of milliseconds per attempt, pricing brute force out) and deliberately MEMORY-hungry (GPUs and ASICs parallelize compute cheaply, not memory). The ecosystem names: ARGON2ID (the modern recommendation — tuneable memory AND time cost), BCRYPT (the battle-tested default, max 72 bytes of input, work factor 2^cost), SCRYPT (node:crypto ships it in the STANDARD LIBRARY — the one this guide runs, N/r/p parameters). THE SALT: a fresh random 16 bytes PER PASSWORD, stored alongside the derivation. Without it, identical passwords hash identically and an attacker precomputes a RAINBOW TABLE of the top million passwords once and matches your whole column in one pass; with it, every hash needs its own full-cost attack. That is also why hashing the SAME password twice produces DIFFERENT strings — the demo panel's point. THE ENCODED FORMAT is half the lesson: scrypt$32768$8$1$c2FsdHNhbHQ$aGFzaA — primitive$N$r$p$saltB64$hashB64, a PHC-style cousin readable while carrying every field verify needs. It must be a FORMAT because verify has to re-derive with the SAME salt and the SAME parameters the hash was minted with — they travel WITH the hash. And the leading token is the UPGRADE HOOK: the verifier dispatches on the primitive name, so when you raise the cost (or move to argon2id) you mint new hashes under a NEW prefix at each user's next successful login — lazy migration, one user at a time, no flag-day rehash of a column you cannot invert anyway. THE PARAMETERS ARE A DIAL YOU OWN: N = 2^15 with r = 8 needs 128·N·r = 32 MiB and ~50–250ms per hash — OWASP's interactive-login band. And one GOTCHA the code encodes on purpose: node's scrypt defaults maxmem to 32 MiB, and OpenSSL's memory check is 128·r·(N + 2p) — N = 2^15, r = 8 THROWS "memory limit exceeded" at that default, so the explicit 64 MiB maxmem below is required, not decorative; raise N and you must raise maxmem with it. VERIFY = parse, re-derive over the same salt and params, then TIMING-SAFE EQUAL (the constant-time compare discipline from the login section, now over fixed-length 32-byte keys by construction). And because a stored hash string is ATTACKER-CONTROLLED INPUT the moment it leaves this module (the verify playground accepts arbitrary strings), the parser bounds what it will honor — a crafted N = 2^30 hash would otherwise be a self-DoS button — and an unknown prefix is a typed validation failure, never a crash. THE COST IS THE FEATURE, paid once per login: this fixture's module init burns three derivations at boot (two users plus a timing decoy) and each login pays one — that ~250ms per attempt is exactly what an attacker pays per GUESS.`,
        },
        {
          kind: 'code',
          id: 'auth-password-hashing:verbatim-params',
          language: 'ts',
          source: 'server/src/domain/auth/password_hasher.ts',
          caption: 'Verbatim — the cost parameters and the derive/encode pair (domain/auth/password_hasher.ts): deliberate dials, fresh salt, $-joined format',
          code: `export const SCRYPT_COST = { N: 2 ** 15, r: 8, p: 1 } as const;
/** 64 MiB — headroom above 128·r·(N+2p) for the params above (see header). */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** Random salt bytes per hash — 128 bits, so rainbow tables never amortize. */
const SALT_BYTES = 16;
/** Derived key length — 32 bytes, fixed, so timingSafeEqual inputs always match. */
const KEY_BYTES = 32;

/** Derives the scrypt key for a candidate password over the given salt + params. */
function derive(candidate: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(candidate, salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = derive(password, salt, SCRYPT_COST.N, SCRYPT_COST.r, SCRYPT_COST.p);
  return encodeHash('scrypt', SCRYPT_COST.N, SCRYPT_COST.r, SCRYPT_COST.p, salt, hash);
}

function encodeHash(
  primitive: string,
  N: number,
  r: number,
  p: number,
  salt: Buffer,
  hash: Buffer,
): string {
  return [
    primitive,
    String(N),
    String(r),
    String(p),
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}`,
        },
        {
          kind: 'code',
          id: 'auth-password-hashing:verbatim-verify',
          language: 'ts',
          source: 'server/src/domain/auth/password_hasher.ts',
          caption: 'Verbatim — verify and the parse bounds (same file): re-derive with the STORED salt + params, timing-safe compare, and crafted hashes refused before scrypt runs',
          code: `const PARSE_LIMITS = {
  minN: 2,
  maxN: 2 ** 20,
  maxR: 32,
  maxP: 8,
  maxSaltBytes: 64,
} as const;

export function verifyPasswordHash(
  candidate: string,
  encoded: string,
): Result<boolean, PasswordHashFailure> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed.ok) return parsed;
  const derived = derive(candidate, parsed.value.salt, parsed.value.N, parsed.value.r, parsed.value.p);
  return ok(timingSafeEqual(derived, parsed.value.hash));
}`,
        },
        {
          kind: 'demo',
          id: 'auth-password-hashing:demo',
          demoId: 'auth:hashing',
          title: 'The hashing playground: hash, parse, verify',
          description:
            'Hash any password and read the encoded string field by field (primitive, N, r, p, salt, key — the parse comes back with the response, proving the format round-trips). Hash the same password twice and compare: new salt, different string. Then verify a candidate against a hash — true, false, and the typed 400 a crafted hash string earns.',
        },
        {
          kind: 'code',
          id: 'auth-password-hashing:curl',
          language: 'bash',
          caption: 'The playground from a terminal — including the real credential login (dana / guide-hashing-pw)',
          code: `# hash, and read the parts back (a hash you cannot parse is one you cannot upgrade):
curl -s -X POST localhost:4000/api/demo/auth/hashing/hash \\
  -H 'content-type: application/json' -d '{"password":"correct horse battery staple"}' \\
  | jq '{hash, parsed}'

# verify — both verdicts; same password + ITS hash → true; anything else → false:
HASH='paste-the-hash-above'
curl -s -X POST localhost:4000/api/demo/auth/hashing/verify \\
  -H 'content-type: application/json' \\
  -d "{\\"password\\":\\"correct horse battery staple\\",\\"hash\\":\\"$HASH\\"}" | jq

# the credential login over hashed passwords — the raw refresh token appears
# exactly ONCE in this response (the store keeps only its sha256):
curl -si -X POST localhost:4000/api/demo/auth/credential/login \\
  -H 'content-type: application/json' \\
  -d '{"username":"dana","password":"guide-hashing-pw"}' | grep -Ei '^(HTTP|set-cookie)'
#   HTTP/1.1 200 OK   — and the body carries session + jwt + refresh`,
        },
      ],
    },
    {
      id: 'auth-refresh-rotation',
      title: 'Refresh tokens and rotation',
      lead: 'Short-lived access tokens limit a stolen token\'s life; the refresh token is the revocable slow path behind them. Rotation makes each refresh token single-use, and REUSE of a used one is not an error to tolerate — it is a THEFT SIGNAL that revokes the whole family.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-refresh-rotation:model',
          body: `THE PAIR, restated in one line each: the ACCESS token is the self-contained JWT from the earlier section — minutes of life, no store, unverifiable-by-revocation; the REFRESH token exists to buy new access tokens, and BECAUSE it lives in server state it can be refused, rotated, and revoked — the compromise the JWT section promised. TWO DESIGN DECISIONS make a refresh store honest. (1) TOKENS ARE OPAQUE — 32 random bytes, no claims, no signature to verify: a refresh token proves nothing on its own, it is a pure lookup key into server state, so there is nothing worth forging and revocation is deleting the row (the exact OPPOSITE of the access JWT — the pair is the lesson). (2) THE STORE HOLDS ONLY sha256(token), never the raw value — a database dump must not yield reusable credentials; lookup is hash-then-get, and because the Map compares fixed-length digests rather than secrets, no timing-safe gymnastics are needed (the same digest-first trick the login section plays, one step earlier in the pipeline). TOKEN FAMILIES are the unit of revocation: every login mints a family id, and the family's chain of refresh tokens grows by one per rotation — each rotation marks the old token 'rotated' (single-use evidence, KEPT) and moves the current pointer to the new one. The exchange's four verdicts: unknown token → plain 401; family already revoked → plain 401; the family's CURRENT token → rotate (new access JWT + new refresh token, exactly one of each); an OLD, already-rotated token → REUSE DETECTED. WHY REUSE IS THEFT: the legitimate client holds the NEWEST token — it moved on. A rotated token replaying can only come from someone who copied it BEFORE the rotation (a leaked response body, a stolen phone, a MITM). You cannot know who is presenting it, but you know family material escaped, so the response is to revoke the ENTIRE family — every token past and current dies together, which is transitive completeness: the thief's copy AND any token they might already have refreshed into are both worthless, and the honest client simply logs in again. The distinguishing 401 (reuse_detected, with the family id and which token was replayed) is what makes this a monitoring signal, not just a rejection. PRODUCTION SHAPE: the same state machine over a TTL'd database or Redis table (created_at, rotated_at, state, family_id, token_hash) — the guide's in-memory store is the teaching cut, capped at 50 families like the session store. The demo below completes the whole story: log in over hashed credentials, rotate a few times watching the chain grow, then replay an OLD token and watch the family collapse.`,
        },
        {
          kind: 'code',
          id: 'auth-refresh-rotation:verbatim-mint',
          language: 'ts',
          source: 'server/src/domain/auth/refresh_store.ts',
          caption: 'Verbatim — the mint and the hash (domain/auth/refresh_store.ts): 32 random bytes, stored only as sha256',
          code: `function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}`,
        },
        {
          kind: 'code',
          id: 'auth-refresh-rotation:verbatim-rotate',
          language: 'ts',
          source: 'server/src/domain/auth/refresh_store.ts',
          caption: 'Verbatim — the rotation state machine, abridged (same file): rotate on current, REVOKE THE FAMILY on a rotated replay',
          code: `export function rotateRefreshToken(rawPresented: string): RefreshRotationOutcome {
  const presentedHash = hashToken(rawPresented);
  const familyId = familyIdByTokenHash.get(presentedHash);
  if (familyId === undefined) {
    return { ok: false, reason: 'unknown_token' };
  }
  // …the family lookup, and the already-revoked plain 401…
  const presented = family.tokens.find((token) => token.tokenHash === presentedHash);
  if (presented === undefined) {
    return { ok: false, reason: 'unknown_token' };
  }

  if (presented.state === 'rotated') {
    // REUSE DETECTED. A rotated token is single-use evidence: the real client
    // moved on, so whoever is presenting it copied it before rotation.
    const revokedAt = nowIso();
    family.revokedAt = revokedAt;
    family.revokedReason = 'reuse_detected';
    for (const token of family.tokens) {
      token.state = 'dead';
    }
    return {
      ok: false,
      reason: 'reuse_detected',
      familyId,
      reusedTokenMasked: maskSessionToken(rawPresented),
      family,
    };
  }

  // presented.state === 'current' → rotate.
  const rotatedAt = nowIso();
  presented.state = 'rotated';
  presented.rotatedAt = rotatedAt;
  const raw = mintToken();
  family.tokens.push({
    tokenHash: hashToken(raw),
    tokenMasked: maskSessionToken(raw),
    createdAt: rotatedAt,
    rotatedAt: null,
    state: 'current',
  });
  familyIdByTokenHash.set(family.tokens[family.tokens.length - 1]!.tokenHash, familyId);
  return { ok: true, family, next: { familyId, token: raw } };
}`,
        },
        {
          kind: 'demo',
          id: 'auth-refresh-rotation:demo',
          demoId: 'auth:refresh',
          title: 'The refresh panel: rotate, replay, revoke',
          description:
            'Log in over the hashed-credential users (dana/erin) to open a token family, then rotate: each exchange returns a fresh access JWT plus a NEW refresh token and the old one dies. The family view shows the whole chain — which token is current, which are rotated. Then replay an OLD token: reuse detected, the ENTIRE family revokes, and every further call is a distinguishable 401.',
        },
        {
          kind: 'code',
          id: 'auth-refresh-rotation:curl',
          language: 'bash',
          caption: 'The rotation lifecycle from a terminal — including the theft replay',
          code: `# 1. login → family id + the FIRST refresh token (raw, exactly once):
RT=$(curl -s -X POST localhost:4000/api/demo/auth/credential/login \\
  -H 'content-type: application/json' \\
  -d '{"username":"dana","password":"guide-hashing-pw"}' | jq -r .refresh.refreshToken)
OLD_RT=$RT   # keep the first one for the theft replay below

# 2. rotate: new JWT + NEW refresh token; the presented one is now 'rotated':
RT=$(curl -s -X POST localhost:4000/api/demo/auth/refresh/rotate \\
  -H 'content-type: application/json' -d "{\\"refreshToken\\":\\"$RT\\"}" \\
  | jq -r .refresh.refreshToken)

# 3. the theft: replay the FIRST token — reuse detected, family revoked:
curl -s -X POST localhost:4000/api/demo/auth/refresh/rotate \\
  -H 'content-type: application/json' -d "{\\"refreshToken\\":\\"$OLD_RT\\"}" \\
  | jq '.error | {code, reason, familyId}'
#   reason: "reuse_detected"  — and now even the CURRENT token is dead:
curl -s -X POST localhost:4000/api/demo/auth/refresh/rotate \\
  -H 'content-type: application/json' -d "{\\"refreshToken\\":\\"$RT\\"}" \\
  | jq '.error.reason'   # "family_revoked"`,
        },
      ],
    },
    {
      id: 'auth-live',
      title: 'See it live (sessions, keys, JWTs, OAuth)',
      lead: 'All four credential families, completed for real in the UI: log in and prove the session cookie; select an API key and watch a scope check fail; dissect, forge, and expire a JWT in the verifier; then run the full OAuth redirect dance — consent page, single-use code, back-channel exchange, userinfo — against the local provider.',
      blocks: [
        {
          kind: 'text',
          id: 'auth-live:intro',
          body: `SESSIONS PANEL: the user picker lists the three demo identities (the shared password rides along — completing the flow is the point). LOGIN posts the credentials, sets the HttpOnly cookie, and renders the identity card — note the demo CANNOT show you the cookie itself: browser fetch hides Set-Cookie from JavaScript, and HttpOnly hides it from the page even if it tried — so the panel proves the session the honest way, by calling /me and rendering who the cookie says you are. ME re-checks the session (401 envelope when logged out — try it after LOGOUT); SESSIONS lists the ACTIVE server-side sessions with masked tokens, who, and when they expire — open the guide in a second tab, log in as another user, and watch the list grow; LOGOUT destroys the session and clears the cookie, after which every ME is a 401. API-KEYS PANEL: the three keys as selectable cards (copyable, with their scope chips). CALL /api-protected sends the selected key in the x-api-key header — any valid key answers 200 with the identity and scopes; CALL /api-admin additionally demands the admin:demos scope: alice answers 200, bob answers the 403 forbidden envelope naming the missing scope, and the response panel renders the envelope either way. JWT WORKBENCH: pick a user, ISSUE a token, and read its three colored segments — the decoded header, the decoded payload (claims in plain sight: signed is not encrypted), and the signature (binary — not JSON). VERIFY asks the server's verdict (200 both ways — the reason IS the lesson); the TAMPER toggle rewrites the payload's claims (sub becomes admin) while keeping the signature, and VERIFY answers "signature mismatch"; ISSUE 2-SECOND TOKEN arms a countdown you can watch hit zero before VERIFY returns "token expired"; CALL jwt-protected sends the token as a Bearer header — 200 identity, or the 401 envelope once tampered/expired. OAUTH FLOW: START THE FLOW redirects your browser to the local provider's consent page (act I–II, real HTML); approve or deny as a demo user, land on the callback, and the four acts render as numbered steps — the redirect received (code + state), the back-channel exchange (token masked), and the userinfo identity your Bearer call returned. Deny, and the callback renders the access_denied state instead. The curl blocks drive all four families from a terminal.`,
        },
        {
          kind: 'demo',
          id: 'auth-live:sessions-demo',
          demoId: 'auth:sessions',
          title: 'The login flow, completed for real',
          description:
            'Pick a demo user (password prefilled — it is the teaching password), log in, then prove the session via /me, list the active server-side sessions (masked tokens, who, when), and log out to watch the 401s arrive. HttpOnly means the page cannot read the cookie — /me is the proof.',
        },
        {
          kind: 'demo',
          id: 'auth-live:keys-demo',
          demoId: 'auth:api-keys',
          title: 'API keys and scope checking',
          description:
            'The three fixed demo keys as selectable cards with their scopes; call /api-protected (any valid key) and /api-admin (needs admin:demos — watch bob\'s valid key earn a 403 naming the missing scope). A per-key curl snippet shows the exact terminal command.',
        },
        {
          kind: 'demo',
          id: 'auth-live:jwt-demo',
          demoId: 'auth:jwt',
          title: 'The JWT workbench: issue, dissect, forge, expire',
          description:
            'Issue an HS256 token for a demo user and read its three segments (header / payload decoded in the page — signed is not encrypted). Verify it against the server, flip TAMPER to forge the claims under an unchanged signature (verdict: signature mismatch), issue a 2-second token and watch the countdown reach "token expired", and call the Bearer-protected endpoint with the good and the forged token.',
        },
        {
          kind: 'demo',
          id: 'auth-live:oauth-demo',
          demoId: 'auth:oauth',
          title: 'The authorization-code flow, end to end against the local provider',
          description:
            'Start the flow → the provider\'s real consent page (pick alice/bob/carol, approve or deny) → the callback renders the four acts as numbered steps: redirect received, single-use code, back-channel exchange (token masked, secret never in the browser), and the userinfo identity. Deny renders the access_denied state.',
        },
        {
          kind: 'code',
          id: 'auth-live:curl-sessions',
          language: 'bash',
          caption: 'The full session tour from a terminal (server: npm run dev in server/)',
          code: `# The public identity list (password hint included, deliberately):
curl -s localhost:4000/api/demo/auth/users | jq

# Log in as alice — note the Set-Cookie header in the response:
curl -si -X POST localhost:4000/api/demo/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"alice","password":"guide-demo-pw"}' | grep -Ei '^(HTTP|set-cookie)'
# → Set-Cookie: guide_session=<43-char-token>; Path=/; HttpOnly; SameSite=Lax

# The cookie proves identity on every later request (the -c/-j pair carries it):
curl -s -c /tmp/guide.jar -X POST localhost:4000/api/demo/auth/login \\
  -H 'Content-Type: application/json' -d '{"username":"alice","password":"guide-demo-pw"}' > /dev/null
curl -s -b /tmp/guide.jar localhost:4000/api/demo/auth/me | jq
# → { "user": {"username":"alice",...}, "session": {"tokenMasked":"…xxxx", ...} }

# Wrong password → the 401 envelope, ONE message for both failure modes:
curl -s -X POST localhost:4000/api/demo/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"alice","password":"wrong"}' | jq '.error'

# Server-side state, visible: active sessions (masked tokens only):
curl -s -b /tmp/guide.jar localhost:4000/api/demo/auth/sessions | jq

# Logout destroys the session AND clears the cookie — then /me is a 401:
curl -si -b /tmp/guide.jar -c /tmp/guide.jar -X POST localhost:4000/api/demo/auth/logout \\
  | grep -Ei '^(HTTP|set-cookie)'
curl -s -b /tmp/guide.jar localhost:4000/api/demo/auth/me | jq '.error.code'   # "unauthorized"`,
        },
      ],
    },
  ],
};
