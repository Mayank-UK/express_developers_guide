import type Database from 'better-sqlite3';

/**
 * Raw row shape mirroring the posts table columns. This DTO stays inside the
 * data layer — the repository maps rows to domain Posts before returning them.
 */
export interface PostRow {
  id: string;
  title: string;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
}

/**
 * DAO: mechanical row CRUD straight on the sqlite handle, no domain concepts,
 * no Failure mapping — it throws whatever better-sqlite3 throws and the
 * repository above it translates.
 */
export class PostDao {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  list(): PostRow[] {
    return this.db
      .prepare(
        'SELECT id, title, body, author, created_at, updated_at FROM posts ORDER BY created_at DESC, id DESC',
      )
      .all() as PostRow[];
  }

  findById(id: string): PostRow | undefined {
    return this.db
      .prepare(
        'SELECT id, title, body, author, created_at, updated_at FROM posts WHERE id = ?',
      )
      .get(id) as PostRow | undefined;
  }

  insert(row: PostRow): void {
    this.db
      .prepare(
        `INSERT INTO posts (id, title, body, author, created_at, updated_at)
         VALUES (@id, @title, @body, @author, @created_at, @updated_at)`,
      )
      .run(row);
  }
}
