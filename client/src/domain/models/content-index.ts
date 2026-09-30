/**
 * ContentIndex — the pure domain model of GET /api/content: the guide's group
 * and topic registry the home screen renders its topic map from. A topic with
 * `sectionCount === 0` is published-but-unwritten ("coming soon").
 */

export interface TopicGroup {
  id: string;
  title: string;
  order: number;
}

export interface TopicSummary {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  order: number;
  sectionCount: number;
}

export interface ContentIndex {
  version: number;
  groups: TopicGroup[];
  topics: TopicSummary[];
}
