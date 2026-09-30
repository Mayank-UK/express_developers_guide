/**
 * The content model the React client renders: topic → sections → blocks.
 * The server owns 100% of the teaching content; the client is a presentation
 * shell over whatever this model serves (see agentic_development.md invariants).
 */

/** Bumped when the response shapes change, so the client can migrate deliberately. */
export const CONTENT_API_VERSION = 1 as const;

export interface TextBlock {
  kind: 'text';
  id: string;
  /** May contain \n\n paragraph breaks — the client renders it pre-line. */
  body: string;
}

export interface CodeBlock {
  kind: 'code';
  id: string;
  language: string;
  caption?: string;
  code: string;
  /**
   * Repo-root-relative path of the real file this snippet is quoted from
   * (e.g. 'server/src/app.ts', 'client/src/core/result.ts', later also
   * 'deploy/k8s/deployment.yaml'). THE CODE IS THE SOURCE OF TRUTH: teaching
   * snippets must be quoted from real repo source, never hand-invented.
   *
   * Enforced by snippet_sources.spec.ts: when present, the file must exist
   * under the repo root and the snippet must be an ordered subsequence of the
   * file's lines (after comment/blank normalization — elisions and trailing
   * teaching comments are allowed). Blocks in must-source languages without
   * this field are ratcheted toward zero.
   *
   * Additive + optional, so CONTENT_API_VERSION stays 1: old clients simply
   * ignore the extra key (the client DTO whitelists known fields), and the
   * wire shape of every existing block is unchanged.
   */
  source?: string;
}

/**
 * Names a client-side live demo component bound to real server endpoints.
 * The demoId (not the block id) is the client's lookup key.
 */
export interface DemoBlock {
  kind: 'demo';
  id: string;
  demoId: string;
  title: string;
  description?: string;
}

export type ContentBlock = TextBlock | CodeBlock | DemoBlock;

export interface ContentSection {
  id: string;
  title: string;
  lead?: string;
  blocks: ContentBlock[];
}

export type TopicGroupId =
  | 'fundamentals'
  | 'middleware-request'
  | 'apis'
  | 'data'
  | 'caching-messaging'
  | 'auth-security'
  | 'files-media'
  | 'internationalization'
  | 'realtime-jobs'
  | 'platform';

/** Nav groups in display order — titles match the client nav registry. */
export const TOPIC_GROUPS: readonly { id: TopicGroupId; title: string; order: number }[] = [
  { id: 'fundamentals', title: 'Fundamentals', order: 1 },
  { id: 'middleware-request', title: 'Middleware & Request Handling', order: 2 },
  { id: 'apis', title: 'APIs', order: 3 },
  { id: 'data', title: 'Data', order: 4 },
  { id: 'caching-messaging', title: 'Caching & Messaging', order: 5 },
  { id: 'auth-security', title: 'Auth & Security', order: 6 },
  { id: 'files-media', title: 'Files & Media', order: 7 },
  { id: 'internationalization', title: 'Internationalization', order: 8 },
  { id: 'realtime-jobs', title: 'Real-time & Jobs', order: 9 },
  { id: 'platform', title: 'Platform', order: 10 },
];

export interface Topic {
  id: string;
  title: string;
  subtitle?: string;
  group: TopicGroupId;
  order: number;
  sections: ContentSection[];
}

/** A topic without its sections payload — what list endpoints serve. */
export interface TopicSummary {
  id: string;
  title: string;
  subtitle?: string;
  group: TopicGroupId;
  order: number;
  sectionCount: number;
}
