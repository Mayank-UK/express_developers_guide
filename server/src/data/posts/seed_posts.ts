import type { Post } from '../../domain/posts/post.js';

/**
 * The 3 teaching-flavored seed posts, shared by BOTH repository
 * implementations so fake and live mode serve byte-identical data. Ids and
 * timestamps are fixed (not minted) precisely so the modes can be compared —
 * the seed-parity test asserts the same ids from both. Timestamps sit a few
 * days in the past so any post created "now" always sorts newest-first.
 */
export const SEED_POSTS: readonly Post[] = Object.freeze([
  {
    id: '0f1c2b3a-0000-4000-8000-000000000001',
    title: 'Layers keep concerns apart',
    body: 'Route, controller, use case, repository, DAO: each layer has one job and one direction of dependency. This post is your first stop on the pipeline tour.',
    author: 'the guide',
    createdAt: '2026-09-24T09:00:00.000Z',
    updatedAt: '2026-09-24T09:00:00.000Z',
  },
  {
    id: '0f1c2b3a-0000-4000-8000-000000000002',
    title: 'The dependency rule, concretely',
    body: 'Presentation may import domain; data implements domain interfaces. Nothing under src/data is ever imported by a route — the container does all wiring.',
    author: 'the guide',
    createdAt: '2026-09-24T09:05:00.000Z',
    updatedAt: '2026-09-24T09:05:00.000Z',
  },
  {
    id: '0f1c2b3a-0000-4000-8000-000000000003',
    title: 'Failures are values here',
    body: 'Repositories and use cases return Result values instead of throwing; only the presentation edge converts a Failure into a typed exception for the error middleware.',
    author: 'the guide',
    createdAt: '2026-09-24T09:10:00.000Z',
    updatedAt: '2026-09-24T09:10:00.000Z',
  },
]);
