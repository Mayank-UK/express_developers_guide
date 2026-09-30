import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * The ONE bridge between Express and the controllers ring (clean architecture:
 * the adapter over the framework, so controllers never import express).
 *
 * makeExpressCallback(controller) returns an Express handler that:
 *  1. builds the framework-free httpRequest DTO from the raw req/res,
 *  2. calls the controller with it,
 *  3. maps the controller's { status, body } onto the response.
 *
 * Failures are NOT handled here: a controller that throws (an AppException
 * from failureToException, or any unexpected error) propagates via next(err)
 * to the canonical error-handling middleware, which owns the envelope and the
 * requestId. This callback adds no status codes, no wrapping, no catch-and-400
 * — response bodies pass through byte-identical.
 */

/** Everything a controller may know about the request — and nothing else. */
export interface HttpRequest {
  /** Parsed JSON body (unknown until validated — hostile until proven). */
  readonly body: unknown;
  /** Parsed query string (Express 5 "simple" parser: strings / arrays). */
  readonly query: Record<string, unknown>;
  /** Route params, keyed by name (Express 5: a repeated param is an array). */
  readonly params: Record<string, string | string[]>;
  /** Remote socket address, when the socket is still connected. */
  readonly ip: string | undefined;
  readonly method: string;
  readonly path: string;
  /** Raw request headers, lower-cased keys. */
  readonly headers: Readonly<Record<string, unknown>>;
  /** Authenticated principal, when an auth middleware populated it. */
  readonly user: unknown;
  /** The correlation id stamped by the request-id middleware (first in app.ts). */
  readonly requestId: string;
}

/** The controller's whole output: a status code and a JSON body. */
export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** A controller: framework-free, receives the DTO, returns (or throws). */
export type Controller = (httpRequest: HttpRequest) => Promise<HttpResponse> | HttpResponse;

function buildHttpRequest(req: Request, res: Response): HttpRequest {
  const requestId = res.locals.requestId;
  return {
    body: req.body,
    query: req.query,
    params: req.params,
    ip: req.ip,
    method: req.method,
    path: req.path,
    headers: req.headers,
    user: (req as Request & { user?: unknown }).user,
    requestId: typeof requestId === 'string' && requestId !== '' ? requestId : 'n/a',
  };
}

export function makeExpressCallback(controller: Controller): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const httpResponse = await controller(buildHttpRequest(req, res));
      res.status(httpResponse.status).json(httpResponse.body);
    } catch (err) {
      // AppExceptions and unexpected errors alike reach the error middleware,
      // which renders the canonical { error: { code, message, requestId } }.
      next(err);
    }
  };
}
