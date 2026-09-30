import type {
  ContentBlock,
  Topic,
  TopicSection,
} from '../../../domain/models/topic';
import type {
  ContentIndex,
  TopicGroup,
  TopicSummary,
} from '../../../domain/models/content-index';
import {
  isRecord,
  optionalString,
  requiredArray,
  requiredNumber,
  requiredString,
} from './validate';

/**
 * ContentDTOs — the wire/transport shapes of the content API, responsible for
 * (de)serialization and mapping to the domain models. Mirrors the react
 * guide's `PostDTO` (the Flutter `PostDTO`), trimmed to this client's needs.
 *
 * The content API's wire format was designed to match the domain models 1:1 —
 * nested shapes (groups, summaries, sections, blocks) validate directly into
 * the domain types, and only the top-level DTO interfaces exist as the seam
 * where wire and domain may diverge.
 */

export interface ContentIndexDto {
  version: number;
  groups: TopicGroup[];
  topics: TopicSummary[];
}

export interface TopicDto {
  version: number;
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  order: number;
  sections: TopicSection[];
}

/**
 * Deserialize + validate the GET /api/content payload. Throws on any shape
 * violation (see validate.ts) so bad server data surfaces as a typed
 * InvalidResponseException instead of propagating NaN orders or
 * "[object Object]" titles into the UI.
 */
export function contentIndexDtoFromJson(body: unknown): ContentIndexDto {
  if (!isRecord(body)) throw new Error('content index must be an object');
  return {
    version: requiredNumber(body, 'version'),
    groups: requiredArray(body, 'groups').map(topicGroupFromJson),
    topics: requiredArray(body, 'topics').map(topicSummaryFromJson),
  };
}

/** Deserialize + validate the GET /api/content/topics/:id payload. */
export function topicDtoFromJson(body: unknown): TopicDto {
  if (!isRecord(body)) throw new Error('topic must be an object');
  return {
    version: requiredNumber(body, 'version'),
    id: requiredString(body, 'id'),
    title: requiredString(body, 'title'),
    subtitle: optionalString(body, 'subtitle'),
    group: requiredString(body, 'group'),
    order: requiredNumber(body, 'order'),
    sections: requiredArray(body, 'sections').map(topicSectionFromJson),
  };
}

/** Convert a transport DTO into a domain model. */
export function toContentIndex(dto: ContentIndexDto): ContentIndex {
  return { version: dto.version, groups: dto.groups, topics: dto.topics };
}

/** Convert a transport DTO into a domain model. */
export function toTopic(dto: TopicDto): Topic {
  return {
    version: dto.version,
    id: dto.id,
    title: dto.title,
    subtitle: dto.subtitle,
    group: dto.group,
    order: dto.order,
    sections: dto.sections,
  };
}

/* ---- nested payload validators (throw on shape violation) ---- */

function topicGroupFromJson(body: unknown): TopicGroup {
  if (!isRecord(body)) throw new Error('group must be an object');
  return {
    id: requiredString(body, 'id'),
    title: requiredString(body, 'title'),
    order: requiredNumber(body, 'order'),
  };
}

function topicSummaryFromJson(body: unknown): TopicSummary {
  if (!isRecord(body)) throw new Error('topic must be an object');
  return {
    id: requiredString(body, 'id'),
    title: requiredString(body, 'title'),
    subtitle: optionalString(body, 'subtitle'),
    group: requiredString(body, 'group'),
    order: requiredNumber(body, 'order'),
    sectionCount: requiredNumber(body, 'sectionCount'),
  };
}

function contentBlockFromJson(body: unknown): ContentBlock {
  if (!isRecord(body)) throw new Error('block must be an object');
  const kind = body.kind;
  switch (kind) {
    case 'text':
      return { kind, id: requiredString(body, 'id'), body: requiredString(body, 'body') };
    case 'code':
      return {
        kind,
        id: requiredString(body, 'id'),
        language: requiredString(body, 'language'),
        caption: optionalString(body, 'caption'),
        code: requiredString(body, 'code'),
      };
    case 'demo':
      return {
        kind,
        id: requiredString(body, 'id'),
        demoId: requiredString(body, 'demoId'),
        title: requiredString(body, 'title'),
        description: optionalString(body, 'description'),
      };
    default:
      throw new Error(`unknown block kind "${String(kind)}"`);
  }
}

function topicSectionFromJson(body: unknown): TopicSection {
  if (!isRecord(body)) throw new Error('section must be an object');
  return {
    id: requiredString(body, 'id'),
    title: requiredString(body, 'title'),
    lead: optionalString(body, 'lead'),
    blocks: requiredArray(body, 'blocks').map(contentBlockFromJson),
  };
}
