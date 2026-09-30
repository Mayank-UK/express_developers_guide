import type { Topic } from '../types.js';

/**
 * The validation and serialization topic: what to do with data at the moment
 * it crosses into your process (validation) and out of it (serialization).
 * Concept-first (trust boundaries, the three validation layers, DTO mapping),
 * then the three schema libraries this app's arena demonstrates side by side —
 * zod, express-validator, Joi — each in its own idiom, against the same rule
 * table. Hand-rolled validation (this repo's own posts use case) is the
 * baseline the libraries are measured against. Snippets from this repo are
 * marked verbatim; illustrative sketches say so in their captions.
 */
export const topicValidation: Topic = {
  id: 'validation',
  title: 'Validation and Serialization',
  subtitle:
    'express-validator, zod, and Joi at the boundary — DTOs in, trusted data out.',
  group: 'middleware-request',
  order: 4,
  sections: [
    {
      id: 'validation-boundary',
      title: 'Why validate at the boundary',
      lead: 'Every byte that arrives from outside your process is hostile until proven otherwise — not because clients are evil, but because the network has no type system.',
      blocks: [
        {
          kind: 'text',
          id: 'validation-boundary:trust',
          body: `Concept first: a request body is not data, it is a CLAIM about data. Whatever JSON the client sent could be anything — a string where you expect a number, a field missing, a field you have never heard of, ten megabytes of nesting. TypeScript cannot help you here, and internalizing that is the whole first lesson: types are erased at runtime. The TypeScript fundamentals topic demonstrated this live — the same POST endpoint accepting any-JSON and reporting its runtime type — and the conclusion was that the ONLY thing standing between req.body (unknown) and your domain (Post, CreatePostInput) is a check that runs WHEN THE REQUEST ARRIVES. That moment is the trust boundary: outside it, nothing may be assumed; inside it, everything may. Once a value has crossed a validation you wrote, the rest of the codebase gets to stop worrying — the use case, the repository, the SQL all operate on data that already proved itself.\n\nWhere should that check live? This app's answer, and the one worth copying: in the DOMAIN use case, not in the route. Look at the posts pipeline — the controller (posts_controllers.ts) hands httpRequest.body straight to the use case with zero inspection (the DTO types it unknown and the controller literally passes unknown through), and the use case's create() validates before doing anything else. The reasoning is layered, not stylistic: validation rules are business rules (a post title of 801 characters is a business impossibility, not an HTTP error), so they belong with the business logic; routes stay thin translators; and a use case that validates its own input is safe to call from ANY edge — an HTTP route today, a queue consumer or a CLI tomorrow — without re-trusting the caller. Schema-library placement varies (middleware vs parse-in-place — the next sections show both), but the question to ask is always the domain one: does the rule survive if HTTP disappears? Shape checks do; they should sit with the use case or feed into it. What does NOT belong in the domain is knowledge of the transport — that the input came from JSON, that errors should carry an HTTP status. That is why the failure that validation produces here is a typed Failure ('validation') which the presentation edge translates to HTTP 400 — the domain never says "400".`,
        },
        {
          kind: 'code',
          id: 'validation-boundary:where',
          language: 'ts',
          caption:
            'server/src/domain/posts/post_usecases.ts — verbatim (dedented): the use case\u2019s create(), where the trust boundary actually is. The controller it serves (posts_controllers.ts, also verbatim) quoted in the comments — it trusts NOTHING and validates NOTHING',
          source: 'server/src/domain/posts/post_usecases.ts',
          code: `// the controller (posts_controllers.ts, verbatim, dedented): the body is
// unknown and it stays unknown — validation is somebody else's job, and
// that somebody is the use case it hands it to:
//   async create(httpRequest: HttpRequest): Promise<HttpResponse> {
//     const result = await createPost(httpRequest.body);   // unknown in
//     if (!result.ok) throw failureToException(result.error);
//     return { status: 201, body: result.value };
//   }

// the use case (verbatim): the trust boundary is HERE — nothing runs until
// the payload proves itself through the ENTITY's gate (validatePostDraft
// lives in post.ts; the use case orchestrates, the entity decides):
async create(raw: unknown): Promise<Result<Post, Failure>> {
  const validated = validatePostDraft(raw);
  if (!validated.ok) return fail(validated.error);   // typed failure, no HTTP
  const injected = injectedFailure();
  if (injected) return fail(injected);
  return selectRepository().create(validated.value); // trusted from here on
}`,
        },
        {
          kind: 'text',
          id: 'validation-boundary:cost',
          body: `The cost of skipping this is never a loud crash — it is a slow rot. An unvalidated string reaches a query and becomes an injection vector (the Security topic's department); an unvalidated number reaches a pagination loop and becomes a DoS; an unvalidated enum reaches a switch statement and falls through every case; an unknown field you never noticed is stored, echoed, and eventually LEAKED (the serialization half of this topic). Validation is not paperwork at the door; it is the mechanism that makes every other safety claim in the codebase true. The demo at the bottom of this page enforces one rule table three times — zod, express-validator, Joi — through three real endpoints, and the remarkable thing you will SEE is how much they agree once the rules are written down and how much they differ in defaults, coercion, and error shape until you normalize them.`,
        },
      ],
    },
    {
      id: 'validation-layers',
      title: 'The three validation layers',
      lead: 'Syntax, shape, semantics. Three different questions, three different places they get answered — and confusing them is why "we validate" can still mean "we got pwned".',
      blocks: [
        {
          kind: 'text',
          id: 'validation-layers:three-questions',
          body: `Layer one, SYNTAX: is this even parseable? For a JSON API that question is answered before your code runs — express.json() either parses the body (and puts the result on req.body) or fails with a 400 through the error pipeline, and the request/response topic showed the leftover case: a content-type no parser claims leaves req.body undefined with the bytes still in the stream. Syntax is binary and mostly free. Layer two, SHAPE: does the parsed value have the fields we expect, of the types we expect, within the constraints we expect? Title is a string of 1..80, age is an integer in range, tags is an array of 1..5 strings. Shape is where the schema libraries live — zod, Joi, express-validator are all, at heart, shape engines — and shape is what this topic's arena demonstrates. Layer three, SEMANTICS: ignoring shape, is this request MEANINGFUL? Does the referenced account exist, is the email already taken, does the discount apply after the start date, is this slug unique? Semantics need the database or cross-field business context, which is exactly why schema libraries do not handle them: they are use-case and repository territory. This app's split is the clean reference — the posts use case's create() does shape (validatePostDraft, the entity's own rules) AND semantics (uniqueness would be the repository's conflict failure), while the route and controller do neither.\n\nTwo rules keep the layers honest. First, validate at the layer that can actually answer: shape before touching the database, semantics with it — checking uniqueness for a payload that already failed shape validation wastes a query and races the answer. Second, collect ALL shape errors, not the first: a form with six bad fields that reports them one round-trip at a time is a UX failure mode older than REST (and the reason the arena's Joi endpoint passes abortEarly: false). The envelope this app renders carries the complete list — error.errors as { field, message } — precisely so the client can mark every field at once.`,
        },
        {
          kind: 'code',
          id: 'validation-layers:map',
          language: 'txt',
          caption: 'The three layers on one payload — who answers each question in this repo',
          code: `layer        question                          answered by                     failure looks like
----------   -------------------------------   -----------------------------   ------------------------
syntax       is it parseable JSON?             express.json() (before routes)   400 envelope, parser's own
                                             — unmatched content-type leaves   message; or req.body is
                                             req.body undefined (guard!)       undefined → your guard

shape        right fields, types, ranges?      use case (hand-rolled or         400 envelope with
                                             schema library)                   error.errors: [{field,message}]

semantics    meaningful in this business?      use case + repository            404/409 envelope — a
                                             (existence, uniqueness,           DOMAIN failure, not a
                                             cross-field rules)                shape failure`,
        },
      ],
    },
    {
      id: 'validation-handrolled',
      title: 'Hand-rolled validation',
      lead: 'The baseline every library has to beat: plain TypeScript, no dependencies, and this repo actually runs it in production code paths.',
      blocks: [
        {
          kind: 'text',
          id: 'validation-handrolled:when',
          body: `Before the libraries, look at what has to be written anyway — because hand-rolling is not a straw man. This app's posts ENTITY validates create payloads with zero dependencies (validatePostDraft lives in post.ts, beside the interface it protects; the use case calls it and stays thin): a type guard for the object itself, a loop that rejects unknown keys, and one rule function per field that appends to a FieldErrors record. Everything a schema library sells you is visible here in miniature: type checks (typeof value !== 'string'), constraints (length ranges with the offending count in the message), required-ness (the rule fails on anything non-string, including absent), unknown-key rejection (only title, body and author are accepted), and — the part people forget to hand-roll — a failure shape the caller can render (Record<field, message>, which becomes the failure's details and rides the canonical envelope out as error.fields).\n\nWhen is this fine? When the shapes are few, flat, and stable — this function is ~40 lines, has zero install weight, and any TypeScript reader can audit it in one screen. When does it start losing? The moment you add nesting (a Review with an Author with an Address — now you are writing a recursive walker), coercion decisions, branded inference (hand-rolled checks do not produce a NEW type; the as string cast at the end is a promise, not a proof — the one dishonest line in the file, safe only because the rule above it checked), or a second consumer that needs the same rules client-side. That last one is the modern killer: the form in your React app wants the same 1..80 title rule WITHOUT a server round-trip, and hand-rolled rules do not travel. That is the gap schema libraries close — a schema is a value you can import on both sides of the wire.`,
        },
        {
          kind: 'code',
          id: 'validation-handrolled:verbatim',
          language: 'ts',
          caption: 'server/src/domain/posts/post.ts — verbatim (annotations added): the entity\u2019s own hand-rolled validator — the invariants live WITH the entity; the use case just calls them',
          source: 'server/src/domain/posts/post.ts',
          code: `type FieldErrors = Record<string, string>;          // field → human message

function addFieldRule(
  fields: FieldErrors,
  record: Record<string, unknown>,
  name: (typeof POST_DRAFT_FIELDS)[number],
  max: number,
): void {
  const value = record[name];
  if (typeof value !== 'string') {                   // type + required in one check
    fields[name] = \`must be a string of 1 to \${max} characters\`;
    return;
  }
  if (value.length < 1 || value.length > max) {      // constraint, with the count
    fields[name] = \`must be a string of 1 to \${max} characters (got \${value.length})\`;
  }
}

export function validatePostDraft(raw: unknown): Result<PostDraft, Failure> {
  // 1) the object guard — arrays and null are objects too, say so explicitly:
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail(
      failure('validation', 'post payload must be a JSON object', {
        fields: { body: 'must be a JSON object' },
      }),
    );
  }
  const record = raw as Record<string, unknown>;
  const fields: FieldErrors = {};
  // 2) unknown keys are rejected — a whitelist, not a blacklist:
  for (const key of Object.keys(record)) {
    if (!(POST_DRAFT_FIELDS as readonly string[]).includes(key)) {
      fields[key] = 'unknown field — only title, body and author are accepted';
    }
  }
  // 3) one rule per known field; ALL errors collected, never the first:
  addFieldRule(fields, record, 'title', TITLE_MAX);
  addFieldRule(fields, record, 'body', BODY_MAX);
  addFieldRule(fields, record, 'author', AUTHOR_MAX);

  if (Object.keys(fields).length > 0) {
    return fail(failure('validation', 'post payload is invalid', { fields }));
  }
  // 4) the one dishonest line — safe ONLY because the rules above ran:
  return ok({
    title: record.title as string,
    body: record.body as string,
    author: record.author as string,
  });
}`,
        },
      ],
    },
    {
      id: 'validation-zod',
      title: 'Schema validators: zod',
      lead: 'Define the schema once, get the validator AND the TypeScript type from it — parse, don\u2019t assert. The most TS-native of the three.',
      blocks: [
        {
          kind: 'text',
          id: 'validation-zod:concept',
          body: `zod's pitch is a single sentence: schema-as-type. You write the schema as a value (z.object({...})), and the type is DERIVED from it — type PostInput = z.infer<typeof schema> — so the type and the runtime check can never drift apart the way an interface and a hand-rolled validator can. The idiom is parse, don't assert: instead of receiving unknown and casting (the dishonest as string above), you call schema.safeParse(raw) and get back a discriminated union — { success: true, data } where data is TYPED as the inferred shape, or { success: false, error } with a ZodError. The success branch's data is not the input; it is a new value zod produced, which is what makes zod's defaults matter: z.object STRIPS unknown keys by default (the parsed output simply omits them — different from this app's hand-rolled reject, which is why the arena's schema is .strict()), and zod performs NO type coercion by default — a JSON string "42" is not a number and fails z.number() with invalid_type. Both defaults are opt-out-able (.strict() to reject instead of strip, z.coerce.number() to accept stringly input), but the philosophy is literal: JSON types are the truth.\n\nTwo more zod habits the arena shows. safeParse over parse: parse throws on failure (fine inside a pipeline of your own), safeParse returns — cleaner at an HTTP boundary where the failure path is normal traffic, not an exception. And v4 moved the string format checks to top-level functions — z.email(), z.url({ protocol: /^https$/ }) instead of the deprecated z.string().email() — the arena uses the modern form. Teams reach for zod when TypeScript is the backbone: shared client/server schemas (the same value imported by the React form and the Express route — the hand-roller's unfixable gap), config/env parsing, and anywhere the inferred type saves you writing the shape twice.`,
        },
        {
          kind: 'code',
          id: 'validation-zod:verbatim',
          language: 'ts',
          caption: 'server/src/presentation/routes/validation_demo_routes.ts — verbatim (normalizer loop abbreviated with elisions): the arena\u2019s zod schema and its safeParse controller (one rule from the canonical table per line)',
          source: 'server/src/presentation/routes/validation_demo_routes.ts',
          code: `const zodArenaSchema = z
  .object({
    title: z.string().min(TITLE_MIN).max(TITLE_MAX),   // string, 1..80
    email: z.email(),                                  // v4 top-level format check
    age: z.number().int().min(AGE_MIN).max(AGE_MAX),   // integer, 18..120 — a JSON
                                                      // NUMBER; "42" fails invalid_type
    website: z.url({ protocol: /^https$/ }).optional(),// https-only URLs, optional
    tags: z.array(z.string().min(TAG_MIN).max(TAG_MAX)).min(TAGS_MIN).max(TAGS_MAX),
  })
  .strict();  // unknown keys REJECTED — plain z.object would STRIP them silently

function zodArenaController(req: Request, res: Response): void {
  const parsed = zodArenaSchema.safeParse(req.body);   // req.body is unknown — fine
  if (!parsed.success) {
    const errors: NormalizedFieldError[] = [];
    for (const issue of parsed.error.issues) {
      // zod reports unknown keys at the ROOT with the key names tucked inside
      // the issue — a faithful normalizer expands them to per-field errors.
      // …unrecognized_keys expansion + the plain { field, message } push,
      // elided — issue.path joins with '.', '(root)' for path []…
    }
    throw new ValidationException(\`payload failed zod validation (\${String(errors.length)} issue(s))\`, {
      validator: 'zod',
      errors,
      raw: { shape: 'ZodError.issues', issues: parsed.error.issues },
    });
  }

  res.json({
    // …valid, validator, payload: parsed.data, notes — elided…
  });
  // parsed.data is a NEW value, TYPED by inference — not a cast of the input
}`,
        },
        {
          kind: 'text',
          id: 'validation-zod:issues',
          body: `The error side is where zod's engineering shows: ZodError.issues is a flat, machine-readable array — each issue carries a code (invalid_type, too_big, too_small, invalid_format, unrecognized_keys), a path as an ARRAY of keys/indexes (['tags', 0] — which is why joining with '.' yields 'tags.0' and matches every other library once normalized), and a human message. Codes are stable enough to switch on (map too_big on age to "out of range" in your UI without string-matching English), and messages are decent by default and overridable per-check with { message }. One zod-specific wrinkle the arena normalizes for you: unrecognized keys are reported at the ROOT (path []) with the key names inside the issue's keys property — the arena's normalizer expands them into per-field errors so all three libraries report unknown fields the same way. That last sentence is the pattern to copy: a library's native error shape is for ITS ecosystem; your HTTP envelope should speak ONE normalized dialect.`,
        },
      ],
    },
    {
      id: 'validation-express-validator',
      title: 'express-validator',
      lead: 'Validation as middleware: check chains declared ON the route, results collected in req, read in the controller. The most Express-shaped of the three.',
      blocks: [
        {
          kind: 'text',
          id: 'validation-express-validator:concept',
          body: `express-validator does not parse anything — it is a layer AROUND your routes. You declare chains — body('title').isString().isLength({ min: 1, max: 80 }) — and mount them as middleware before the controller; each chain reads its field out of req (body, param, query, header, cookie each have their own function), runs its checks as the request passes through, and records the outcome onto the request itself. The controller then calls validationResult(req) to read the verdict: empty means valid, otherwise .array() gives every failed check. That middleware shape is the whole personality: validation lives in the ROUTE DECLARATION (glance at the router and you see the contract), it composes with the pipeline discipline from the middleware topic (chains are just middlewares — they call next() whether they pass or fail; rejecting is still the controller's job), and the same check API covers params and query strings, which the parse-heavy libraries make you wire separately.\n\nThree v7 facts the arena encodes. First, validators are STRING-BASED (they wrap validator.js): isInt({ min: 18 }) accepts the numeric STRING "42" happily — and matchedData() returns the value still as a string; if your domain wants a number, the conversion is on you. Second, unknown keys are IGNORED by default — nothing looks at the body as a whole; v7's checkExact() is the tool that rejects extras, and the arena mounts it wrapped around the chains (careful: checkExact RUNS the chains it wraps — spreading them again after it double-records every error; the arena mounts it alone). Third, the standalone sanitize* functions are gone in v7 — sanitization lives INSIDE the chains as transforms: body('title').trim() before the checks. Strengths: Express-native placement, one API for body/params/query, per-check messages via .withMessage(). Limits: no type inference (matchedData is Record<string, unknown> — you shape it yourself), no shared-schema story (a React form cannot import your route's chain), and the string-first heritage shows at every type boundary.`,
        },
        {
          kind: 'code',
          id: 'validation-express-validator:verbatim',
          language: 'ts',
          caption: 'server/src/presentation/routes/validation_demo_routes.ts — verbatim (the unknown-keys recovery loop elided): the arena\u2019s chains, the checkExact mount, and the controller that reads the verdict',
          source: 'server/src/presentation/routes/validation_demo_routes.ts',
          code: `const expressValidatorChains: ValidationChain[] = [
  body('title')
    .isString()                                        // custom messages, or
    .withMessage('title must be a string')             // every failure reads
    .isLength({ min: TITLE_MIN, max: TITLE_MAX })      // "Invalid value"
    .withMessage(\`title must be a string of \${String(TITLE_MIN)} to \${String(TITLE_MAX)} characters\`),
  body('email').isEmail().withMessage('email must be a valid email address'),
  body('age')
    .isInt({ min: AGE_MIN, max: AGE_MAX })
    .withMessage(\`age must be an integer between \${String(AGE_MIN)} and \${String(AGE_MAX)}\`),
  body('website')                                      // absent is fine…
    .optional()
    .isURL({ protocols: ['https'], require_protocol: true }) // …present must be https
    .withMessage('website must be an https:// URL'),
  body('tags')
    .isArray({ min: TAGS_MIN, max: TAGS_MAX })
    .withMessage(\`tags must be an array of \${String(TAGS_MIN)} to \${String(TAGS_MAX)} items\`),
  body('tags.*')                                       // WILDCARD: every item
    .isString()
    .withMessage('each tag must be a string')
    .isLength({ min: TAG_MIN, max: TAG_MAX })
    .withMessage(\`each tag must be a string of \${String(TAG_MIN)} to \${String(TAG_MAX)} characters\`),
];

// checkExact runs the chains it wraps AND rejects unknown keys — mount it
// INSTEAD of spreading the chains again (double mount = double errors). In
// the real file this registration comes AFTER the controller it names:
function expressValidatorArenaController(req: Request, res: Response): void {
  // express-validator never sees the BODY as a whole — the object guard
  // (not-an-object, arrays) is still the controller's job, by hand:
  const received: unknown = req.body;
  if (typeof received !== 'object' || received === null || Array.isArray(received)) {
    throw new ValidationException('payload must be a JSON object', {
      // …validator, errors: [{ field: '(root)', … }], raw — elided…
    });
  }
  const result = validationResult(req);      // read what the chains recorded
  if (!result.isEmpty()) {
    // …checkExact's unknown_fields entries are recovered from the body's own
    // keys; each remaining entry normalizes through normalizedPath() —
    // 'tags[0]' rewritten to 'tags.0' to match the other two libraries…
    errors.push({ field: normalizedPath(error.type === 'field' ? error.path : undefined), message: String(error.msg) });
    throw new ValidationException(
      \`payload failed express-validator validation (\${String(errors.length)} error(s))\`,
      {
        validator: 'express-validator',
        errors,
        raw: { shape: 'validationResult(req).array()', errors: result.array() },
      },
    );
  }
  res.json({
    // …valid, validator — elided…
    payload: matchedData(req),   // ONLY the checked fields — the whitelist comes free
  });
  // …notes: string-based checks, matchedData whitelist — elided…
}

validationDemoRouter.post(
  '/demo/validation/express-validator',
  checkExact(expressValidatorChains, { message: UNKNOWN_FIELD_MESSAGE }),
  expressValidatorArenaController,
);`,
        },
        {
          kind: 'text',
          id: 'validation-express-validator:fits',
          body: `The verdict shape is worth knowing cold because it is the most common one in the Express ecosystem: an ARRAY with one entry PER FAILED CHECK (a missing title that fails both isString and isLength yields two entries — accumulation is per check, not per field, unlike zod's per-issue and Joi's per-detail), each with type ('field', 'unknown_fields', …), the location and path, the value, and msg — which is whatever you gave .withMessage() or the bare 'Invalid value' default. checkSchema() exists if you prefer declarative JSON over chains. Where express-validator shines: controller-pipeline apps that want validation visible in the route table, mixed sources (params + query + body in one pass), and teams that want zero friction with Express conventions. Where it cedes: TypeScript inference, cross-stack schema sharing, and object-level checks it cannot express.`,
        },
      ],
    },
    {
      id: 'validation-joi',
      title: 'Joi',
      lead: 'The classic: schema objects with a fluent builder, aggressive defaults (type conversion ON, unknown keys rejected), and a preferences system for tuning both. The most battle-hardened of the three.',
      blocks: [
        {
          kind: 'text',
          id: 'validation-joi:concept',
          body: `Joi predates the other two's hype cycles by years (it grew up inside Hapi) and it shows in its defaults: opinionated toward STRICTNESS and FORGIVENESS at once. Strictness — a Joi.object() REJECTS unknown keys by default (object.unknown fires), the opposite of express-validator's ignore and zod's strip; you opt OUT with .unknown(true). Forgiveness — type CONVERSION is on by default: Joi.number() accepts the string "42" and hands you back the number 42, Joi.string() uppercases for .uppercase() after conversion, dates parse from ISO strings. Both defaults are exactly what a decade of form-handling taught: clients send junk keys and stringly numbers, and the server should have an opinion about both. But they are also the two facts you must KNOW, because the arena proves them: the same payload { age: "42" } passes Joi (converted to 42), passes express-validator (kept as "42"), and FAILS zod (invalid_type) — three honest libraries, three philosophies, one wire format.\n\nThe API is schema objects built fluently (Joi.string().min(1).max(80).required()) validated with schema.validate(value, prefs). The prefs object is where the knobs live: abortEarly: false collects every error instead of stopping at the first (the arena sets it — Joi's default single-error behavior would make a terrible form experience), convert: false turns coercion off, presence/allowUnknown tune requiredness. Two gotchas the arena encodes in comments: Joi.object().validate(undefined) is NOT an error unless the object itself is .required() (the arena appends .required()), and async rules (unique-email-in-db) live in .external() / validateAsync — semantics, not shape, so they belong in the use case anyway, but Joi can host them. Error side: ValidationError.details, one entry PER FIELD (Joi accumulates per field, not per check), each with path as an array, a stable type ('string.max', 'number.min', 'array.max', 'object.unknown'), a message that quotes the field name, and a context object with the actual values. The messages are the most English-teacher-like of the three out of the box.`,
        },
        {
          kind: 'code',
          id: 'validation-joi:verbatim',
          language: 'ts',
          caption: 'server/src/presentation/routes/validation_demo_routes.ts — verbatim (success branch\u2019s notes elided): the arena\u2019s Joi schema and controller (abortEarly: false so EVERY error returns)',
          source: 'server/src/presentation/routes/validation_demo_routes.ts',
          code: `const joiArenaSchema = Joi.object({
  title: Joi.string().min(TITLE_MIN).max(TITLE_MAX).required(),
  email: Joi.string().email().required(),
  age: Joi.number().integer().min(AGE_MIN).max(AGE_MAX).required(),
    // conversion is ON: the string "42" is accepted → returned as 42
    // (convert: false in prefs would make Joi behave like zod here)
  website: Joi.string().uri({ scheme: 'https' }).optional(),
  tags: Joi.array().items(Joi.string().min(TAG_MIN).max(TAG_MAX)).min(TAGS_MIN).max(TAGS_MAX).required(),
    // item schema + array bounds — one fluent line in the real file
}).required(); // without this, Joi validate(undefined) is NOT an error!

function joiArenaController(req: Request, res: Response): void {
  // abortEarly: false — collect EVERY field error (Joi stops at the first
  // by default, which makes for one-round-trip-at-a-time forms):
  const { value, error } = joiArenaSchema.validate(req.body, { abortEarly: false });
  if (error !== undefined) {
    const errors: NormalizedFieldError[] = error.details.map((detail) => ({
      field: detail.path.length > 0 ? detail.path.map(String).join('.') : ROOT_FIELD,
      message: detail.message,    // '"tags[0]" is not allowed to be empty'
    }));                          // type: 'string.empty' — stable, switchable
    throw new ValidationException(\`payload failed Joi validation (\${String(errors.length)} detail(s))\`, {
      validator: 'joi',
      errors,
      raw: { shape: 'ValidationError.details', details: error.details },
    });
  }
  res.json({
    // …valid, validator — elided…
    payload: value,
    // …notes: conversion ON, unknown keys rejected by default — elided…
  });
  // value is the CONVERTED, whitelisted copy — Joi strips nothing you
  // declared, converts what it can, and rejects what it doesn't know.
}`,
        },
      ],
    },
    {
      id: 'validation-choosing',
      title: 'Choosing between them',
      lead: 'Three good libraries, three styles, one honest conclusion: any of them, enforced consistently, beats mixing all three in one codebase.',
      blocks: [
        {
          kind: 'text',
          id: 'validation-choosing:axes',
          body: `Run the same rule table through all three — which is exactly what the arena below does — and the differences compress into four axes. STYLE: parse-in-place (zod — a function call in the controller or use case returning a typed value) vs middleware chains (express-validator — declared on the route, read via validationResult) vs schema objects (Joi — validate wherever you want it, no Express coupling). TYPES: zod infers the TypeScript type FROM the schema (single source of truth); the other two leave typing to you (matchedData is Record<string, unknown>; Joi schemas describe runtime only). DEFAULTS: unknown keys — zod strips, Joi rejects, express-validator ignores (until checkExact); coercion — zod none, Joi aggressive conversion, express-validator string-based checks that neither convert nor reject stringly numbers. ECOSYSTEM FIT: express-validator for body+params+query in one pass and route-visible contracts; zod when the schema must be imported by a React form or a config loader; Joi when you want the strictest-by-default object rules, the richest preference system, and a library that has seen every edge case. None of these axes has a wrong answer — they have answers that fit or don't fit YOUR codebase.`,
        },
        {
          kind: 'code',
          id: 'validation-choosing:table',
          language: 'txt',
          caption: 'The three validators on the same canonical rule table — as enforced live by the arena below',
          code: `                       zod 4                  express-validator 7        Joi 18
---------------------  ---------------------  -------------------------  ------------------------
style                  parse in place          middleware chains on the    schema object, validate
                       (safeParse in the       route + validationResult    wherever you call it
                       controller/use case)    in the controller
type story             z.infer — the TYPE      none — matchedData is       none — runtime only
                       comes from the schema   Record<string, unknown>     (TS types are yours)
unknown keys           STRIPPED by default     IGNORED by default          REJECTED by default
                       (.strict() rejects)     (checkExact() rejects)
type coercion          none — "42" fails       validators are string-      conversion ON — "42"
                       age (z.coerce opts in)  based: "42" passes isInt,   becomes 42 (convert:false
                                               returned STILL a string     turns it off)
error shape            error.issues — flat,    validationResult().array()  error.details — one per
                       one per issue, coded    — one per FAILED CHECK,     FIELD, stable types
                       (too_big, invalid_type) path 'tags[0]'
semantics (db rules)   no — use-case territory  no                          .external/validateAsync
shared client schema   yes (the killer feature) no                          possible but TS-less
best when              TS-first, shared         Express-native, mixed       strict defaults, mature
                       client/server schemas    body+params+query           prefs, big legacy apps

the honest advice: ANY of the three, enforced CONSISTENTLY, beats mixing
three ways in one codebase. Pick per codebase, not per endpoint.`,
        },
        {
          kind: 'text',
          id: 'validation-choosing:normalize',
          body: `Whatever you pick, the arena's least glamorous lesson is the one to steal: NORMALIZE AT THE EDGE. Each library's native error shape is well-designed for its own ecosystem and useless as an API contract — ZodError.issues, validationResult arrays, and Joi details all say the same things in different dialects, and a React form should not need three parsers. The arena flattens every one of them into { field, message } before the envelope renders it (including rewriting express-validator's 'tags[0]' to 'tags.0' so array items carry the same name everywhere), while keeping the raw native shape alongside under raw so you can still see what the library actually said. Ten lines of mapping per library buys a client that never knows which validator answered — and the freedom to change your mind later without breaking the contract.`,
        },
      ],
    },
    {
      id: 'validation-serialization',
      title: 'Serialization — the way out',
      lead: 'Validation guards the door IN; serialization guards the door OUT. Same trust boundary, opposite direction — and the leak it prevents is quieter than the one validation prevents.',
      blocks: [
        {
          kind: 'text',
          id: 'validation-serialization:concept',
          body: `Serialization is validation's mirror image: instead of proving foreign data is safe to let IN, it is choosing exactly what your process lets OUT. The failure it prevents has no dramatic exploit name — it is the post entity that someday gains a deleted flag, an internal ownerId, a moderation score, and starts appearing in every API response because the controller returned the whole object. The rule this app enforces with its layering: a DOMAIN OBJECT crosses the boundary only through an explicit mapping, and the mapping WHITELISTS — you list what goes out, never what stays behind. Blacklist serialization ("delete the password field") fails the moment someone adds a field and forgets the list; whitelist serialization fails safe — the new field is simply not in the response until someone deliberately adds it.\n\nThis repo does the mapping twice, once per boundary, and both are boring on purpose. INBOUND, at the data layer: sqlite rows (PostRow — snake_case columns, the database's dialect) never escape the repository; rowToPost maps them to the domain's Post (camelCase, the domain's dialect) on the way up, and postToRow maps back down on the way in. The DTO never leaks past the repository implementation — the same dependency rule the client-side guide enforces as "a view never imports a DTO". OUTBOUND, at the presentation edge: the controllers return domain values (res.json(result.value)) — which is the whole entity today, and the honest note is that this app's whitelist is currently "everything the entity has". The moment a Post grows a field that should not ride the wire, the fix is the same pattern one step further: an explicit toPostResponse(post) mapper in the controller that lists title, body, author, createdAt — and nothing else. Boring, explicit, and auditable at a glance is exactly what you want at a trust boundary.`,
        },
        {
          kind: 'code',
          id: 'validation-serialization:verbatim',
          language: 'ts',
          caption:
            'server/src/data/posts/sqlite_post_repository.ts — verbatim (postToRow\u2019s body elided): the row↔entity mappers at the data boundary (the DTO stays inside). The whitelist pattern for the response edge, illustrative, in the comments — the repo\u2019s controllers currently return entities as-is; this is the shape they grow into',
          source: 'server/src/data/posts/sqlite_post_repository.ts',
          code: `// INBOUND, data layer (verbatim): the row DTO is the DATABASE's dialect;
// it never crosses this file upward.
function rowToPost(row: PostRow): Post {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    author: row.author,
    createdAt: row.created_at,   // snake_case in → camelCase out
    updatedAt: row.updated_at,
  };
}
function postToRow(post: Post): PostRow {
  // …the mirror, on the way down (camelCase in → snake_case out — elided)…
}

// OUTBOUND, presentation edge (illustrative): the response whitelist the
// controllers adopt the day an entity grows a field that must NOT ride the
// wire — list what goes out; never list what stays behind:
//   function toPostResponse(post: Post) {
//     return {
//       id: post.id,
//       title: post.title,
//       body: post.body,
//       author: post.author,
//       createdAt: post.createdAt,
//       // deliberately NOT: internalModerationScore, deletedAt, ownerEmail…
//     };
//   }
// in the controller:
//   res.json(toPostResponse(result.value));   // whitelist per response, auditable`,
        },
        {
          kind: 'text',
          id: 'validation-serialization:tie',
          body: `The two halves of this topic meet in one place: matchedData(req) in the arena. Look at what it does — after the chains have validated title, email, age, website and tags, matchedData returns ONLY those fields, dropping everything else the request carried. That is serialization's whitelist applied to input: the parsed payload this app would hand onward is not the request body; it is the five fields that were checked, nothing more. The symmetry is the mental model worth keeping: every boundary crossing gets an explicit, whitelisted mapping — IN (parse + validate + extract), DOWN/UP (row ↔ entity), OUT (entity → response) — and data that was never listed simply does not travel. Validation decides what may enter; serialization decides what may leave; everything between is allowed to trust both.`,
        },
      ],
    },
    {
      id: 'validation-live',
      title: 'See it live',
      lead: 'One form, one rule table, three validators — fire the same payload at zod, express-validator, and Joi endpoints in parallel and watch them agree on the verdict while disagreeing, revealingly, on everything else.',
      blocks: [
        {
          kind: 'text',
          id: 'validation-live:intro',
          body: `The arena's contract lives at GET /api/demo/validation/schema — the canonical rules (title 1..80, valid email, integer age 18..120, optional https website, 1..5 tags of 1..20 characters), the three endpoints, and a known-valid plus a known-invalid sample. The demo renders its form from that spec, so the UI and the server cannot disagree about the rules. Submit with "all three" selected and the SAME payload is POSTed to /api/demo/validation/zod, /express-validator, and /joi in parallel; each answer becomes a card: the verdict (all three always AGREE on pass/fail for the canonical rules), the normalized { field, message } error list (identical field names across the three — the normalization layer at work, including 'tags.0' for array items), and a collapsible RAW response showing what the library natively said — ZodError.issues with their codes, the validationResult array with one entry per failed check, Joi's details with their stable types. The fun is in the disagreements the raw panels expose: prefill the invalid sample to see all three fail the same four fields at once (Joi and express-validator return every error; that is abortEarly: false and per-check accumulation doing their jobs), then hand-edit age to the STRING "42" — zod fails it as invalid_type while Joi returns 200 with age 42 (converted) and express-validator returns 200 with age "42" (string-based checks, value untouched): three correct libraries, three philosophies, one wire format. Or add a field the rules never mention — all three reject it, each by its own mechanism (.strict(), checkExact, object.unknown).`,
        },
        {
          kind: 'code',
          id: 'validation-live:curl',
          language: 'bash',
          caption: 'drive the arena yourself — the rule table first, then the same payload through each library',
          code: `# The canonical rules + sample payloads (what the demo renders its form from):
curl -s localhost:4000/api/demo/validation/schema | jq

# A VALID payload — all three answer 200 with the SAME parsed payload:
curl -si -X POST -H 'content-type: application/json' \\
  -d '{"title":"Ship the demo","email":"ada@example.com","age":36,"website":"https://example.com","tags":["express","validation"]}' \\
  localhost:4000/api/demo/validation/zod
# (swap the trailing /zod for /express-validator and /joi — identical payload back)

# The KNOWN-INVALID sample — four fields fail everywhere; note each library's
# raw error shape under error.raw, and that the normalized error.errors agree:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"title":"This title is intentionally longer than the eighty-character maximum allowed by design","email":"not-an-email","age":5,"tags":["alpha","beta","gamma","delta","epsilon","zeta"]}' \\
  localhost:4000/api/demo/validation/joi | jq

# The coercion experiment — the same body, three different verdicts:
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"title":"Coerce me","email":"ada@example.com","age":"42","tags":["types"]}' \\
  localhost:4000/api/demo/validation/zod        # 400 — invalid_type on age
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"title":"Coerce me","email":"ada@example.com","age":"42","tags":["types"]}' \\
  localhost:4000/api/demo/validation/joi        # 200 — age came back as 42
curl -s -X POST -H 'content-type: application/json' \\
  -d '{"title":"Coerce me","email":"ada@example.com","age":"42","tags":["types"]}' \\
  localhost:4000/api/demo/validation/express-validator  # 200 — age still "42"`,
        },
        {
          kind: 'demo',
          id: 'validation-live:arena-demo',
          demoId: 'validation:arena',
          title: 'The three-validator arena',
          description:
            'One form validated by three libraries against one rule table: submit to all three endpoints in parallel (or one at a time), and compare verdicts, normalized field errors, and each library\u2019s raw response — including what each one does with a stringly age, an unknown field, or six tags.',
        },
      ],
    },
  ],
};
