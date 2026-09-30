import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubApiFetch, stubNetworkFailure } from '../../test/fetch_stub';
import { createAppConfig } from '../../core/config';
import { Logger } from '../../core/config/logger';
import { NetworkFailure, ServerFailure } from '../../core/error-handling/failures';
import { ContentRepositoryImpl } from './content-repository-impl';
import { HttpContentRemoteDataSource } from '../remote/content-remote-data-source';
import { createHttpClient } from '../remote/http-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Builds the real remote → repository graph the container wires in the app. */
function makeRepository(): ContentRepositoryImpl {
  const config = createAppConfig();
  return new ContentRepositoryImpl(
    new HttpContentRemoteDataSource(createHttpClient(config)),
    new Logger(config.environment, false),
  );
}

const contentIndex = {
  version: 1,
  groups: [{ id: 'fundamentals', title: 'Fundamentals', order: 1 }],
  topics: [
    { id: 'express-fundamentals', title: 'Express Fundamentals', group: 'fundamentals', order: 1, sectionCount: 4 },
  ],
};

const topic = {
  version: 1,
  id: 'express-fundamentals',
  title: 'Express Fundamentals',
  group: 'fundamentals',
  order: 1,
  sections: [
    { id: 's1', title: 'The section', blocks: [{ kind: 'text', id: 'b1', body: 'The body.' }] },
  ],
};

describe('ContentRepositoryImpl', () => {
  it('returns the mapped domain content index on success', async () => {
    stubApiFetch([{ url: '/api/content', body: contentIndex }]);

    const result = await makeRepository().getContentIndex();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(1);
      expect(result.value.groups[0]).toEqual({ id: 'fundamentals', title: 'Fundamentals', order: 1 });
      expect(result.value.topics[0]?.sectionCount).toBe(4);
    }
  });

  it('returns the mapped domain topic on success', async () => {
    stubApiFetch([{ url: '/api/content/topics/express-fundamentals', body: topic }]);

    const result = await makeRepository().getTopic('express-fundamentals');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('express-fundamentals');
      expect(result.value.sections[0]?.blocks[0]).toEqual({ kind: 'text', id: 'b1', body: 'The body.' });
    }
  });

  it('maps a network failure to a network-kind Failed result (status 0)', async () => {
    stubNetworkFailure();

    const result = await makeRepository().getContentIndex();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBeInstanceOf(NetworkFailure);
      expect(result.failure.kind).toBe('network');
      expect(result.failure.code).toBe('network_error');
      expect(result.failure.status).toBe(0);
      expect(result.failure.message).toBe('Could not reach the server.');
    }
  });

  it('maps an error envelope to a server-kind failure carrying code and status', async () => {
    stubApiFetch([
      {
        url: '/api/content/topics/missing',
        status: 404,
        body: { error: { code: 'not_found', message: 'no topic with id "missing"', requestId: 'req-1' } },
      },
    ]);

    const result = await makeRepository().getTopic('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBeInstanceOf(ServerFailure);
      expect(result.failure.kind).toBe('server');
      expect(result.failure.code).toBe('not_found');
      expect(result.failure.status).toBe(404);
      expect(result.failure.message).toBe('no topic with id "missing"');
    }
  });

  it('maps a malformed payload to a server-kind failure with the invalid_response code', async () => {
    stubApiFetch([
      { url: '/api/content', body: { version: 1, groups: 'nope', topics: [] } },
    ]);

    const result = await makeRepository().getContentIndex();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBeInstanceOf(ServerFailure);
      expect(result.failure.code).toBe('invalid_response');
      expect(result.failure.status).toBe(200);
      expect(result.failure.message).toBe('The server response did not match the expected shape.');
    }
  });
});
