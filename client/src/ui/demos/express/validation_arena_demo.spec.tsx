import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ValidationArenaDemo from './validation_arena_demo';
import { stubApiFetch, stubNetworkFailure, type StubRoute } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = '/api/demo/validation';

const VALID_SAMPLE = {
  title: 'Ship the three-validators demo',
  email: 'ada@example.com',
  age: 36,
  website: 'https://example.com',
  tags: ['express', 'validation'],
};

const INVALID_SAMPLE = {
  title:
    'This title is intentionally longer than the eighty-character maximum allowed by design',
  email: 'not-an-email',
  age: 5,
  website: 'https://example.com',
  tags: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
};

/** The schema endpoint's body — the demo renders its whole form from this. */
const SCHEMA_BODY = {
  mountPath: BASE,
  objectRule: 'the payload must be a JSON object; unknown fields are rejected by all three validators',
  fields: [
    { field: 'title', type: 'string', required: true, rule: '1 to 80 characters' },
    { field: 'email', type: 'string', required: true, rule: 'a valid email address' },
    { field: 'age', type: 'integer', required: true, rule: 'between 18 and 120' },
    { field: 'website', type: 'string', required: false, rule: 'optional; when present, an https:// URL' },
    { field: 'tags', type: 'array of strings', required: true, rule: '1 to 5 items, each 1 to 20 characters' },
  ],
  endpoints: [
    { validator: 'zod', method: 'POST', path: `${BASE}/zod` },
    { validator: 'express-validator', method: 'POST', path: `${BASE}/express-validator` },
    { validator: 'joi', method: 'POST', path: `${BASE}/joi` },
  ],
  sampleValid: VALID_SAMPLE,
  sampleInvalid: INVALID_SAMPLE,
};

/** The canonical 400 envelope one validator endpoint answers with. */
function envelope(validator: string, errors: Array<{ field: string; message: string }>, raw: unknown) {
  return {
    error: {
      code: 'validation_failed',
      message: `payload failed ${validator} validation`,
      requestId: '9a1f5c33-7e42-4b08-b5d6-8c7e2f1a0b4c',
      validator,
      errors,
      raw,
    },
  };
}

const INVALID_ERRORS = [
  { field: 'title', message: 'Too big: expected string to have <=80 characters' },
  { field: 'email', message: 'Invalid email address' },
  { field: 'age', message: 'Too small: expected number to be >=18' },
  { field: 'tags', message: 'Too big: expected array to have <=5 items' },
];

/** All four routes: schema + the three failing validator endpoints. */
function stubInvalidRun(): void {
  const routes: StubRoute[] = [{ url: `${BASE}/schema`, body: SCHEMA_BODY }];
  const envelopes = [
    envelope('zod', INVALID_ERRORS, { shape: 'ZodError.issues', issues: [{ code: 'too_big', path: ['title'] }] }),
    envelope('express-validator', INVALID_ERRORS, {
      shape: 'validationResult(req).array()',
      errors: [{ type: 'field', path: 'title', msg: 'title must be a string of 1 to 80 characters' }],
    }),
    envelope('joi', INVALID_ERRORS, {
      shape: 'ValidationError.details',
      details: [{ type: 'string.max', path: ['title'], message: '"title" length must be <= 80' }],
    }),
  ];
  for (const body of envelopes) {
    routes.push({ url: `${BASE}/${String(body.error.validator)}`, status: 400, body });
  }
  stubApiFetch(routes);
}

describe('ValidationArenaDemo — spec load and form', () => {
  it('fetches the rule table on mount and renders the five fields + selector from it', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: `${BASE}/schema`, body: SCHEMA_BODY }]);
      return vi.mocked(fetch);
    })();

    render(<ValidationArenaDemo />);

    await screen.findByTestId('validation-arena-form');

    for (const field of ['title', 'email', 'age', 'website', 'tags']) {
      expect(screen.getByTestId(`validation-arena-field-${field}`)).toHaveValue('');
    }
    const selector = screen.getByTestId('validation-arena-selector');
    expect(selector).toHaveValue('all');
    expect(selector.querySelectorAll('option')).toHaveLength(4);
    expect(screen.getByTestId('validation-arena-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('validation-arena-card-zod')).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${BASE}/schema`);
  });

  it('renders an error panel with retry when the rule table cannot be loaded', async () => {
    stubNetworkFailure();

    render(<ValidationArenaDemo />);

    const error = await screen.findByTestId('validation-arena-spec-error');
    expect(error).toHaveTextContent('could not load the rule table');
    expect(screen.queryByTestId('validation-arena-form')).not.toBeInTheDocument();
  });
});

describe('ValidationArenaDemo — prefill', () => {
  it('loads the known-invalid sample into the form (including all six tags)', async () => {
    stubApiFetch([{ url: `${BASE}/schema`, body: SCHEMA_BODY }]);

    render(<ValidationArenaDemo />);
    await screen.findByTestId('validation-arena-form');

    fireEvent.click(screen.getByTestId('validation-arena-prefill-invalid'));

    expect(screen.getByTestId('validation-arena-field-title')).toHaveValue(INVALID_SAMPLE.title);
    expect(screen.getByTestId('validation-arena-field-email')).toHaveValue('not-an-email');
    expect(screen.getByTestId('validation-arena-field-age')).toHaveValue('5');
    expect(screen.getByTestId('validation-arena-field-tags')).toHaveValue(
      'alpha, beta, gamma, delta, epsilon, zeta',
    );
  });
});

