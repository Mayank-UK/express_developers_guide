import { Schema, type Connection, type Model } from 'mongoose';
import { getMongoConnection } from './mongo_client.js';

/**
 * The Event model — the MongoDB topic's real artifact: an analytics-style
 * event stream (kind + page + visitor + free-form meta) whose documents
 * AUTO-EXPIRE 60 seconds after createdAt via a TTL index, so the live demo
 * can watch documents disappear without anyone running a cleanup job.
 *
 * The model is registered on a DEDICATED connection from mongo_client.ts
 * (mongoose.createConnection — never the global mongoose default), so nothing
 * here can pollute or be polluted by any other mongoose user in the process.
 */

export const EVENT_KINDS = ['visit', 'click', 'error', 'custom'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Documents in this collection live this long after createdAt (the TTL demo). */
export const EVENT_TTL_SECONDS = 60;

/** The plain shape of a stored event (dates are BSON Dates; JSON renders ISO strings). */
export interface EventFields {
  kind: EventKind;
  page: string;
  visitor: string;
  /** Mixed: any BSON-able value — the document model's flexible-schema point. */
  meta: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export type EventModel = Model<EventFields>;

export const EventSchema = new Schema(
  {
    kind: { type: String, required: true, enum: EVENT_KINDS },
    page: { type: String, required: true },
    visitor: { type: String, required: true },
    // Function default on purpose: an object literal default would be shared
    // by reference across documents; a factory gives each document its own.
    meta: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  // createdAt/updatedAt are managed BSON Dates, set by the driver on save —
  // the mongoose twin of SQLite's DEFAULT strftime(...) columns.
  { timestamps: true },
);

// The read pattern the demo list serves: newest events for a given page.
EventSchema.index({ page: 1, createdAt: -1 });
// THE TTL INDEX: mongod's background deleter removes documents whose
// createdAt is older than expireAfterSeconds — lazily, on its own ~60s
// cadence (see the topic's indexes section).
EventSchema.index({ createdAt: 1 }, { expireAfterSeconds: EVENT_TTL_SECONDS });

/**
 * Compiles the 'Event' model on a GIVEN connection. Exported so the offline
 * unit specs can compile it against a never-connected connection (documents
 * validate client-side; no server is involved).
 */
export function buildEventModel(connection: Connection): EventModel {
  return connection.model<EventFields>('Event', EventSchema);
}

let cached: { connection: Connection; model: EventModel } | undefined;

/** The model bound to the app's lazy mongo connection — null when Mongo is off. */
export async function getEventModel(): Promise<EventModel | null> {
  const connection = await getMongoConnection();
  if (connection === null) return null;
  // Rebuild if the connection object changed (shutdown closed the old one).
  if (cached === undefined || cached.connection !== connection) {
    cached = { connection, model: buildEventModel(connection) };
  }
  return cached.model;
}
