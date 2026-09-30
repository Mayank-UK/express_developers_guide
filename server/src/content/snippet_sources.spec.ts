import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { topics } from './registry.js';
import type { CodeBlock } from './types.js';

/**
 * Snippet-source enforcement — the invariant that teaching code is quoted
 * from real repo source: the code is the source of truth, never invented.
 *
 * Three rules, checked mechanically on every run:
 * 1. STRICT — a CodeBlock carrying `source` must quote an existing repo file:
 *    its code must be an ORDERED SUBSEQUENCE of that file's lines after
 *    normalization (see the normalization contract below).
 * 2. RATCHET — code blocks in must-source languages that lack `source` are
 *    counted and capped at RATCHET. The retrofit task drives RATCHET to 0;
 *    it must never grow. New must-source blocks require a `source` field.
 * 3. PATH SYNTAX — `source` must be repo-root-relative: not absolute, no
 *    `..`, no backslashes/`~`, and it must resolve under the repo root.
 *
 * ── Language inventory (all 40 topic files, frozen 2026-09-29) ──────────
 * 329 code blocks: ts 216 · bash 55 · txt 15 · text 15 · yaml 6 · sql 4 ·
 * json 4 · dockerfile 4 · nginx 3 · proto 2 · graphql 1 · tsx 1 · ini 1 ·
 * js 1 · markdown 1
 *
 * MUST-SOURCE — logic/config a repo file can own (243 blocks today):
 *   ts, tsx, js, json, sql, proto, yaml, yml, dockerfile, nginx, ini, graphql
 *   (the core code languages ts/js/json/sql/proto + yaml/yml/dockerfile
 *   config, plus tsx/nginx/ini/graphql found in the files — all real
 *   code/config; nginx config is even shipped as .docker/client/default.conf).
 * EXEMPT — terminal interaction and prose, which have no source file (86):
 *   bash, sh, shell, curl, http (commands), text, txt, plaintext (output and
 *   terminal transcripts), markdown (the ADR template — doc prose, not code).
 *
 * ── Normalization contract (why snippets can still teach) ───────────────
 * - Trailing line comments are stripped from BOTH snippet and source lines —
 *   snippets legitimately add teaching comments; we compare the code. The
 *   comment syntax is language-aware (`//` for ts/tsx/js/json/proto, `--` for
 *   sql, `#` for yaml/yml/dockerfile/nginx/ini/graphql) and quote-aware: a
 *   `//` inside 'https://…' is a string, not a comment (state machine below).
 * - Blank lines are ignored on both sides.
 * - A snippet line that is ONLY comment syntax and dots/ellipsis (e.g. `// …`,
 *   `// ...`, a block-comment ellipsis, `// ⋯ code omitted`) normalizes to
 *   empty and is therefore a GAP, never a match — that is what makes elided
 *   regions work: source lines may be skipped between matches.
 * - Every remaining snippet line must equal a source line exactly (after
 *   comment-strip + trim), IN ORDER. Intra-line elisions (e.g. a `"…": "…"`
 *   row inside a JSON snippet) do NOT verify — restructure those snippets to
 *   whole-line gaps when adding `source`.
 */

/** The repo root: this spec lives at server/src/content/, three levels down. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/**
 * 0 since the 2026-09-29 retrofit: every must-source block carries a `source`.
 * `<= 0` means any new unsourced code block fails the suite — never raise it.
 */
export const RATCHET = 0;

/** Languages whose snippets are code/config a repo file can own. */
export const MUST_SOURCE_LANGUAGES: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'json',
  'sql',
  'proto',
  'yaml',
  'yml',
  'dockerfile',
  'nginx',
  'ini',
  'graphql',
]);

/** Line-comment syntax per language family. */
const SLASH_COMMENTS: ReadonlySet<string> = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'proto']);
const DASH_COMMENTS: ReadonlySet<string> = new Set(['sql']);
const HASH_COMMENTS: ReadonlySet<string> = new Set(['yaml', 'yml', 'dockerfile', 'nginx', 'ini', 'graphql']);

