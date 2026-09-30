import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The Files & Media topic's upload store. Uploaded bytes live under the
 * OS temp dir (NEVER inside the repo) in a per-boot session folder; the
 * store keeps only metadata in memory. Every filesystem access — listing
 * side effects, reads, deletes — goes through safeJoin(), the resolve +
 * startsWith containment guard the path-traversal section teaches. Client
 * filenames are NEVER used as filesystem paths: display names are
 * sanitized for rendering only, and stored names are server-generated.
 */

/** Hard cap on stored files — the demo evicts the oldest beyond this. */
export const FILE_STORE_CAP = 50;

/** Server-controlled MIME → extension map. The extension NEVER comes from the client filename. */
export const STORED_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

export interface ThumbVariantInfo {
  /** Stored name of the webp variant (server-generated, .thumb.webp suffix). */
  name: string;
  size: number;
  width: number;
  height: number;
}

export interface StoredFileMetadata {
  /** Unique id, `files-` prefixed — the ONLY client-visible handle. */
  id: string;
  /** Sanitized original name, for DISPLAY and the download filename only. */
  originalName: string;
  /** Server-generated storage name. Derived from nothing the client sent. */
  storedName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  kind: 'image' | 'file';
  /** Set when the bytes contradicted the declared MIME (sharp failed to decode). */
  note?: string;
  variants?: { thumb?: ThumbVariantInfo };
}

export type SafeJoinResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'null byte' | 'escapes the upload root' };

/**
 * THE containment guard, used for EVERY file access in this topic:
 * resolve the candidate against the root, then assert the result is still
 * INSIDE the root. path.join alone does not contain — join(root, '../..')
 * happily walks out. Null bytes are rejected outright (the historical
 * truncation attack: "evil\u0000.png" → "evil" at the C layer).
 */
export function safeJoin(root: string, candidate: string): SafeJoinResult {
  if (candidate.includes('\0')) return { ok: false, reason: 'null byte' };
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const contained = resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  return contained ? { ok: true, path: resolved } : { ok: false, reason: 'escapes the upload root' };
}

/**
 * Sanitizes a client-supplied filename for DISPLAY ONLY. Strips any path
 * component (browsers send just the basename, curl sends whatever it was
 * told), drops control characters, and caps the length. The result never
 * touches the filesystem — storage names are generated server-side.
 */
export function sanitizeDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = cleaned === '' ? 'unnamed' : cleaned;
  return name.length > 80 ? `${name.slice(0, 67)}…${name.slice(-10)}` : name;
}

