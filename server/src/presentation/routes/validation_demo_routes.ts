import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { body, checkExact, matchedData, validationResult, type ValidationChain } from 'express-validator';
import Joi from 'joi';
import { ValidationException } from '../../core/error_handling/exceptions.js';

/**
 * Validation demo endpoints (the `validation` topic's three-validator arena).
 *
 * ONE canonical payload shape — title (string 1..80), email (valid address),
 * age (integer 18..120), website (optional https URL), tags (1..5 strings of
 * 1..20 chars) — validated by THREE libraries, each in its own idiom:
 *
 * - POST /api/demo/validation/zod               — schema-as-type + safeParse
 * - POST /api/demo/validation/express-validator — check-chain middleware + validationResult
 * - POST /api/demo/validation/joi               — schema object + validate({ abortEarly: false })
 * - GET  /api/demo/validation/schema            — the canonical rules + sample payloads
 *
 * Success answers 200 { valid: true, validator, payload, notes } (the notes say
 * what THIS library did to the data — coercion, unknown-key handling). Failure
 * throws ValidationException so the global error middleware renders the
 * canonical 400 envelope with TWO payloads under it: `errors`, the normalized
 * [{ field, message }] list every library's native shape was flattened into,
 * and `raw`, the library's own error shape verbatim (ZodError.issues /
 * validationResult().array() / Joi error.details) — the normalization itself
 * is the lesson, so both layers travel together.
 */

export const VALIDATION_DEMO_MOUNT_PATH = '/api/demo/validation';

const TITLE_MIN = 1;
const TITLE_MAX = 80;
const AGE_MIN = 18;
const AGE_MAX = 120;
const TAG_MIN = 1;
const TAG_MAX = 20;
const TAGS_MIN = 1;
const TAGS_MAX = 5;

/** The five fields every validator enforces — the single rule table. */
const KNOWN_FIELDS = ['title', 'email', 'age', 'website', 'tags'] as const;

const UNKNOWN_FIELD_MESSAGE =
  'unknown field — only title, email, age, website and tags are accepted';

/** Field name for object-level failures (non-object body, unrecognized keys). */
const ROOT_FIELD = '(root)';

type ValidatorId = 'zod' | 'express-validator' | 'joi';

const VALIDATORS: readonly ValidatorId[] = ['zod', 'express-validator', 'joi'];

/** The canonical per-field error every library's native shape normalizes to. */
export interface NormalizedFieldError {
  field: string;
  message: string;
}

// --- zod: schema-as-type ------------------------------------------------------

const zodArenaSchema = z
  .object({
    title: z.string().min(TITLE_MIN).max(TITLE_MAX),
    email: z.email(),
    age: z.number().int().min(AGE_MIN).max(AGE_MAX),
    website: z.url({ protocol: /^https$/ }).optional(),
    tags: z.array(z.string().min(TAG_MIN).max(TAG_MAX)).min(TAGS_MIN).max(TAGS_MAX),
  })
  .strict(); // unknown keys are REJECTED (stripping is the default in z.object)

function zodArenaController(req: Request, res: Response): void {
  const parsed = zodArenaSchema.safeParse(req.body);
  if (!parsed.success) {
    const errors: NormalizedFieldError[] = [];
    for (const issue of parsed.error.issues) {
      // zod reports unknown keys at the ROOT with the key names tucked inside
      // the issue — a faithful normalizer expands them to per-field errors.
      if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
        for (const key of issue.keys) {
          errors.push({ field: key, message: UNKNOWN_FIELD_MESSAGE });
        }
        continue;
      }
      errors.push({
        field: issue.path.length > 0 ? issue.path.join('.') : ROOT_FIELD,
        message: issue.message,
      });
    }
    throw new ValidationException(`payload failed zod validation (${String(errors.length)} issue(s))`, {
      validator: 'zod',
      errors,
      raw: { shape: 'ZodError.issues', issues: parsed.error.issues },
    });
  }

  res.json({
    valid: true,
    validator: 'zod',
    payload: parsed.data,
    notes: [
      'safeParse returns { success, data } | { success: false, error } — no exception on the failure path',
      'strict object: unknown keys are REJECTED (code "unrecognized_keys"), not stripped',
      'no coercion: JSON types are literal — the string "42" fails age with invalid_type; only a JSON number passes',
    ],
  });
}

// --- express-validator: middleware chains -------------------------------------