/**
 * Remove line comments from one line, ignoring comment syntax inside string
 * literals (single/double/backtick, with backslash escapes). Also drops
 * same-line block comments for slash languages (an open block-comment marker
 * removes through its closing marker, or to end of line when unterminated).
 *
 * `--` (sql) and `#` (yaml-family) only start a comment at line start or
 * after whitespace, so TS `i--`, CSS hex, or `#field` never get mangled.
 *
 * (The block-comment case is written around the delimiters here on purpose:
 * a doc comment cannot contain them literally without ending itself.)
 */
function stripLineComments(line: string, language: string): string {
  const slash = SLASH_COMMENTS.has(language);
  const dash = DASH_COMMENTS.has(language);
  const hash = HASH_COMMENTS.has(language);
  let out = '';
  let quote: "'" | '"' | '`' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (slash && ch === '/' && next === '/') return out;
    if (slash && ch === '/' && next === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close === -1) return out;
      i = close + 1;
      continue;
    }
    const prev = out.slice(-1);
    const atCommentStart = prev === '' || prev === ' ' || prev === '\t';
    if (dash && ch === '-' && next === '-' && atCommentStart) return out;
    if (hash && ch === '#' && atCommentStart) return out;
    out += ch;
  }
  return out;
}

/** Strip the language's line comments, then trim. Empty ⇒ blank/gap line. */
export function normalizeSnippetLine(line: string, language: string): string {
  return stripLineComments(line, language).trim();
}

export interface QuoteCheck {
  ok: boolean;
  /** First snippet line with no matching source line (for failure messages). */
  mismatchedLine?: string;
}

/**
 * True when every normalized, non-empty snippet line appears in the source's
 * normalized lines IN ORDER (source lines may be skipped between matches —
 * that is what makes elisions and quote-fragments work).
 */
export function isQuotedFrom(code: string, sourceText: string, language: string): QuoteCheck {
  const wanted = code
    .split('\n')
    .map((line) => normalizeSnippetLine(line, language))
    .filter((line) => line !== '');
  const available = sourceText
    .split('\n')
    .map((line) => normalizeSnippetLine(line, language))
    .filter((line) => line !== '');
  let cursor = 0;
  for (const line of wanted) {
    while (cursor < available.length && available[cursor] !== line) cursor += 1;
    if (cursor === available.length) return { ok: false, mismatchedLine: line };
    cursor += 1;
  }
  return { ok: true };
}

/** Validate `source` path syntax; null when the path is acceptable. */
export function sourcePathError(source: string): string | null {
  if (source === '') return 'source must be a non-empty repo-root-relative path';
  if (path.isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('~')) {
    return `source must be repo-root-relative, not absolute/home: "${source}"`;
  }
  if (source.includes('\\')) return `source must use forward slashes: "${source}"`;
  for (const segment of source.split('/')) {
    if (segment === '..') return `source must not contain "..": "${source}"`;
    if (segment === '' || segment === '.') {
      return `source must be a clean relative path (no // or . segments): "${source}"`;
    }
  }
  if (!path.resolve(REPO_ROOT, source).startsWith(REPO_ROOT + path.sep)) {
    return `source must resolve under the repo root: "${source}"`;
  }
  return null;
}

/** Full strict verification of one sourced block: syntax → exists → subsequence. */
function verifySourcedBlock(topicId: string, block: CodeBlock): string[] {
  const errors: string[] = [];
  const source = block.source;
  if (source === undefined) return [`block "${block.id}" has no source`];

  const syntaxError = sourcePathError(source);
  if (syntaxError !== null) return [`${topicId}/${block.id}: ${syntaxError}`];

  const absolute = path.resolve(REPO_ROOT, source);
  if (!existsSync(absolute)) {
    return [`${topicId}/${block.id}: source file not found: ${source}`];
  }
  let sourceText: string;
  try {
    sourceText = readFileSync(absolute, 'utf8');
  } catch (error) {
    // e.g. a directory, or an unreadable file — report it, don't crash the run.
    return [`${topicId}/${block.id}: source unreadable: ${source} (${String(error)})`];
  }
  const check = isQuotedFrom(block.code, sourceText, block.language);
  if (!check.ok) {
    errors.push(
      `${topicId}/${block.id}: snippet drifted from ${source} — first line with no match in source: ${check.mismatchedLine}`,
    );
  }
  return errors;
}

/* ---- the real registry, partitioned by the two layers ---- */

