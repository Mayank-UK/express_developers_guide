import { describe, expect, it } from 'vitest';
import type { ContentBlock, Topic, TopicGroupId } from './types.js';
import { TOPIC_GROUPS } from './types.js';
import { getTopicById, getTopicSummaries, topics, validateRegistry } from './registry.js';

function makeTopic(overrides: Partial<Topic>): Topic {
  return { id: 'topic', title: 'Topic', group: 'fundamentals', order: 1, sections: [], ...overrides };
}

const textBlock = (id: string): ContentBlock => ({ kind: 'text', id, body: 'body' });

describe('registry module-load validation', () => {
  it('accepts the real registry: 40 topics, sorted by (group order, topic order)', () => {
    expect(topics).toHaveLength(40);
    expect(() => validateRegistry(topics)).not.toThrow();

    const groupOrder = new Map(TOPIC_GROUPS.map((group) => [group.id, group.order]));
    const sortKey = (topic: Topic) => (groupOrder.get(topic.group) ?? 0) * 100 + topic.order;
    for (let i = 1; i < topics.length; i += 1) {
      expect(sortKey(topics[i])).toBeGreaterThanOrEqual(sortKey(topics[i - 1]));
    }
  });

  it('throws on duplicate topic ids', () => {
    const duplicated = [makeTopic({ id: 'a' }), makeTopic({ id: 'a' })];
    expect(() => validateRegistry(duplicated)).toThrowError(/duplicate topic id "a"/);
  });

  it('throws on duplicate section ids within one topic', () => {
    const section = { id: 's', title: 'S', blocks: [textBlock('b')] };
    const duplicated = makeTopic({ sections: [section, { ...section }] });
    expect(() => validateRegistry([duplicated])).toThrowError(/duplicate section id "s"/);
  });

  it('throws on duplicate block ids within one topic (across sections)', () => {
    const duplicated = makeTopic({
      sections: [
        { id: 's1', title: 'S1', blocks: [textBlock('dup')] },
        { id: 's2', title: 'S2', blocks: [textBlock('dup')] },
      ],
    });
    expect(() => validateRegistry([duplicated])).toThrowError(/duplicate block id "dup"/);
  });

  it('throws on an invalid block kind and on an unknown group', () => {
    const badKind = { kind: 'video', id: 'b1' } as unknown as ContentBlock;
    expect(() =>
      validateRegistry([makeTopic({ sections: [{ id: 's', title: 'S', blocks: [badKind] }] })]),
    ).toThrowError(/invalid block kind "video"/);

    expect(() => validateRegistry([makeTopic({ group: 'misc' as TopicGroupId })])).toThrowError(
      /unknown group "misc"/,
    );
  });
});

describe('registry lookups', () => {
  it('finds topics by exact id and returns undefined otherwise', () => {
    expect(getTopicById('express-fundamentals')?.title).toBe('Express Fundamentals');
    expect(getTopicById('Express-Fundamentals')).toBeUndefined(); // case-sensitive
    expect(getTopicById('a.b')).toBeUndefined();
  });

  it('summaries never carry the sections array', () => {
    const summaries = getTopicSummaries();
    expect(summaries).toHaveLength(40);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('sections');
      expect(summary.sectionCount).toBeGreaterThanOrEqual(0);
    }
    const expressFundamentals = summaries.find((s) => s.id === 'express-fundamentals');
    expect(expressFundamentals?.sectionCount).toBe(10);
  });
});