/** A generated storage name — a fresh 24-hex-token id plus a server-chosen extension. */
function generateToken(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString('hex')}`; // 24 hex chars
}

export class FileStore {
  /** The per-boot session dir under the OS temp dir. Never inside the repo. */
  readonly rootDir: string;
  private readonly files = new Map<string, StoredFileMetadata>();

  constructor(sessionId: string) {
    this.rootDir = path.join(os.tmpdir(), 'express_guide_uploads', sessionId);
    mkdirSync(this.rootDir, { recursive: true });
  }

  /** Spec/lifecycle helper: wipe bytes + metadata and start a fresh session dir. */
  reset(): void {
    for (const meta of this.files.values()) this.deleteFromDisk(meta);
    this.files.clear();
    // Only THIS session's dir — never the shared parent. Sibling processes
    // (parallel vitest forks running other specs that use the store, e.g. the
    // third-party presigned uploads) keep their own sessions under
    // express_guide_uploads; rmSync on the parent is a cross-process race
    // that ENOENTs their in-flight writes mid-suite.
    rmSync(this.rootDir, { recursive: true, force: true });
    mkdirSync(this.rootDir, { recursive: true });
  }

  /**
   * Reserves the NEXT stored name for an incoming upload (multer's
   * diskStorage filename callback calls this — the name exists before the
   * route's controller runs). Extension comes from the server's MIME map.
   */
  reserveStoredName(mimeType: string): string {
    const extension = STORED_EXTENSIONS[mimeType] ?? 'bin';
    return `${generateToken('up')}.${extension}`;
  }

  /** Registers metadata for a file already written into the session dir. */
  register(meta: Omit<StoredFileMetadata, 'uploadedAt'>): StoredFileMetadata {
    const full: StoredFileMetadata = Object.freeze({ ...meta, uploadedAt: new Date().toISOString() });
    this.files.set(full.id, full);
    // Cap enforcement: evict the OLDEST beyond the cap (insertion order).
    while (this.files.size > FILE_STORE_CAP) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.files.get(oldest);
      this.files.delete(oldest);
      if (evicted !== undefined) this.deleteFromDisk(evicted);
    }
    return this.toPublic(full);
  }

  nextId(): string {
    let id = generateToken('files');
    while (this.files.has(id)) id = generateToken('files');
    return id;
  }

  /** Defensive copies ONLY — the house discipline (fake/sqlite repositories): a caller holding a returned record can never mutate store state. */
  list(): StoredFileMetadata[] {
    return [...this.files.values()]
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
      .map((meta) => this.toPublic(meta));
  }

  get(id: string): StoredFileMetadata | undefined {
    const found = this.files.get(id);
    return found === undefined ? undefined : this.toPublic(found);
  }

  /**
   * The copy every read path hands out. Records are frozen internally, so one
   * shallow spread would suffice today — variants are copied one level deeper
   * because they are the one nested object, and a shared `variants` reference
   * would re-open the very hole the copy closes.
   */
  private toPublic(meta: StoredFileMetadata): StoredFileMetadata {
    const thumb = meta.variants?.thumb;
    return thumb === undefined ? { ...meta } : { ...meta, variants: { thumb: { ...thumb } } };
  }

  /**
   * Absolute path for a stored name — through safeJoin, like every access.
   * Only the stored name is needed, so drafts not yet registered can ask too.
   * Stored names are server-generated so containment cannot fail, but the
   * guard runs anyway: the pattern must be uniform to be a habit.
   */
  absolutePath(meta: Pick<StoredFileMetadata, 'storedName'>): string {
    const joined = safeJoin(this.rootDir, meta.storedName);
    if (!joined.ok) {
      throw new Error(`stored name escaped the upload root: ${meta.storedName}`);
    }
    return joined.path;
  }

  /** Variant paths (thumbnails) — same guard, same habit. */
  variantPath(meta: StoredFileMetadata, variantName: string): string {
    const joined = safeJoin(this.rootDir, variantName);
    if (!joined.ok) {
      throw new Error(`variant name escaped the upload root: ${variantName}`);
    }
    return joined.path;
  }

  /** On-disk size for a stored name (used after sharp rewrites the original). */
  sizeOnDisk(absolutePath: string): number {
    return statSync(absolutePath).size;
  }

  /** Deletes a file + its variants from disk (unused bytes, not metadata). */
  deleteFromDisk(meta: StoredFileMetadata): void {
    const paths = [this.absolutePath(meta)];
    if (meta.variants?.thumb !== undefined) {
      paths.push(this.variantPath(meta, meta.variants.thumb.name));
    }
    for (const target of paths) {
      try {
        unlinkSync(target);
      } catch {
        // already gone — eviction is best-effort cleanup
      }
    }
  }

  /** Writes variant bytes (sharp output) next to the original, via the guard. */
  async writeVariant(storedName: string, bytes: Buffer): Promise<void> {
    const joined = safeJoin(this.rootDir, storedName);
    if (!joined.ok) throw new Error(`variant name escaped the upload root: ${storedName}`);
    await fs.writeFile(joined.path, bytes);
  }

  /**
   * Overwrites the original with re-encoded (EXIF-stripped) bytes and RETURNS
   * the new on-disk size. The store never mutates a record in place — the
   * caller derives the size into whichever record it registers next.
   */
  async overwriteOriginal(meta: Pick<StoredFileMetadata, 'storedName'>, bytes: Buffer): Promise<number> {
    const absolutePath = this.absolutePath(meta);
    await fs.writeFile(absolutePath, bytes);
    return this.sizeOnDisk(absolutePath);
  }
}

/** Per-boot singleton; specs call reset() to isolate themselves. */
export const fileStore = new FileStore(randomBytes(8).toString('hex'));
