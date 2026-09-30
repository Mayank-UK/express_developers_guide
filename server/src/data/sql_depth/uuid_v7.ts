import { randomBytes, randomInt } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562), hand-rolled on node:crypto — no dependency. The layout:
 *
 *   48 bits  unix epoch milliseconds        → ids sort by creation time
 *    4 bits  version 0b0111                 → the '7' in the string's 3rd group
 *   12 bits  rand_a, used as a per-process monotonic counter
 *    2 bits  variant 0b10                   → the 8/9/a/b first hex of group 4
 *   62 bits  rand_b, random                 → uniqueness within the same ms
 *
 * The counter is RFC 9562's "monotonic random" method: seeded randomly at
 * each new millisecond, then incremented for every further id minted in that
 * same millisecond. Result: ids generated in sequence ALWAYS compare in
 * sequence lexicographically — even within one millisecond — which v4 (122
 * random bits) never does. That orderliness is why v7 is the key strategy of
 * choice for B-tree-backed stores: appends instead of random-insert scatters.
 *
 * Overflow and clock-skew handling, both deliberate:
 *  - if the counter passes 0xFFF inside one ms, the timestamp borrows 1ms
 *    from the future and the counter reseeds (ids stay ordered and unique);
 *  - if the clock steps backwards, ids keep using the highest timestamp seen
 *    (never emit out-of-order ids to protect a broken clock).
 *
 * Module state is safe under Node's single-threaded event loop: uuidV7()
 * contains no await, so the read-increment-write of the counter cannot
 * interleave.
 */

const RAND_A_MAX = 0x0fff; // 12 bits
const TIMESTAMP_MS_MAX = 2 ** 48 - 1; // the 48-bit field holds unix ms until year ~8955
const UUID_HEX_LENGTH = 32;

let lastTimestampMs = -1;
let counterWithinMs = -1;

export function uuidV7(timestampMs: number = Date.now()): string {
  if (!Number.isFinite(timestampMs) || timestampMs < 0 || timestampMs > TIMESTAMP_MS_MAX) {
    throw new RangeError(
      `uuidV7 needs a unix-ms timestamp in [0, ${TIMESTAMP_MS_MAX}], got ${timestampMs}`,
    );
  }
  let ts = Math.floor(timestampMs);
  if (ts < lastTimestampMs) {
    ts = lastTimestampMs; // clock stepped backwards — stay monotonic
  }
  if (ts > lastTimestampMs) {
    lastTimestampMs = ts;
    counterWithinMs = randomInt(0, RAND_A_MAX + 1);
  } else {
    counterWithinMs += 1;
    if (counterWithinMs > RAND_A_MAX) {
      // Counter overflow — borrow the next millisecond and reseed low. ts MUST
      // follow lastTimestampMs here: minting under the old ms with a reset
      // counter would sort the id BEFORE its predecessor (the one at 0xfff).
      lastTimestampMs += 1;
      ts = lastTimestampMs;
      counterWithinMs = randomInt(0, 16);
    }
  }

  const bytes = randomBytes(16);

  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | (counterWithinMs >> 8); // version 7 + counter's high 4 bits
  bytes[7] = counterWithinMs & 0xff; // counter's low 8 bits
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10 + rand_b's top 6 bits

  const hex = bytes.toString('hex');
  if (hex.length !== UUID_HEX_LENGTH) {
    throw new Error(`uuidV7 produced ${hex.length} hex digits, expected ${UUID_HEX_LENGTH}`);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