describe('ValidationArenaDemo — submit to all three', () => {
  it('fires THREE POSTs with the form body and renders three failing cards with normalized errors + raw', async () => {
    const fetchMock = (() => {
      stubInvalidRun();
      return vi.mocked(fetch);
    })();

    render(<ValidationArenaDemo />);
    await screen.findByTestId('validation-arena-form');

    fireEvent.click(screen.getByTestId('validation-arena-prefill-invalid'));
    fireEvent.click(screen.getByTestId('validation-arena-submit'));

    await screen.findByTestId('validation-arena-card-joi');

    // Four fires total: the schema GET plus three parallel POSTs.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const posts = fetchMock.mock.calls.slice(1);
    expect(posts.map((call) => String(call[0]))).toEqual([
      `${BASE}/zod`,
      `${BASE}/express-validator`,
      `${BASE}/joi`,
    ]);

    // Every POST carried the SAME form body: age as a JSON number, six tags.
    // (Parsed, not string-compared — key order is not part of the contract.)
    const expectedBody = {
      title: INVALID_SAMPLE.title,
      email: 'not-an-email',
      age: 5,
      website: 'https://example.com',
      tags: INVALID_SAMPLE.tags,
    };
    for (const call of posts) {
      expect(call[1]?.method).toBe('POST');
      expect((call[1]?.headers as Record<string, string>)['content-type']).toBe('application/json');
      expect(JSON.parse(String(call[1]?.body))).toEqual(expectedBody);
    }

    // Three failing cards, each with the normalized field list and raw body.
    for (const validator of ['zod', 'express-validator', 'joi']) {
      const card = screen.getByTestId(`validation-arena-card-${validator}`);
      expect(screen.getByTestId(`validation-arena-verdict-${validator}`)).toHaveTextContent('fail — 400');
      const errors = within(card).getAllByTestId(
        new RegExp(`^validation-arena-error-${validator}-\\d+$`),
      );
      expect(errors).toHaveLength(4);
      expect(errors[0]).toHaveTextContent(/^title — /);
      // Order follows the rule table: title, email, age, tags.
      expect(within(card).getByTestId(`validation-arena-error-${validator}-2`)).toHaveTextContent(
        /^age — /,
      );
      expect(screen.getByTestId(`validation-arena-raw-${validator}`)).toHaveTextContent('validation');
    }

    // The raw panels expose each library's NATIVE shape, not just the envelope.
    expect(screen.getByTestId('validation-arena-raw-zod')).toHaveTextContent('ZodError.issues');
    expect(screen.getByTestId('validation-arena-raw-express-validator')).toHaveTextContent(
      'validationResult(req).array()',
    );
    expect(screen.getByTestId('validation-arena-raw-joi')).toHaveTextContent('ValidationError.details');
  });

  it('renders a passing card with the parsed payload when a validator accepts', async () => {
    stubApiFetch([
      { url: `${BASE}/schema`, body: SCHEMA_BODY },
      {
        url: `${BASE}/joi`,
        status: 200,
        body: { valid: true, validator: 'joi', payload: VALID_SAMPLE, notes: ['type conversion is ON'] },
      },
    ]);

    render(<ValidationArenaDemo />);
    await screen.findByTestId('validation-arena-form');

    fireEvent.click(screen.getByTestId('validation-arena-prefill-valid'));
    fireEvent.change(screen.getByTestId('validation-arena-selector'), { target: { value: 'joi' } });
    fireEvent.click(screen.getByTestId('validation-arena-submit'));

    await screen.findByTestId('validation-arena-card-joi');

    expect(screen.getByTestId('validation-arena-verdict-joi')).toHaveTextContent('pass — 200');
    expect(screen.getByTestId('validation-arena-raw-joi')).toHaveTextContent('type conversion is ON');
    expect(screen.queryByTestId('validation-arena-card-zod')).not.toBeInTheDocument();
    expect(screen.queryByTestId('validation-arena-errors-joi')).not.toBeInTheDocument();
  });

  it('shows an error card per validator when the endpoints are unreachable', async () => {
    // Schema resolves; every POST throws — one fetch double with two behaviors.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === `${BASE}/schema`) {
          return { ok: true, status: 200, json: async () => SCHEMA_BODY };
        }
        throw new TypeError('Failed to fetch');
      }),
    );

    render(<ValidationArenaDemo />);
    await screen.findByTestId('validation-arena-form');

    fireEvent.click(screen.getByTestId('validation-arena-submit'));

    await screen.findByTestId('validation-arena-card-joi');
    for (const validator of ['zod', 'express-validator', 'joi']) {
      expect(screen.getByTestId(`validation-arena-verdict-${validator}`)).toHaveTextContent(
        'error — could not reach the server',
      );
    }
  });
});
