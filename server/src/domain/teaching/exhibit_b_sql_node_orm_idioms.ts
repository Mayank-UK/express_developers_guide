/**
 * Teaching exhibit (the `sql-node` topic's ORM comparison): the same
 * "find a post by id" in each library idiom, side by side.
 *
 * Deliberately NOT executed anywhere: Prisma, Sequelize, Knex, and Drizzle
 * are NOT installed in this repo — that absence is the lesson's point (this
 * guide teaches raw SQL + a DAO so every line is ours). The four library
 * idioms therefore live as comments: they cannot typecheck without their
 * packages, and pretending otherwise would need fake stand-ins that lie
 * about the shapes. The raw form at the bottom is real, compilable code —
 * the one this repo actually runs (the DAO it quotes is
 * server/src/data/posts/post_dao.ts).
 */
import type Database from 'better-sqlite3';

// Prisma (schema-first + codegen): types come from schema.prisma
// model Post { id String @id  title String  createdAt DateTime }
// const post = await prisma.post.findUnique({ where: { id }, include: { comments: true } });
//   + fully typed, relations included on demand
//   − generate step in CI/Docker, query-engine binary dependency

// Sequelize (classic active-record): classes, finders, eager loading
// const post = await Post.findByPk(id, { include: [{ model: Comment, as: 'comments' }] });
//   + a decade of maturity, everything built in
//   − N+1 traps, hydration cost, SQL visible only in logs

// Knex (query builder — NOT an ORM): SQL's shape, method-chained
// const rows = await knex('posts').select('*').where({ id }); // no entities — rows
//   + dynamic queries compose without string surgery; solid migrations
//   − you still map rows to domain shapes yourself (a DAO, basically)

// Drizzle (TS-first, SQL-shaped — the modern light option):
// const post = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
//   + SQL-shaped, light, types without a codegen step
//   − younger ecosystem than the others

/** The idiom this repo actually runs: raw SQL, one prepared statement. */
export function rawDaoFindById(db: Database.Database, id: string): unknown {
  return db
    .prepare(
      'SELECT id, title, body, author, created_at, updated_at FROM posts WHERE id = ?',
    )
    .get(id);
}
