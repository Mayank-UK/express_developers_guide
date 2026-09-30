/**
 * Topic — the pure domain model of one guide topic (topic → sections →
 * blocks), as rendered by the generic topic screen. It knows nothing about
 * JSON or HTTP; the data layer validates wire payloads into these shapes.
 * Mirrors the react guide's `Post`/`Link` model style.
 */

export interface TextBlockData {
  kind: 'text';
  id: string;
  body: string;
}

export interface CodeBlockData {
  kind: 'code';
  id: string;
  language: string;
  caption?: string;
  code: string;
}

export interface DemoBlockData {
  kind: 'demo';
  id: string;
  demoId: string;
  title: string;
  description?: string;
}

export type ContentBlock = TextBlockData | CodeBlockData | DemoBlockData;

export interface TopicSection {
  id: string;
  title: string;
  lead?: string;
  blocks: ContentBlock[];
}

export interface Topic {
  version: number;
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  order: number;
  sections: TopicSection[];
}
