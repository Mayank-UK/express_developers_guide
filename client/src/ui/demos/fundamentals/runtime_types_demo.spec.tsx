import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RuntimeTypesDemo from './runtime_types_demo';
import { stubApiFetch } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const PREFILLED_BODY = '{"title": 42, "tags": ["a", null]}';

const typesPayload = {
  result: {
    ok: true,
    value: {
      language: 'TypeScript',
      compiledTo: 'plain JavaScript — every type erased before Node runs a line',
      checkedBy: 'tsc with strict mode, at compile time only',
      runtimeKnows: 'typeof strings, Array.isArray, and === null — nothing else',
    },
  },
  narrowing: [
    { value: '"authentication"', check: "typeof value === 'string'", narrowedTo: 'string' },
    { value: '42', check: "typeof value === 'number'", narrowedTo: 'number' },
    { value: '["read","write"]', check: 'Array.isArray(value)', narrowedTo: 'unknown[]' },
    { value: '{"ok":true}', check: 'typeof value === object && value !== null', narrowedTo: 'object' },
    { value: 'null', check: 'value === null', narrowedTo: 'null' },
  ],
};

const echoPayload = {
  received: { title: 42, tags: ['a', null] },
  typeReport: {
    typeof: 'object',
    isArray: false,
    isNull: false,
    entries: [
      { key: 'title', typeof: 'number', isArray: false, isNull: false },
      {
        key: 'tags',
        typeof: 'object',
        isArray: true,
        isNull: false,
        elements: [
          { index: 0, typeof: 'string', isArray: false, isNull: false },
          { index: 1, typeof: 'object', isArray: false, isNull: true },
        ],
      },
    ],
    nullsPresent: true,
  },
};

function stubbedFetchMock(routes: Parameters<typeof stubApiFetch>[0]) {
  stubApiFetch(routes);
  return vi.mocked(fetch);
}

describe('RuntimeTypesDemo', () => {
  it('renders the GET showcase: the Result value and the narrowing trace', async () => {
    stubbedFetchMock([
      { url: '/api/demo/ts/types', body: typesPayload },
      { url: '/api/demo/ts/echo', body: echoPayload },
    ]);

    render(<RuntimeTypesDemo />);

    const fields = await screen.findByTestId('ts-types-fields');
    expect(fields).toHaveTextContent('TypeScript');
    expect(fields).toHaveTextContent('tsc with strict mode, at compile time only');
    expect(fields).toHaveTextContent('typeof strings, Array.isArray, and === null');

    const trace = await screen.findByTestId('ts-types-narrowing');
    expect(trace).toHaveTextContent("typeof value === 'string'");
    expect(trace).toHaveTextContent('Array.isArray(value)');
    expect(trace).toHaveTextContent('value === null');

    // The form starts prefilled, ready to POST.
    expect(screen.getByTestId('ts-echo-input')).toHaveValue(PREFILLED_BODY);
    expect(screen.getByRole('button', { name: 'POST it' })).toBeInTheDocument();
  });

  it('POSTs the textarea content and renders the type report', async () => {
    const fetchMock = stubbedFetchMock([
      { url: '/api/demo/ts/types', body: typesPayload },
      { url: '/api/demo/ts/echo', body: echoPayload },
    ]);

    render(<RuntimeTypesDemo />);
    await screen.findByTestId('ts-types-fields');

    fireEvent.click(screen.getByTestId('ts-echo-submit'));

    const report = await screen.findByTestId('ts-echo-report');
    expect(report).toHaveTextContent('"title": 42');
    expect(report).toHaveTextContent('title');
    expect(report).toHaveTextContent('tags');
    expect(report).toHaveTextContent('tags[1]');
    expect(screen.getByTestId('ts-echo-nulls')).toHaveTextContent('nulls present: yes');

    // The echo request went out as a real JSON POST.
    const echoCalls = fetchMock.mock.calls.filter(([input]) => String(input) === '/api/demo/ts/echo');
    expect(echoCalls).toHaveLength(1);
    const init = echoCalls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    // JSON.stringify re-serializes the parsed prefill without its spaces.
    expect(init?.body).toBe('{"title":42,"tags":["a",null]}');
  });

  it('shows a friendly error for invalid JSON and sends nothing', async () => {
    const fetchMock = stubbedFetchMock([
      { url: '/api/demo/ts/types', body: typesPayload },
      { url: '/api/demo/ts/echo', body: echoPayload },
    ]);

    render(<RuntimeTypesDemo />);
    await screen.findByTestId('ts-types-fields');

    fireEvent.change(screen.getByTestId('ts-echo-input'), { target: { value: '{oops' } });
    fireEvent.click(screen.getByTestId('ts-echo-submit'));

    const alert = await screen.findByTestId('ts-echo-error');
    expect(alert).toHaveTextContent('not valid JSON');
    // Client-side rejection: the echo endpoint was never called.
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('/api/demo/ts/echo');
  });

  it('shows the server error message when the echo endpoint fails', async () => {
    stubbedFetchMock([
      { url: '/api/demo/ts/types', body: typesPayload },
      {
        url: '/api/demo/ts/echo',
        status: 500,
        body: { error: { code: 'internal_error', message: 'boom', requestId: 'req-1' } },
      },
    ]);

    render(<RuntimeTypesDemo />);
    await screen.findByTestId('ts-types-fields');

    fireEvent.click(screen.getByTestId('ts-echo-submit'));

    const alert = await screen.findByTestId('ts-echo-error');
    expect(alert).toHaveTextContent('boom');
  });

  it('shows the showcase error panel when the types endpoint fails', async () => {
    stubbedFetchMock([
      {
        url: '/api/demo/ts/types',
        status: 500,
        body: { error: { code: 'internal_error', message: 'nope', requestId: 'req-2' } },
      },
      { url: '/api/demo/ts/echo', body: echoPayload },
    ]);

    render(<RuntimeTypesDemo />);

    const alert = await screen.findByTestId('ts-types-error');
    expect(alert).toHaveTextContent('nope');
    expect(screen.queryByTestId('ts-types-fields')).not.toBeInTheDocument();
  });
});