const sourced: { topicId: string; block: CodeBlock }[] = [];
const unsourced: { topicId: string; block: CodeBlock }[] = [];
for (const topic of topics) {
  for (const section of topic.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'code') continue;
      if (!MUST_SOURCE_LANGUAGES.has(block.language.toLowerCase())) continue;
      if (block.source === undefined) unsourced.push({ topicId: topic.id, block });
      else sourced.push({ topicId: topic.id, block });
    }
  }
}

describe('snippet source normalizer', () => {
  const tsSource = [
    "import express from 'express';",
    '',
    'export function createApp(): Express {',
    '  const app = express();',
    '  const docsUrl = config.baseUrl + "/docs";',
    '  app.disable("x-powered-by");',
    '  return app;',
    '}',
  ].join('\n');

  it('accepts a verbatim snippet', () => {
    const snippet = [
      "import express from 'express';",
      'export function createApp(): Express {',
      '  const app = express();',
      '  return app;',
      '}',
    ].join('\n');
    expect(isQuotedFrom(snippet, tsSource, 'ts').ok).toBe(true);
  });

  it('accepts elisions, gaps, and trailing teaching comments', () => {
    const snippet = [
      "import express from 'express'; // the framework, nothing else",
      '',
      '// … lifecycle and config wiring omitted …',
      'export function createApp(): Express {',
      '  const app = express();    // one registry object',
      '  // ...docsUrl setup skipped...',
      '  app.disable("x-powered-by");',
      '  return app;               // note: no listen() here',
      '}',
    ].join('\n');
    expect(isQuotedFrom(snippet, tsSource, 'ts').ok).toBe(true);
  });

  it('rejects a changed identifier (getUserById vs getUserByIds)', () => {
    const source = ['async function run(id: string) {', '  return getUserById(id);', '}'].join('\n');
    const drifted = ['async function run(id: string) {', '  return getUserByIds(id);', '}'].join('\n');
    expect(isQuotedFrom(drifted, source, 'ts').ok).toBe(false);
  });

  it('rejects a changed numeric literal (x === 1 vs x === 2)', () => {
    const source = ['if (x === 1) {', '  res.status(200);', '}'].join('\n');
    const drifted = ['if (x === 2) {', '  res.status(200);', '}'].join('\n');
    expect(isQuotedFrom(drifted, source, 'ts').ok).toBe(false);
  });

  it('rejects reordered snippet lines', () => {
    const source = ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n');
    const reordered = ['const a = 1;', 'const c = 3;', 'const b = 2;'].join('\n');
    expect(isQuotedFrom(reordered, source, 'ts').ok).toBe(false);
  });

  it('does not treat // inside a string as a comment (and catches URL drift)', () => {
    const source = ["const docs = 'https://example.com/docs';"].join('\n');
    // Naive trailing-comment stripping would truncate BOTH sides to
    // `const docs = 'https:` and pass. The quote-aware scanner must not.
    const same = ["const docs = 'https://example.com/docs';"].join('\n');
    const drifted = ["const docs = 'https://example.com/api';"].join('\n');
    expect(isQuotedFrom(same, source, 'ts').ok).toBe(true);
    expect(isQuotedFrom(drifted, source, 'ts').ok).toBe(false);
  });

  it('strips sql -- comments and yaml # comments on both sides', () => {
    const sqlSource = ['-- migration header comment', 'CREATE TABLE tags (', '  id INTEGER PRIMARY KEY', ');'].join('\n');
    const sqlSnippet = ['-- our own teaching header', 'CREATE TABLE tags (', '  id INTEGER PRIMARY KEY', ');'].join('\n');
    expect(isQuotedFrom(sqlSnippet, sqlSource, 'sql').ok).toBe(true);

    const yamlSource = ['# shipped comment', 'image: node:22-alpine', 'ports:', '  - "4000:4000"'].join('\n');
    const yamlSnippet = ['image: node:22-alpine   # pinned deliberately', 'ports:', '  - "4000:4000"'].join('\n');
    expect(isQuotedFrom(yamlSnippet, yamlSource, 'yaml').ok).toBe(true);
  });

  it('keeps ts decrements and hash-keys intact (only real comments strip)', () => {
    const source = ['  retries--;', '  return this.#limit;', '  const color = "#fff";'].join('\n');
    expect(normalizeSnippetLine('  retries--;', 'ts')).toBe('retries--;');
    expect(normalizeSnippetLine('  return this.#limit;', 'ts')).toBe('return this.#limit;');
    expect(normalizeSnippetLine('  const color = "#fff";', 'ts')).toBe('const color = "#fff";');
    expect(isQuotedFrom(source, source, 'ts').ok).toBe(true);
  });
});

