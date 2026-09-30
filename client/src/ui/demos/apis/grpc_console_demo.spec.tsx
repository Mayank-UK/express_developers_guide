import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import GrpcConsoleDemo from './grpc_console_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATUS_URL = '/api/demo/grpc/status';
const INVOKE_URL = '/api/demo/grpc/invoke';

const PROTO_TEXT = `syntax = "proto3";

package guide.v1;

service PostsService {
  rpc ListPosts (ListPostsRequest) returns (PostsList);
}`;

const STATUS_BODY = {
  running: true,
  port: 50051,
  service: 'guide.v1.PostsService',
  methods: [
    { method: 'ListPosts', path: '/guide.v1.PostsService/ListPosts' },
    { method: 'GetPost', path: '/guide.v1.PostsService/GetPost' },
    { method: 'CreatePost', path: '/guide.v1.PostsService/CreatePost' },
  ],
  proto: PROTO_TEXT,
};

const LIST_RESPONSE = {
  method: 'ListPosts',
  status: 'OK',
  code: 0,
  response: {
    posts: [
      { id: '0f1c2b3a-0000-4000-8000-000000000003', title: 'Failures are values here', createdAt: '2026-09-24T09:10:00.000Z' },
      { id: '0f1c2b3a-0000-4000-8000-000000000002', title: 'The dependency rule, concretely', createdAt: '2026-09-24T09:05:00.000Z' },
    ],
  },
};

describe('GrpcConsoleDemo — the status panel', () => {
  it('renders the service name, wire paths, port and the proto source', async () => {
    stubApiFetch([{ url: STATUS_URL, body: STATUS_BODY }]);

    render(<GrpcConsoleDemo />);

    const service = await screen.findByTestId('grpc-console-service');
    expect(service).toHaveTextContent('guide.v1.PostsService');
    expect(service).toHaveTextContent('/guide.v1.PostsService/ListPosts');
    expect(screen.getByTestId('grpc-console-port')).toHaveTextContent('running on :50051');

    // The proto source is collapsible and renders VERBATIM once opened.
    expect(screen.queryByTestId('grpc-console-proto')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('grpc-console-proto-toggle'));
    const proto = screen.getByTestId('grpc-console-proto');
    expect(proto).toHaveTextContent('syntax = "proto3"');
    expect(proto).toHaveTextContent('service PostsService');
    expect((proto as HTMLElement).textContent).toContain('rpc ListPosts (ListPostsRequest) returns (PostsList)');
  });

  it('degrades to a status-failure state when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<GrpcConsoleDemo />);

    const failed = await screen.findByTestId('grpc-console-status-failed');
    expect(failed).toHaveTextContent('could not reach the server');
  });
});

describe('GrpcConsoleDemo — invoking rpcs through the bridge', () => {
  it('INVOKE sends { method, payload } and renders the OK response', async () => {
    const fetchMock = (() => {
      stubApiFetch([
        { url: STATUS_URL, body: STATUS_BODY },
        { url: INVOKE_URL, body: LIST_RESPONSE },
      ]);
      return vi.mocked(fetch);
    })();

    render(<GrpcConsoleDemo />);
    await screen.findByTestId('grpc-console-service');

    fireEvent.click(screen.getByTestId('grpc-console-invoke'));

    const response = await screen.findByTestId('grpc-console-response');
    expect(response).toHaveTextContent('Failures are values here');
    expect(screen.getByTestId('grpc-console-status')).toHaveTextContent('OK');
    expect(screen.queryByTestId('grpc-console-error')).not.toBeInTheDocument();

    // The envelope carried the selected method and the parsed payload object.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      method: string;
      payload: Record<string, unknown>;
    };
    expect(body).toEqual({ method: 'ListPosts', payload: {} });
  });

  it('a NOT_FOUND outcome renders the status chip, the message and the trailer facts', async () => {
    stubApiFetch([
      { url: STATUS_URL, body: STATUS_BODY },
      {
        url: INVOKE_URL,
        body: {
          method: 'GetPost',
          status: 'NOT_FOUND',
          code: 5,
          message: 'no post with id "post_0000"',
          failure: { kind: 'not_found', errorCode: 'not_found' },
        },
      },
    ]);

    render(<GrpcConsoleDemo />);
    await screen.findByTestId('grpc-console-service');

    // GetPost's prefilled placeholder id is the not-found demo path itself.
    fireEvent.click(screen.getByTestId('grpc-console-method-getpost'));
    fireEvent.click(screen.getByTestId('grpc-console-invoke'));

    const status = await screen.findByTestId('grpc-console-status');
    expect(status).toHaveTextContent('NOT_FOUND');
    expect(screen.getByTestId('grpc-console-message')).toHaveTextContent('no post with id "post_0000"');
    expect(screen.getByTestId('grpc-console-error')).toHaveTextContent('failure kind: not_found');
    expect(screen.queryByTestId('grpc-console-response-panel')).not.toBeInTheDocument();
  });

  it('switching methods prefills each request message', async () => {
    stubApiFetch([{ url: STATUS_URL, body: STATUS_BODY }]);

    render(<GrpcConsoleDemo />);
    await screen.findByTestId('grpc-console-service');

    fireEvent.click(screen.getByTestId('grpc-console-method-createpost'));
    expect(
      JSON.parse(String((screen.getByTestId('grpc-console-payload') as HTMLTextAreaElement).value)),
    ).toMatchObject({ title: 'A post over HTTP/2' });

    fireEvent.click(screen.getByTestId('grpc-console-method-listposts'));
    expect((screen.getByTestId('grpc-console-payload') as HTMLTextAreaElement).value).toBe('{}');
  });

  it('refuses to send a payload that is not a JSON object', async () => {
    const fetchMock = (() => {
      stubApiFetch([{ url: STATUS_URL, body: STATUS_BODY }]);
      return vi.mocked(fetch);
    })();

    render(<GrpcConsoleDemo />);
    await screen.findByTestId('grpc-console-service');

    fireEvent.change(screen.getByTestId('grpc-console-payload'), { target: { value: 'not json' } });
    fireEvent.click(screen.getByTestId('grpc-console-invoke'));

    const failed = await screen.findByTestId('grpc-console-failed');
    expect(failed).toHaveTextContent('payload must be a JSON object');
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the status fetch — no invoke fired
  });
});
