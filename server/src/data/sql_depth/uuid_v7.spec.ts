import { describe, expect, it } from 'vitest';
import { uuidV7 } from './uuid_v7.js';

/**
 * uuidV7's module-level monotonic counter is shared across this file's tests,
 * so order matters where it says it does: the clock-based generation tests run
 * FIRST (real Date.now() stamps), then the fixed-timestamp layout tests use
 * 2^47 ms — far above any real clock, so nothing clamps — and the
 * clock-backwards test runs last.
 */

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A timestamp above any real clock but inside the 48-bit field (year ~6419). */
const FAR_FUTURE_MS = 2 ** 47;

describe('uuidV7 — uniqueness and sortability (real clock)', () => {
  const ids = Array.from({ length: 10_000 }, () => uuidV7());

  it('is unique across 10,000 generations', () => {
    expect(new Set(ids).size).toBe(10_000);
  });

  it('sorts exactly as generated — even inside one millisecond', () => {
    expect([...ids].sort()).toEqual(ids);
  });

  it('mints lowercase strings with version 7 and variant 10, always', () => {
    // Sampled from the same batch: format is a property of every id, not luck.
    for (const id of ids) {
      expect(id).toMatch(UUID_V7_RE);
      expect(id[14]).toBe('7'); // version nibble
      expect('89ab').toContain(id[19]!); // variant bits (10xx)
    }
  });
});

describe('uuidV7 — RFC 9562 layout (fixed timestamps)', () => {
  it('encodes the given unix-ms timestamp in the leading 48 bits', () => {
    const id = uuidV7(FAR_FUTURE_MS);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(FAR_FUTURE_MS);
  });

  it('increments within the same millisecond instead of colliding', () => {
    const first = uuidV7(FAR_FUTURE_MS + 1);
    const second = uuidV7(FAR_FUTURE_MS + 1);
    const third = uuidV7(FAR_FUTURE_MS + 1);
    expect(new Set([first, second, third]).size).toBe(3);
    // Same timestamp + strictly increasing counter => strict lexicographic order.
    expect(first < second && second < third).toBe(true);
  });

  it('keeps the order property across explicit millisecond steps', () => {
    const stepped = Array.from({ length: 500 }, (_, i) => uuidV7(FAR_FUTURE_MS + 10 + i));
    expect([...stepped].sort()).toEqual(stepped);
  });

  it('never emits an out-of-order id when the clock steps backwards', () => {
    const before = uuidV7(FAR_FUTURE_MS + 1_000);
    const skewed = uuidV7(1_000); // far behind the highest timestamp seen
    expect(skewed >= before).toBe(true);
  });
});

describe('uuidV7 — input guards', () => {
  it('rejects non-finite, negative, and beyond-48-bit timestamps', () => {
    expect(() => uuidV7(-1)).toThrow(RangeError);
    expect(() => uuidV7(Number.NaN)).toThrow(RangeError);
    expect(() => uuidV7(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => uuidV7(2 ** 48)).toThrow(RangeError); // the field is full at 2^48 - 1
  });
});
