import { beforeAll, describe, expect, it } from 'vitest';
import { container } from './container';
import { createAppConfig } from './config';
import { GetContentIndexUseCase } from '../domain/usecases/get-content-index-usecase';
import { GetTopicUseCase } from '../domain/usecases/get-topic-usecase';
import { GetHealthStatusUseCase } from '../domain/usecases/get-health-status-usecase';
import { GetScenarioStatusUseCase } from '../domain/usecases/get-scenario-status-usecase';

/**
 * The default config wires only remote (fetch-based) sources, so initializing
 * the container here is side-effect-free — no request leaves the machine until
 * a use case is executed against a stubbed fetch.
 */
beforeAll(() => {
  container.initialize(createAppConfig());
});

describe('container', () => {
  it('resolves the registered singletons after initialize', () => {
    expect(container.appConfig).toBeDefined();
    expect(container.appConfig.apiBaseUrl).toBe('/api');
    expect(container.logger).toBeDefined();
    expect(container.httpClient).toBeDefined();
    expect(container.contentRepository).toBeDefined();
    expect(container.statusRepository).toBeDefined();
    expect(container.getContentIndexUseCase).toBeInstanceOf(GetContentIndexUseCase);
    expect(container.getTopicUseCase).toBeInstanceOf(GetTopicUseCase);
    expect(container.getHealthStatusUseCase).toBeInstanceOf(GetHealthStatusUseCase);
    expect(container.getScenarioStatusUseCase).toBeInstanceOf(GetScenarioStatusUseCase);
  });

  it('re-initialization is idempotent (re-registers without throwing)', () => {
    const before = container.getContentIndexUseCase;
    container.initialize(createAppConfig());
    expect(container.getContentIndexUseCase).toBeInstanceOf(GetContentIndexUseCase);
    expect(container.getContentIndexUseCase).not.toBe(before);
  });

  it('dispose clears the registry so subsequent resolve throws', () => {
    container.dispose();
    expect(() => container.logger).toThrow(/is not registered/);
    // re-initialize so downstream suites / teardown stay valid
    container.initialize(createAppConfig());
  });
});
