import { type HttpClient, parseDto } from './http-client';
import { guardedApiCall } from '../../core/error-handling/guards';
import {
  healthDtoFromJson,
  scenarioDtoFromJson,
  type HealthDto,
  type ScenarioDto,
} from './dtos/status-dto';

/**
 * StatusRemoteDataSource — talks to the operational status endpoints
 * (/api/health, /api/demo/scenario) and returns DTOs. Mirrors the react
 * guide's remote data sources; the two probes stay independent so one
 * failing never blocks the other.
 */

export interface StatusRemoteDataSource {
  getHealth(): Promise<HealthDto>;
  getScenario(): Promise<ScenarioDto>;
}

export class HttpStatusRemoteDataSource implements StatusRemoteDataSource {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  getHealth(): Promise<HealthDto> {
    return guardedApiCall(async () => {
      const { body, status } = await this.http.getJson('/health');
      return parseDto(body, status, healthDtoFromJson);
    });
  }

  getScenario(): Promise<ScenarioDto> {
    return guardedApiCall(async () => {
      const { body, status } = await this.http.getJson('/demo/scenario');
      return parseDto(body, status, scenarioDtoFromJson);
    });
  }
}
