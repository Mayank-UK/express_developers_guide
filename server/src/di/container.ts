import nodemailer from 'nodemailer';
import { scenarioStore, type ScenarioStore } from '../core/scenario/scenario.js';
import { DemoService } from '../domain/demo/demo_service.js';
import { ContentService } from '../domain/content/content_service.js';
import { makePostsUseCase, type PostsUseCase } from '../domain/posts/post_usecases.js';
import type { PostRepositoryPort } from '../domain/posts/post_repository.js';
import { makeFakePostRepository } from '../data/posts/fake_post_repository.js';
import { makeSqlitePostRepository } from '../data/posts/sqlite_post_repository.js';
import { PostDao } from '../data/posts/post_dao.js';
import { getSqlite } from '../data/posts/sqlite_client.js';
import { EmailService } from '../domain/email/email_service.js';
import { getTopicById, getTopicSummaries } from '../content/registry.js';

/**
 * Composition root: the single place where dependencies are constructed and
 * wired — the ONE caller of every make* factory. The fake/live data switch
 * reads the scenario store HERE — no other module decides wiring. The store is
 * exposed directly (not a snapshot of its state) so reads are always current.
 */
export interface Container {
  readonly scenarioStore: ScenarioStore;
  readonly demoService: DemoService;
  readonly contentService: ContentService;
  readonly postsUseCase: PostsUseCase;
  /**
   * The third-party topic's email boundary. The domain owns only the
   * transporter PORT — this file is the ONLY module that imports nodemailer:
   * "which transport" is wiring, not domain logic, so the vendor appears in
   * exactly one place. The jsonTransport instance constructed below is the
   * whole of the app's email infrastructure; swap it for
   * createTransport({ host, port, auth }) and no consumer changes.
   */
  readonly emailService: EmailService;
}

function buildContainer(): Container {
  // Both Post repositories exist up front; which one answers a call is decided
  // per use-case invocation from the CURRENT scenario state, so toggling
  // dataMode at runtime needs no container rebuild. The sqlite repository gets
  // a LAZY dao source — the database still opens only on the first live query,
  // so building it here costs nothing.
  const fakePostRepository = makeFakePostRepository();
  const sqlitePostRepository = makeSqlitePostRepository({ dao: () => new PostDao(getSqlite()) });
  const selectPostRepository = (): PostRepositoryPort =>
    scenarioStore.get().dataMode === 'live' ? sqlitePostRepository : fakePostRepository;

  // The only nodemailer construction in the app: jsonTransport runs the full
  // message pipeline and returns JSON instead of opening a socket. The domain
  // service receives it through its transporter port, vendor-blind.
  const emailTransporter = nodemailer.createTransport({ jsonTransport: true });

  return {
    scenarioStore,
    demoService: new DemoService(scenarioStore),
    // The content domain names its topic-lookup port; the registry functions
    // are supplied HERE — the domain file never imports the registry module.
    contentService: new ContentService({ topics: { getTopicById, getTopicSummaries } }),
    postsUseCase: makePostsUseCase({ selectRepository: selectPostRepository, scenarioStore }),
    emailService: new EmailService({ transporter: emailTransporter }),
  };
}

let current: Container | undefined;

/** Memoized singleton container. */
export function getContainer(): Container {
  current ??= buildContainer();
  return current;
}

/** Drops the memoized container so the next getContainer() rebuilds the wiring. */
export function resetContainer(): void {
  current = undefined;
}
