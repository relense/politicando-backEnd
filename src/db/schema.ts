import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  date,
  index,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const parties = pgTable("parties", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  slug: text().notNull().unique(),
  acronym: text().notNull(),
  name: text().notNull(),
  website: text(),
  assemblySeats: smallint("assembly_seats").notNull().default(0),
  seatsAsOf: date("seats_as_of"),
});

export const articles = pgTable(
  "articles",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    sourceUri: text("source_uri").notNull().unique(),
    title: text().notNull(),
    /** Short summary only. Full article text is read for matching, never stored. */
    excerpt: text().notNull(),
    url: text().notNull(),
    source: text().notNull(),
    imageUrl: text("image_url"),
    publishedAt: timestamp("published_at", { withTimezone: true, precision: 3 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("articles_feed_idx").on(table.publishedAt.desc(), table.id.desc()),
  ],
);

export const articleParties = pgTable(
  "article_parties",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    partyId: integer("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    mentionCount: integer("mention_count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.partyId] }),
    index("article_parties_party_idx").on(table.partyId),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    parentId: integer("parent_id").references((): AnyPgColumn => comments.id, {
      onDelete: "cascade",
    }),
    username: text(),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Set to hide a comment from the API. There is no admin endpoint yet. */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [
    index("comments_article_idx").on(table.articleId, table.createdAt),
    index("comments_parent_idx").on(table.parentId),
  ],
);

/** Articles that matched no party, kept so later runs don't score them again. */
export const seenSourceUris = pgTable("seen_source_uris", {
  sourceUri: text("source_uri").primaryKey(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Parliament (Assembleia da República open data) ---

/** One per person, keyed by the parliament's own ID (cadastro), which never changes. */
export const deputies = pgTable(
  "deputies",
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    fullName: text("full_name").notNull(),
    /** As the parliament writes it ("CH", "L"), so it lines up with the seat map. */
    parliamentaryGroup: text("parliamentary_group"),
    /** Null for independents and groups that aren't in our party list. */
    partyId: integer("party_id").references(() => parties.id, { onDelete: "set null" }),
    constituency: text().notNull(),
    /** The parliament's word for their situation: "Efetivo", "Suspenso(Eleito)", "Renunciou"... */
    situation: text().notNull(),
    /** Sitting in the chamber right now. */
    active: boolean().notNull(),
    /** When they sat this legislature; `to` is null while still sitting. */
    sittingPeriods: jsonb("sitting_periods").$type<{ from: string; to: string | null }[]>().notNull().default([]),
    /** Seat number from the official map, once known. See src/parliament/seatAssignments.ts. */
    seat: smallint(),
    /** Role in the parliament itself, such as "Vice-Presidente". */
    parliamentRole: text("parliament_role"),
    gender: text(),
    birthDate: date("birth_date"),
    profession: text(),
    education: jsonb().$type<{ course: string; completed: boolean }[]>().notNull().default([]),
    roles: jsonb().$type<{ title: string; current: boolean }[]>().notNull().default([]),
    committees: jsonb()
      .$type<{ name: string; acronym: string; membership: string; role: string | null }[]>()
      .notNull()
      .default([]),
    /** Earlier legislatures they sat in, such as ["XV", "XVI"]. */
    pastLegislatures: text("past_legislatures").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("deputies_party_idx").on(table.partyId)],
);

export type InitiativeStatus = "approved" | "rejected" | "in_progress" | "withdrawn";

export interface PartyVote {
  /** Our party slug, or the parliament's acronym when the group isn't in our list. */
  party: string;
  /** Set when only some of the group voted this way, as in "3-PS". */
  count: number | null;
}

export interface VoteRecord {
  id: string;
  date: string;
  phase: string;
  result: string;
  unanimous: boolean;
  favor: PartyVote[];
  against: PartyVote[];
  abstention: PartyVote[];
  /** Groups recorded as absent from the vote (party slugs, or the parliament's acronym). */
  absent: string[];
  /** Deputies named because they voted differently from their group. */
  named: { name: string; group: string; position: "favor" | "against" | "abstention" }[];
}

/** Bills, resolutions and other proposals ("iniciativas"), keyed by the parliament's ID. */
export const initiatives = pgTable(
  "initiatives",
  {
    id: integer().primaryKey(),
    legislature: text().notNull(),
    type: text().notNull(),
    number: text().notNull(),
    title: text().notNull(),
    status: text().$type<InitiativeStatus>().notNull(),
    /** Latest stage, such as "Votação na generalidade", and when it happened. */
    phase: text().notNull(),
    phaseDate: date("phase_date").notNull(),
    submittedAt: date("submitted_at"),
    /** When it was published as law or resolution, if it was. */
    publishedAt: date("published_at"),
    /** Author when it isn't deputies: "Governo", a regional assembly, citizens... */
    otherAuthor: text("other_author"),
    textUrl: text("text_url"),
    votes: jsonb().$type<VoteRecord[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("initiatives_feed_idx").on(table.phaseDate.desc(), table.id.desc()),
    index("initiatives_status_idx").on(table.status),
  ],
);

export const initiativeParties = pgTable(
  "initiative_parties",
  {
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    partyId: integer("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.initiativeId, table.partyId] }),
    index("initiative_parties_party_idx").on(table.partyId),
  ],
);

export const initiativeDeputies = pgTable(
  "initiative_deputies",
  {
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    deputyId: integer("deputy_id")
      .notNull()
      .references(() => deputies.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.initiativeId, table.deputyId] }),
    index("initiative_deputies_deputy_idx").on(table.deputyId),
  ],
);

export const articleDeputies = pgTable(
  "article_deputies",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    deputyId: integer("deputy_id")
      .notNull()
      .references(() => deputies.id, { onDelete: "cascade" }),
    mentionCount: integer("mention_count").notNull(),
    /** "auto" from the scanner, "manual" when someone linked it by hand. Rescans keep manual links. */
    linkedBy: text("linked_by").$type<"auto" | "manual">().notNull().default("auto"),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.deputyId] }),
    index("article_deputies_deputy_idx").on(table.deputyId),
  ],
);