/**
 * The check chains — validation AS MIDDLEWARE, registered on the route below.
 * Each check carries its own message; without withMessage every failure reads
 * the default "Invalid value". v7 note: the standalone sanitize* functions are
 * gone — sanitization lives IN the chains (e.g. body('title').trim()).
 */
const expressValidatorChains: ValidationChain[] = [
  body('title')
    .isString()
    .withMessage('title must be a string')
    .isLength({ min: TITLE_MIN, max: TITLE_MAX })
    .withMessage(`title must be a string of ${String(TITLE_MIN)} to ${String(TITLE_MAX)} characters`),
  body('email').isEmail().withMessage('email must be a valid email address'),
  body('age')
    .isInt({ min: AGE_MIN, max: AGE_MAX })
    .withMessage(`age must be an integer between ${String(AGE_MIN)} and ${String(AGE_MAX)}`),
  body('website')
    .optional()
    .isURL({ protocols: ['https'], require_protocol: true })
    .withMessage('website must be an https:// URL'),
  body('tags')
    .isArray({ min: TAGS_MIN, max: TAGS_MAX })
    .withMessage(`tags must be an array of ${String(TAGS_MIN)} to ${String(TAGS_MAX)} items`),
  body('tags.*')
    .isString()
    .withMessage('each tag must be a string')
    .isLength({ min: TAG_MIN, max: TAG_MAX })
    .withMessage(`each tag must be a string of ${String(TAG_MIN)} to ${String(TAG_MAX)} characters`),
];

/**
 * Normalizes one validationResult entry into { field, message }. Array item
 * paths arrive as "tags[0]" — rewritten to "tags.0" so all three libraries
 * report item failures under the SAME field name.
 */
function normalizedPath(path: string | undefined): string {
  if (path === undefined || path === '') return ROOT_FIELD;
  return String(path).replace(/\[(\d+)\]/g, '.$1');
}

function expressValidatorArenaController(req: Request, res: Response): void {
  // express-validator never looks at the BODY as a whole — chains read fields
  // out of it — so the object-level guard is the controller's job (the same
  // hand-rolled guard the posts use case starts with).
  const received: unknown = req.body;
  if (typeof received !== 'object' || received === null || Array.isArray(received)) {
    throw new ValidationException('payload must be a JSON object', {
      validator: 'express-validator',
      errors: [{ field: ROOT_FIELD, message: 'must be a JSON object' }],
      raw: {
        shape: 'validationResult(req).array()',
        note: 'the chains already ran — their field-level noise is below; only the object-level guard can catch this',
        errors: validationResult(req).array(),
      },
    });
  }

  const result = validationResult(req);
  if (!result.isEmpty()) {
    // checkExact reports unknown keys as ONE "unknown_fields" entry without a
    // path — the field names are recovered here from the body's own keys.
    const unknownKeys = Object.keys(received as Record<string, unknown>).filter(
      (key) => !(KNOWN_FIELDS as readonly string[]).includes(key),
    );
    const errors: NormalizedFieldError[] = [];
    for (const error of result.array()) {
      if (error.type === 'unknown_fields') {
        for (const key of unknownKeys) {
          errors.push({ field: key, message: UNKNOWN_FIELD_MESSAGE });
        }
        continue;
      }
      errors.push({ field: normalizedPath(error.type === 'field' ? error.path : undefined), message: String(error.msg) });
    }

    throw new ValidationException(
      `payload failed express-validator validation (${String(errors.length)} error(s))`,
      {
        validator: 'express-validator',
        errors,
        raw: { shape: 'validationResult(req).array()', errors: result.array() },
      },
    );
  }

  // matchedData returns ONLY the fields that had checks — the output whitelist
  // comes free, and values come back exactly as they were validated.
  res.json({
    valid: true,
    validator: 'express-validator',
    payload: matchedData(req),
    notes: [
      'check chains ran BEFORE this controller as middleware; validationResult(req) reads what they recorded',
      'validators are string-based: isInt accepts the numeric string "42" — and matchedData returns it STILL a string',
      'unknown keys are ignored BY DEFAULT — the checkExact() middleware on this route is what rejects them',
      'matchedData(req) returns only checked fields — the response whitelist comes free',
    ],
  });
}

// --- Joi: schema object --------------------------------------------------------

