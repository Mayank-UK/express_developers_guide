/**
 * Teaching exhibit (the `graphql` topic's schema-SDL block): the SDL rendering
 * of the REAL schema graphql_demo_routes.ts builds programmatically.
 *
 * The app never writes SDL — it assembles GraphQLObjectType/GraphQLSchema in
 * code so resolvers sit beside their field definitions. printSchema() derives
 * this exact text from that live schema (descriptions become """doc strings""").
 * The output is recorded here verbatim so the topic can quote it as a real
 * repo artifact instead of a hand-typed copy.
 *
 * Regenerate after touching the schema (run from server/):
 *   npx tsx -e "import { printSchema } from 'graphql'; \
 *     import { graphqlDemoSchema } from './src/presentation/routes/graphql_demo_routes.js'; \
 *     console.log(printSchema(graphqlDemoSchema));"
 */
export const GRAPHQL_PRINTED_SCHEMA = `"""Read operations — the same list/detail the REST routes expose."""
type Query {
  """All posts, newest first. One resolver call for the whole list."""
  posts: [Post!]!

  """One post by id. Nullable: unknown ids answer null + an error entry."""
  post(id: ID!): Post
}

"""A guide post — the same domain Post the REST API serves."""
type Post {
  id: ID!
  title: String!
  body: String!
  author: String!
  createdAt: String!
  updatedAt: String!
}

"""Write operations — the same validation path POST /api/posts uses."""
type Mutation {
  """
  Create a post. Validation failures arrive as errors with extensions.fields.
  """
  createPost(title: String!, body: String!, author: String!): Post!
}
`;
