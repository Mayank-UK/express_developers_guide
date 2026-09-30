import type { HealthReport } from '../../../domain/models/health';
import type { DataMode, ScenarioReport } from '../../../domain/models/scenario';
import { isRecord, requiredNumber, requiredString } from './validate';

/**
 * StatusDTOs — the wire/transport shapes of the status endpoints backing the
 * home screen's live chips (GET /api/health, GET /api/demo/scenario).
 * Responsible for (de)serialization and mapping to the domain models,
 * react-guide `PostDTO` style.
 */

export interface HealthDto {
  status: 'ok';
  uptime: number;
  requestId: string;
}

export interface ScenarioDto {
  dataMode: DataMode;
  injectFailure: boolean;
}

/** Deserialize + validate the GET /api/health payload. */
export function healthDtoFromJson(body: unknown): HealthDto {
  if (!isRecord(body) || body.status !== 'ok') throw new Error('bad health payload');
  return {
    status: 'ok',
    uptime: requiredNumber(body, 'uptime'),
    requestId: requiredString(body, 'requestId'),
  };
}

/** Deserialize + validate the GET /api/demo/scenario payload. */
export function scenarioDtoFromJson(body: unknown): ScenarioDto {
  if (!isRecord(body)) throw new Error('scenario must be an object');
  if (body.dataMode !== 'fake' && body.dataMode !== 'live') {
    throw new Error('bad dataMode');
  }
  if (typeof body.injectFailure !== 'boolean') throw new Error('bad injectFailure');
  return { dataMode: body.dataMode, injectFailure: body.injectFailure };
}

/** Convert a transport DTO into a domain model (wire `uptime` → `uptimeSeconds`). */
export function toHealthReport(dto: HealthDto): HealthReport {
  return {
    status: 'ok',
    uptimeSeconds: dto.uptime,
    requestId: dto.requestId,
  };
}

/** Convert a transport DTO into a domain model. */
export function toScenarioReport(dto: ScenarioDto): ScenarioReport {
  return { dataMode: dto.dataMode, injectFailure: dto.injectFailure };
}