describe('source path syntax', () => {
  it('accepts repo-root-relative paths', () => {
    expect(sourcePathError('server/src/app.ts')).toBeNull();
    expect(sourcePathError('client/src/core/result.ts')).toBeNull();
    expect(sourcePathError('.docker/client/default.conf')).toBeNull();
  });

  it('rejects absolute, home, traversal, and malformed paths', () => {
    expect(sourcePathError('/etc/passwd')).toMatch(/repo-root-relative/);
    expect(sourcePathError('~/secrets.env')).toMatch(/repo-root-relative/);
    expect(sourcePathError('C:\\work\\app.ts')).toMatch(/repo-root-relative/);
    expect(sourcePathError('../outside-repo.ts')).toMatch(/\.\./);
    expect(sourcePathError('server/src/../../etc/passwd')).toMatch(/\.\./);
    expect(sourcePathError('server//src/app.ts')).toMatch(/clean relative/);
    expect(sourcePathError('./app.ts')).toMatch(/clean relative/);
    expect(sourcePathError('src\\app.ts')).toMatch(/forward slashes/);
    expect(sourcePathError('')).toMatch(/non-empty/);
  });
});

describe('sourced snippet verification machinery (real repo files as fixtures)', () => {
  it('accepts a verbatim fragment of server/src/app.ts with added teaching comments', () => {
    const appTs = readFileSync(path.resolve(REPO_ROOT, 'server/src/app.ts'), 'utf8');
    const snippet = [
      "import express, { type Express, type Request, type Response } from 'express';",
      '',
      '// teaching comment the real file does not need',
      'export function createApp(): Express {   // no listen() in this file',
      '  const app = express();',
      '',
      '  app.disable(\'x-powered-by\');',
      '  // ...logger and helmet wiring omitted...',
      '  app.use(requestIdMiddleware);',
    ].join('\n');
    expect(isQuotedFrom(snippet, appTs, 'ts').ok).toBe(true);
  });

  it('verifySourcedBlock rejects drift, missing files, and bad paths', () => {
    const drifted = {
      kind: 'code',
      id: 'fixture:drifted',
      language: 'ts',
      source: 'server/src/app.ts',
      code: '  app.enable(\'x-powered-by\');',
    } as CodeBlock;
    expect(verifySourcedBlock('fixture-topic', drifted)).toHaveLength(1);

    const missing = {
      kind: 'code',
      id: 'fixture:missing',
      language: 'ts',
      source: 'server/src/no_such_file.ts',
      code: 'const x = 1;',
    } as CodeBlock;
    expect(verifySourcedBlock('fixture-topic', missing)[0]).toMatch(/not found/);

    const traversal = {
      kind: 'code',
      id: 'fixture:traversal',
      language: 'ts',
      source: '../outside-repo.ts',
      code: 'const x = 1;',
    } as CodeBlock;
    expect(verifySourcedBlock('fixture-topic', traversal)[0]).toMatch(/\.\./);
  });
});

describe('sourced snippets are quoted from real repo source (strict)', () => {
  it('every block with a source verifies (syntax, existence, subsequence)', () => {
    const failures = sourced.flatMap(({ topicId, block }) => verifySourcedBlock(topicId, block));
    expect(failures.join('\n')).toBe('');
  });
});

describe('unsourced must-source code blocks (ratchet)', () => {
  it(`never exceeds the frozen ratchet (${RATCHET})`, () => {
    if (unsourced.length > RATCHET) {
      const offenders = unsourced
        .slice(0, 15)
        .map(({ topicId, block }) => `  ${topicId} | ${block.id} | ${block.language}`)
        .join('\n');
      throw new Error(
        `snippet-source ratchet exceeded: ${unsourced.length} > ${RATCHET}. ` +
          `Must-source code blocks need a repo-relative "source" field (or lower the ratchet deliberately). Offenders:\n${offenders}`,
      );
    }
    expect(unsourced.length).toBeLessThanOrEqual(RATCHET);
  });
});
