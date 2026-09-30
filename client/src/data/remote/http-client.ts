import type { AppConfig } from '../../core/config/app-config';
import {
  InvalidResponseException,
  NetworkException,
  ServerException,
} from '../../core/error-handling/exceptions';

/**
 * http-client — the shared fetch pipeline every remote data source goes
 * through, mirroring the react guide's axios `http-client` factory (the Flutter
 * guide's `dio(...)` provider), trimmed to this client's needs.
 *
 * Responsibilities (and nothing else):
 *  - resolve the request URL against `config.apiBaseUrl`,
 *  - upgrade raw engine failures into typed AppExceptions:
 *      fetch rejected          → NetworkException (status 0)
 *      body is not JSON        → ServerException (unknown_error)
 *      non-2xx + error envelope→ ServerException (envelope code/message/status)
 *
 * Expected outcomes never throw past the data source: the typed exceptions are
 * mapped to Failures by the guards inside the repository implementations.
 */

export interface JsonResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface HttpClient {
  getJson(path: string): Promise<JsonResponse>;
}

export function createHttpClient(config: AppConfig): HttpClient {
  return {
    async getJson(path: string): Promise<JsonResponse> {
      return requestJson(`${config.apiBaseUrl}${path}`);
    },
  };
}

async function requestJson(url: string): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new NetworkException('Could not reach the server.', { cause: error });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw unknownStatusException(response.status, error);
  }

  if (!response.ok) {
    throw errorEnvelopeException(body, response.status);
  }

  return { body, status: response.status };
}

/**
 * Parse the server's `{ error: { code, message, requestId, …details } }`
 * envelope. Only the canonical code/message survive — extra merged detail keys
 * are ignored. Non-envelope bodies (and JSON-less errors) degrade to
 * unknown_error with a status-derived message.
 */
function errorEnvelopeException(body: unknown, status: number): ServerException {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : 'unknown_error';
    const message =
      typeof body.error.message === 'string'
        ? body.error.message
        : `Request failed with status ${status}.`;
    return new ServerException(message, { code, status });
  }
  return unknownStatusException(status, undefined);
}

function unknownStatusException(status: number, cause: unknown): ServerException {
  return new ServerException(`Request failed with status ${status}.`, {
    code: 'unknown_error',
    status,
    cause,
  });
}

/**
 * Validate a (2xx) JSON body into a DTO: a `fromJson` that throws on a shape
 * violation is upgraded to an InvalidResponseException carrying the response
 * status, so malformed server data surfaces as a typed server failure instead
 * of "[object Object]" strings reaching the UI.
 */
export function parseDto<T>(
  body: unknown,
  status: number,
  fromJson: (body: unknown) => T,
): T {
  try {
    return fromJson(body);
  } catch (error) {
    throw new InvalidResponseException(status, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
