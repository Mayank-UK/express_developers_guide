import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { logger } from '../../core/logging/logger.js';
import {
  FAILURE_ERROR_CODE,
  FAILURE_HTTP_STATUS,
  FAILURE_KINDS,
  failure,
} from '../../core/error_handling/failures.js';
import { failureToException } from '../../core/error_handling/exceptions.js';
import { errorHandler } from './error_middleware.js';

// Mock the logger MODULE, not pino internals: the real logger prints to stdout
// and tees into the in-memory ring — a unit spec wants neither — and the mock
// doubles as the spy capturing the 4xx-warn / 5xx-error level discipline.
vi.mock('../../core/logging/logger.js', () => ({
  logger: {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

const REQUEST_ID = 'req-0001';

/**
 * Minimal res double: errorHandler touches only locals, headersSent, and the
 * status/json chain — each mock returns res so `.status(x).json(y)` chains.
 */
function makeRes(options: { headersSent?: boolean; requestId?: string } = {}) {
  const res = {
    // `in`, not ?? — the 'n/a' fallback test passes requestId: undefined on
    // purpose, and ?? would silently restore the default.
    locals: { requestId: 'requestId' in options ? options.requestId : REQUEST_ID },
    headersSent: options.headersSent ?? false,
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockImplementation(() => res);
  res.json.mockImplementation(() => res);
  return res as unknown as Response & typeof res;
}

function makeReq(): Request {
  return {} as Request;
}

describe('errorHandler (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('every FailureKind renders its mapped envelope', () => {
    it.each([...FAILURE_KINDS])('%s → mapped status + code/message/requestId', (kind) => {
      const res = makeRes();
      const message = `${kind} went wrong`;

      errorHandler(failureToException(failure(kind, message)), makeReq(), res, vi.fn());

      expect(res.status).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(FAILURE_HTTP_STATUS[kind]);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: FAILURE_ERROR_CODE[kind],
          message,
          requestId: REQUEST_ID,
        },
      });
    });
  });

  it('merges failure details flat and lets the canonical keys win on collision', () => {
    const res = makeRes();
    const err = failureToException(
      failure('validation', 'title is required', {
        field: 'title',
        limit: 80,
        code: 'evil',
        requestId: 'evil',
      }),
    );

    errorHandler(err, makeReq(), res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      error: {
        field: 'title',
        limit: 80,
        code: 'validation_failed', // canonical beats details.code
        message: 'title is required',
        requestId: REQUEST_ID, // canonical beats details.requestId
      },
    });
  });

  it('renders "n/a" when no requestId was stamped on res.locals', () => {
    const res = makeRes({ requestId: undefined });

    errorHandler(failureToException(failure('not_found', 'gone')), makeReq(), res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'not_found', message: 'gone', requestId: 'n/a' },
    });
  });

  describe('non-AppException errors (best-effort extraction)', () => {
    it('uses statusCode and code from http-like error objects', () => {
      const res = makeRes();

      errorHandler({ statusCode: 418, code: 'teapot' }, makeReq(), res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(418);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'teapot', message: 'Internal server error', requestId: REQUEST_ID },
      });
    });

    it('keeps a plain Error message, defaulting to 500 / internal_error', () => {
      const res = makeRes();

      errorHandler(new Error('disk on fire'), makeReq(), res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'internal_error', message: 'disk on fire', requestId: REQUEST_ID },
      });
    });

    it('replaces an empty Error message with the generic one', () => {
      const res = makeRes();

      errorHandler(new Error(''), makeReq(), res, vi.fn());

      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'internal_error', message: 'Internal server error', requestId: REQUEST_ID },
      });
    });

    it('falls back to 500 / internal_error for a thrown string', () => {
      const res = makeRes();

      errorHandler('just a string', makeReq(), res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'internal_error', message: 'Internal server error', requestId: REQUEST_ID },
      });
    });
  });

  describe('the headersSent guard', () => {
    it('delegates to the express default handler instead of writing twice', () => {
      const res = makeRes({ headersSent: true });
      const next = vi.fn();
      const err = failureToException(failure('internal', 'mid-stream failure'));

      errorHandler(err, makeReq(), res, next);

      // The SAME error travels on — not a rewrap — and nothing is written.
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0]?.[0]).toBe(err);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        { err, requestId: REQUEST_ID },
        'error after response started — delegating to express default handler',
      );
    });
  });

  describe('log-level discipline (4xx warn, 5xx error)', () => {
    it('splits AppExceptions by their mapped status', () => {
      const internal = makeRes();
      errorHandler(failureToException(failure('internal', 'boom')), makeReq(), internal, vi.fn());
      expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();

      const validation = makeRes();
      errorHandler(
        failureToException(failure('validation', 'bad input')),
        makeReq(),
        validation,
        vi.fn(),
      );
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1); // still just the 5xx above
    });

    it('applies the same split to unknown errors', () => {
      const teapot = makeRes();
      errorHandler({ statusCode: 418, code: 'teapot' }, makeReq(), teapot, vi.fn());
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();

      const crash = makeRes();
      errorHandler(new Error('late failure'), makeReq(), crash, vi.fn());
      expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
    });
  });
});
