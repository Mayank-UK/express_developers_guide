import { type AppConfig } from './config/app-config';
import { Logger } from './config/logger';
import { createHttpClient } from '../data/remote/http-client';
import {
  type ContentRemoteDataSource,
  HttpContentRemoteDataSource,
} from '../data/remote/content-remote-data-source';
import {
  type StatusRemoteDataSource,
  HttpStatusRemoteDataSource,
} from '../data/remote/status-remote-data-source';
import { ContentRepositoryImpl } from '../data/repositories/content-repository-impl';
import { StatusRepositoryImpl } from '../data/repositories/status-repository-impl';
import type { ContentRepository } from '../domain/repositories/content-repository';
import type { StatusRepository } from '../domain/repositories/status-repository';
import { GetContentIndexUseCase } from '../domain/usecases/get-content-index-usecase';
import { GetTopicUseCase } from '../domain/usecases/get-topic-usecase';
import { GetHealthStatusUseCase } from '../domain/usecases/get-health-status-usecase';
import { GetScenarioStatusUseCase } from '../domain/usecases/get-scenario-status-usecase';

/**
 * Service-locator container — mirrors the react guide's `container.ts`
 * (the Flutter guide's `getIt` + `injection_module.dart`), trimmed to this
 * client's remote-only needs (no fakes, no runtime scenario swapping — YAGNI).
 *
 * A small hand-rolled locator: `register` singletons keyed by symbol,
 * `resolve` them. It keeps wiring in one explicit, debuggable place and lets
 * screens resolve use cases without prop-drilling or a global variable per
 * service. `initialize` is idempotent — re-running it just re-registers.
 */

class Container {
  private readonly registry = new Map<symbol, unknown>();

  initialize(config: AppConfig): void {
    // Eager singletons.
    this.register('AppConfig', config);
    this.register(
      'Logger',
      new Logger(config.environment, config.enableLogs),
    );
    this.register('HttpClient', createHttpClient(config));
    this.register(
      'ContentRemoteDataSource',
      new HttpContentRemoteDataSource(this.httpClient),
    );
    this.register(
      'StatusRemoteDataSource',
      new HttpStatusRemoteDataSource(this.httpClient),
    );
    this.register(
      'ContentRepository',
      new ContentRepositoryImpl(this.contentRemoteDataSource, this.logger),
    );
    this.register(
      'StatusRepository',
      new StatusRepositoryImpl(this.statusRemoteDataSource, this.logger),
    );
    this.register(
      'GetContentIndexUseCase',
      new GetContentIndexUseCase(this.contentRepository),
    );
    this.register(
      'GetTopicUseCase',
      new GetTopicUseCase(this.contentRepository),
    );
    this.register(
      'GetHealthStatusUseCase',
      new GetHealthStatusUseCase(this.statusRepository),
    );
    this.register(
      'GetScenarioStatusUseCase',
      new GetScenarioStatusUseCase(this.statusRepository),
    );
  }

  // ---- service accessors ----

  get appConfig(): AppConfig {
    return this.resolve('AppConfig') as AppConfig;
  }
  get logger(): Logger {
    return this.resolve('Logger') as Logger;
  }
  get httpClient() {
    return this.resolve('HttpClient') as ReturnType<typeof createHttpClient>;
  }
  get contentRemoteDataSource(): ContentRemoteDataSource {
    return this.resolve('ContentRemoteDataSource') as ContentRemoteDataSource;
  }
  get statusRemoteDataSource(): StatusRemoteDataSource {
    return this.resolve('StatusRemoteDataSource') as StatusRemoteDataSource;
  }
  get contentRepository(): ContentRepository {
    return this.resolve('ContentRepository') as ContentRepository;
  }
  get statusRepository(): StatusRepository {
    return this.resolve('StatusRepository') as StatusRepository;
  }
  get getContentIndexUseCase(): GetContentIndexUseCase {
    return this.resolve('GetContentIndexUseCase') as GetContentIndexUseCase;
  }
  get getTopicUseCase(): GetTopicUseCase {
    return this.resolve('GetTopicUseCase') as GetTopicUseCase;
  }
  get getHealthStatusUseCase(): GetHealthStatusUseCase {
    return this.resolve('GetHealthStatusUseCase') as GetHealthStatusUseCase;
  }
  get getScenarioStatusUseCase(): GetScenarioStatusUseCase {
    return this.resolve('GetScenarioStatusUseCase') as GetScenarioStatusUseCase;
  }

  /** Test-only: tear down registered singletons. */
  dispose(): void {
    this.registry.clear();
  }

  // ---- wiring helpers ----

  private register(name: string, instance: unknown): void {
    this.registry.set(key(name), instance);
  }

  private resolve(name: string): unknown {
    const instance = this.registry.get(key(name));
    if (instance === undefined) {
      throw new Error(`Dependency "${name}" is not registered`);
    }
    return instance;
  }
}

const KEY_REGISTRY = new Map<string, symbol>();
function key(name: string): symbol {
  let sym = KEY_REGISTRY.get(name);
  if (!sym) {
    sym = Symbol(name);
    KEY_REGISTRY.set(name, sym);
  }
  return sym;
}

export const container = new Container();
