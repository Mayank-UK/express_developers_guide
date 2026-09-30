/**
 * Pure Range-header parsing for HTTP file streaming — a (header, size) →
 * verdict function with no framework, no fs, and no Request/Response in
 * sight. It lives in core/ (the shared kernel) because two layers need it
 * honestly: presentation imports it for the files topic's 206/416/200
 * stream responder, and domain imports it as a subject of the teaching
 * mini test-suite. RFC 9110 semantics, unit-tested against the whole edge
 * matrix.
 */

// --- the Range parser (the spec behavior, unit-tested hard) ------------------

export type ParsedRange =
  | { kind: 'none' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'satisfiable'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Parses a Range header against a representation of `size` bytes, per the
 * HTTP spec's split between three very different outcomes:
 * - satisfiable  → 206 + Content-Range + just that slice
 * - unsatisfiable (VALID syntax, outside the file) → 416 + the "bytes STAR-slash-size" pointer
 * - ignored (INVALID syntax, non-bytes units, or multi-range) → the header
 *   is disregarded and the FULL body is served with 200. A recipient that
 *   receives an invalid byte-range-spec MUST ignore it — and this demo
 *   deliberately does not implement multipart/byteranges, so multi-range
 *   requests join the ignored bucket (one paragraph in the topic explains
 *   what a real CDN does instead).
 */
export function parseRangeHeader(raw: string | undefined, size: number): ParsedRange {
  if (raw === undefined || raw.trim() === '') return { kind: 'none' };

  const header = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(raw.trim());
  if (header === null) return { kind: 'ignored', reason: 'malformed header (no unit=value shape)' };
  const [, unit, spec] = header;
  if (unit.toLowerCase() !== 'bytes') {
    return { kind: 'ignored', reason: `range unit "${unit}" is not "bytes" - only byte ranges apply` };
  }
  if (size === 0) return { kind: 'unsatisfiable' };
  if (spec.includes(',')) {
    return {
      kind: 'ignored',
      reason: 'multi-range request - this server answers the full body instead of multipart/byteranges',
    };
  }

  const range = /^(\d*)-(\d*)$/.exec(spec);
  if (range === null) return { kind: 'ignored', reason: 'malformed range syntax' };
  const [, startText, endText] = range;
  if (startText === '' && endText === '') {
    return { kind: 'ignored', reason: 'empty on both sides of the dash' };
  }

  if (startText === '') {
    // Suffix form — bytes=-N means THE LAST N BYTES (the resumable-download shape).
    const suffix = Number(endText);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'satisfiable', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  if (start >= size) return { kind: 'unsatisfiable' };
  if (endText === '') {
    // Open-ended — bytes=N- runs from N to the end (the video-seek shape).
    return { kind: 'satisfiable', start, end: size - 1 };
  }

  const end = Number(endText);
  if (end < start) return { kind: 'ignored', reason: 'inverted range (last byte before first byte)' };
  // A first-byte-pos INSIDE the file with an end beyond it is valid and CLAMPED.
  return { kind: 'satisfiable', start, end: Math.min(end, size - 1) };
}
