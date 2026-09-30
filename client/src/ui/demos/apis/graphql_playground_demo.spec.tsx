import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import GraphqlPlaygroundDemo from './graphql_playground_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const GRAPHQL_URL = '/api/graphql';

const SEED_DATA = {
  posts: [
    { id: '0f1c2b3a-0000-4000-8000-000000000003', title: 'Failures are values here' },
    { id: '0f1c2b3a-0000-4000-8000-000000000002', title: 'The dependency rule, concretely' },
  ],
};

const CREATED_POST = {
  createPost: {
    id: '9b8c7d6e-0000-4000-8000-00000000feed',
    title: 'One endpoint, client-shaped',
    createdAt: '2026-09-28T19:00:00.000Z',
  },
};

describe('GraphqlPlaygroundDemo — the prefilled query', () => {
  it('runs { posts { id title } } on mount and renders the data panel', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: GRAPHQL_URL, body: { data: SEED_DATA } }]);
      return vi.mocked(fetch);
    })();

    render(<GraphqlPlaygroundDemo />);

    const data = await screen.findByTestId('graphql-playground-response-data');
    expect(data).toHaveTextContent('Failures are values here');
    expect(screen.getByTestId('graphql-playground-no-errors')).toBeInTheDocument();
    expect(screen.queryByTestId('graphql-playground-response-errors')).not.toBeInTheDocument();
    expect(screen.getByTestId('graphql-playground-status')).toHaveTextContent('200');

    // The envelope carried the prefilled document and NO variables key.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.query).toBe('{ posts { id title } }');
    expect('variables' in body).toBe(false);
  });

  it('degrades to a network-failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<GraphqlPlaygroundDemo />);

    const failed = await screen.findByTestId('graphql-playground-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});

describe('GraphqlPlaygroundDemo — editing and presets', () => {
  it('the mutation preset loads document + variables, and RUN sends them as { query, variables }', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: GRAPHQL_URL, body: { data: CREATED_POST } }]);
      return vi.mocked(fetch);
    })();

    render(<GraphqlPlaygroundDemo />);
    await screen.findByTestId('graphql-playground-response-data');

    fireEvent.click(screen.getByTestId('graphql-playground-preset-mutation'));
    expect((screen.getByTestId('graphql-playground-query') as HTMLTextAreaElement).value).toContain(
      'mutation Create($title: String!',
    );
    expect(
      JSON.parse(String((screen.getByTestId('graphql-playground-variables') as HTMLTextAreaElement).value)),
    ).toEqual({
      title: 'One endpoint, client-shaped',
      body: 'The client asked for exactly this.',
      author: 'you',
    });

    fireEvent.click(screen.getByTestId('graphql-playground-run'));
    const data = await screen.findByTestId('graphql-playground-response-data');
    expect(data).toHaveTextContent('One endpoint, client-shaped');

    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({
      title: 'One endpoint, client-shaped',
      body: 'The client asked for exactly this.',
      author: 'you',
    });
  });

  it('the posts preset resets the editor (query in, variables out)', async () => {
    stubApiFetch([{ url: GRAPHQL_URL, body: { data: SEED_DATA } }]);

    render(<GraphqlPlaygroundDemo />);
    await screen.findByTestId('graphql-playground-response-data');

    fireEvent.click(screen.getByTestId('graphql-playground-preset-mutation'));
    fireEvent.change(screen.getByTestId('graphql-playground-query'), {
      target: { value: '{ draft ' },
    });

    fireEvent.click(screen.getByTestId('graphql-playground-preset-posts'));
    expect(screen.getByTestId('graphql-playground-query')).toHaveValue('{ posts { id title } }');
    expect(screen.getByTestId('graphql-playground-variables')).toHaveValue('');
  });

  it('refuses to send variables that are not a JSON object', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: GRAPHQL_URL, body: { data: SEED_DATA } }]);
      return vi.mocked(fetch);
    })();

    render(<GraphqlPlaygroundDemo />);
    await screen.findByTestId('graphql-playground-response-data');

    fireEvent.change(screen.getByTestId('graphql-playground-variables'), { target: { value: 'not json' } });
    fireEvent.click(screen.getByTestId('graphql-playground-run'));

    const failed = await screen.findByTestId('graphql-playground-failed');
    expect(failed).toHaveTextContent('variables must be a JSON object');
    expect(fetchMock).toHaveBeenCalledTimes(1); // the second run never fired
  });
});

describe('GraphqlPlaygroundDemo — the errors channel', () => {
  it('renders an errors array with extensions.code chips (the injected-503 shape)', async () => {
    stubApiFetch([
      {
        url: GRAPHQL_URL,
        body: {
          data: null,
          errors: [
            {
              message: 'Failure injection is ON — this is the demo 503',
              path: ['posts'],
              extensions: { code: 'service_unavailable' },
            },
          ],
        },
      },
    ]);

    render(<GraphqlPlaygroundDemo />);

    const errorsPanel = await screen.findByTestId('graphql-playground-response-errors');
    expect(errorsPanel).toHaveTextContent('Failure injection is ON');
    expect(screen.getAllByTestId('graphql-playground-error-code')[0]).toHaveTextContent('service_unavailable');
    expect(errorsPanel).toHaveTextContent('path: ["posts"]');
    // data rode along as an explicit null — rendered, not hidden.
    expect(screen.getByTestId('graphql-playground-response-data')).toHaveTextContent('null');
  });

  it('shows partial data and errors together when a nullable field fails', async () => {
    stubApiFetch([
      {
        url: GRAPHQL_URL,
        body: {
          data: { post: null, posts: SEED_DATA.posts },
          errors: [
            {
              message: 'no post with id "none"',
              path: ['post'],
              extensions: { code: 'not_found', postId: 'none' },
            },
          ],
        },
      },
    ]);

    render(<GraphqlPlaygroundDemo />);

    await screen.findByTestId('graphql-playground-response-errors');
    const data = screen.getByTestId('graphql-playground-response-data');
    expect(data).toHaveTextContent('The dependency rule, concretely');
    expect(screen.getAllByTestId('graphql-playground-error-code')[0]).toHaveTextContent('not_found');
  });
});