const joiArenaSchema = Joi.object({
  title: Joi.string().min(TITLE_MIN).max(TITLE_MAX).required(),
  email: Joi.string().email().required(),
  age: Joi.number().integer().min(AGE_MIN).max(AGE_MAX).required(),
  website: Joi.string().uri({ scheme: 'https' }).optional(),
  tags: Joi.array().items(Joi.string().min(TAG_MIN).max(TAG_MAX)).min(TAGS_MIN).max(TAGS_MAX).required(),
}).required(); // without this, Joi validate(undefined) is NOT an error

function joiArenaController(req: Request, res: Response): void {
  const { value, error } = joiArenaSchema.validate(req.body, { abortEarly: false });
  if (error !== undefined) {
    const errors: NormalizedFieldError[] = error.details.map((detail) => ({
      field: detail.path.length > 0 ? detail.path.map(String).join('.') : ROOT_FIELD,
      message: detail.message,
    }));
    throw new ValidationException(`payload failed Joi validation (${String(errors.length)} detail(s))`, {
      validator: 'joi',
      errors,
      raw: { shape: 'ValidationError.details', details: error.details },
    });
  }

  res.json({
    valid: true,
    validator: 'joi',
    payload: value,
    notes: [
      'abortEarly: false — every field error is collected (Joi would stop at the first by default)',
      'type conversion is ON by default: the string "42" is ACCEPTED for age and returned as the number 42',
      'unknown keys are rejected by default (object.unknown) — the opposite default from express-validator',
    ],
  });
}

// --- the canonical rules (served as the demo's form spec) ---------------------

interface ValidationFieldSpec {
  field: string;
  type: string;
  required: boolean;
  rule: string;
}

const FIELD_SPECS: readonly ValidationFieldSpec[] = [
  {
    field: 'title',
    type: 'string',
    required: true,
    rule: `${String(TITLE_MIN)} to ${String(TITLE_MAX)} characters`,
  },
  { field: 'email', type: 'string', required: true, rule: 'a valid email address' },
  {
    field: 'age',
    type: 'integer',
    required: true,
    rule: `between ${String(AGE_MIN)} and ${String(AGE_MAX)}`,
  },
  {
    field: 'website',
    type: 'string',
    required: false,
    rule: 'optional; when present, an https:// URL',
  },
  {
    field: 'tags',
    type: 'array of strings',
    required: true,
    rule: `${String(TAGS_MIN)} to ${String(TAGS_MAX)} items, each ${String(TAG_MIN)} to ${String(TAG_MAX)} characters`,
  },
];

/** A payload that satisfies every rule — all three validators accept it. */
const SAMPLE_VALID = {
  title: 'Ship the three-validators demo',
  email: 'ada@example.com',
  age: 36,
  website: 'https://example.com',
  tags: ['express', 'validation'],
} as const;

/**
 * A payload that breaks four rules at once (title too long, bad email, age
 * below range, six tags) — all three validators reject it with the SAME
 * normalized field set { title, email, age, tags }.
 */
const SAMPLE_INVALID = {
  title:
    'This title is intentionally longer than the eighty-character maximum allowed by design',
  email: 'not-an-email',
  age: 5,
  website: 'https://example.com', // valid on purpose — only the four fields above fail
  tags: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
} as const;

function schemaController(_req: Request, res: Response): void {
  res.json({
    mountPath: VALIDATION_DEMO_MOUNT_PATH,
    objectRule: 'the payload must be a JSON object; unknown fields are rejected by all three validators',
    fields: FIELD_SPECS,
    endpoints: VALIDATORS.map((validator) => ({
      validator,
      method: 'POST',
      path: `${VALIDATION_DEMO_MOUNT_PATH}/${validator}`,
    })),
    sampleValid: SAMPLE_VALID,
    sampleInvalid: SAMPLE_INVALID,
  });
}

export const validationDemoRouter = Router();
validationDemoRouter.get('/demo/validation/schema', schemaController);
validationDemoRouter.post('/demo/validation/zod', zodArenaController);
// checkExact runs the chains it wraps AND rejects unknown keys. Do NOT also
// spread the chains after it: they would run twice and every field error
// would be recorded twice (the demo spec proves the single-run behavior).
validationDemoRouter.post(
  '/demo/validation/express-validator',
  checkExact(expressValidatorChains, { message: UNKNOWN_FIELD_MESSAGE }),
  expressValidatorArenaController,
);
validationDemoRouter.post('/demo/validation/joi', joiArenaController);
