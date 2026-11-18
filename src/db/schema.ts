import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
  date,
  index,
  boolean,
  check,
  doublePrecision,
  integer,
  real,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

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
    /** Readers' votes, kept in step with article_votes so lists can sort by them cheaply. */
    upvotes: integer().notNull().default(0),
    downvotes: integer().notNull().default(0),
    /** Hidden by a moderator (duplicate, not about politics…): left out everywhere readers look. */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    /** The story it tells, with other outlets' versions (src/stories). Null until grouped. */
    storyId: integer("story_id").references((): AnyPgColumn => stories.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("articles_feed_idx").on(table.publishedAt.desc(), table.id.desc()),
    index("articles_story_idx").on(table.storyId),
  ],
);

/**
 * One story told by one or more outlets. What a card shows (title, outlets, dates) comes from
 * its visible articles; only readers' "Importa" marks are kept here.
 */
export const stories = pgTable("stories", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  /** Readers who marked it as mattering, kept in step with story_votes. */
  importa: integer().notNull().default(0),
  /** Events and topics it's about (src/stories/tags.ts), refreshed as versions join. Null until computed. */
  tags: jsonb().$type<{ slug: string; label: string; name: string; kind: "event" | "topic" }[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One "Importa" per reader per story; `voter` is a keyed hash of the IP, never the IP. */
export const storyVotes = pgTable(
  "story_votes",
  {
    storyId: integer("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    voter: text().notNull(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.storyId, table.voter] }), index("story_votes_user_idx").on(table.userId)],
);

/** One vote (+1 or -1) per reader per article; `voter` is a keyed hash of the IP, never the IP. */
export const articleVotes = pgTable(
  "article_votes",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    voter: text().notNull(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    value: smallint().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("article_votes_user_idx").on(table.userId),
    primaryKey({ columns: [table.articleId, table.voter] }),
    check("article_votes_value_check", sql`${table.value} in (-1, 1)`),
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
    /** What it's on: a news article, a story or one of our editorial posts (exactly one). */
    articleId: integer("article_id").references(() => articles.id, { onDelete: "cascade" }),
    storyId: integer("story_id").references((): AnyPgColumn => stories.id, { onDelete: "cascade" }),
    editorialPostId: integer("editorial_post_id").references((): AnyPgColumn => editorialPosts.id, { onDelete: "cascade" }),
    parentId: integer("parent_id").references((): AnyPgColumn => comments.id, {
      onDelete: "cascade",
    }),
    username: text(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    body: text().notNull(),
    /** The commenter's own side, if they picked one: "Concordo" or "Discordo". */
    stance: text().$type<"agree" | "disagree">(),
    /** Readers who liked it, kept in step with comment_likes. */
    likes: integer().notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Set to hide a comment from the API. There is no admin endpoint yet. */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [
    index("comments_user_idx").on(table.userId),
    index("comments_article_idx").on(table.articleId, table.createdAt),
    index("comments_editorial_idx").on(table.editorialPostId, table.createdAt),
    index("comments_story_idx").on(table.storyId, table.createdAt),
    index("comments_parent_idx").on(table.parentId),
    check("comments_one_target", sql`num_nonnulls(${table.articleId}, ${table.storyId}, ${table.editorialPostId}) = 1`),
    check("comments_stance_check", sql`${table.stance} in ('agree', 'disagree')`),
  ],
);

/** One like per reader per comment; `voter` is a keyed hash of the IP, never the IP. */
export const commentLikes = pgTable(
  "comment_likes",
  {
    commentId: integer("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    voter: text().notNull(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.commentId, table.voter] }), index("comment_likes_user_idx").on(table.userId)],
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
    /** Seat number on the official map. See src/parliament/seating.ts. */
    seat: smallint(),
    /** True when the seat is estimated (by importance within the party), not known. */
    seatEstimated: boolean("seat_estimated").notNull().default(false),
    /** Official positions, most important first: "Líder do grupo parlamentar", "Presidente da Comissão de…". */
    positions: text().array().notNull().default([]),
    /** Rough importance within their party, used to estimate seats. Higher is more prominent. */
    importance: smallint().notNull().default(0),
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
    /** Official site, Wikipedia, Wikidata and social accounts, from Wikidata (src/people/wikidata.ts). */
    wikidataLinks: jsonb("wikidata_links").$type<{ network: string; url: string }[]>().notNull().default([]),
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

/**
 * What the President of the Republic did with the decree parliament sent: from the
 * initiative's own stages ("Envio para promulgação", "Promulgação", "Veto").
 */
export interface PresidencyRecord {
  /** pending: sent and waiting; vetoed: sent back to parliament (it may still pass a new version). */
  status: "pending" | "promulgated" | "vetoed";
  sentAt: string | null;
  /** Null when promulgated but the record skips the step (inferred from the law's publication). */
  promulgatedAt: string | null;
  /** False when the promulgation is inferred from the law being published. */
  promulgationRecorded?: boolean;
  vetoedAt: string | null;
  /** political: the President's own objection; unconstitutionality: after a Constitutional Court ruling. */
  vetoKind?: "political" | "unconstitutionality" | null;
  /** Constitutional Court rulings cited on the latest veto. */
  constitutionalCourt?: { ruling: string; url: string }[];
  /** Every veto, oldest first: a decree can be vetoed, passed again and vetoed again. */
  vetoes?: { date: string; kind: "political" | "unconstitutionality"; constitutionalCourt: { ruling: string; url: string }[] }[];
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

/**
 * Initiatives of earlier legislatures, for each legislature's record (counts by author and
 * outcome). Kept apart from `initiatives`, which is the current legislature: news matching,
 * party pages and lists work on that one only. Older legislatures' records in the open data
 * are incomplete (the 1980s have a few hundred initiatives each).
 */
export const pastInitiatives = pgTable(
  "past_initiatives",
  {
    id: integer().primaryKey(),
    legislature: text().notNull(),
    type: text().notNull(),
    number: text().notNull(),
    title: text().notNull(),
    /** approved, rejected, withdrawn, or lapsed (still pending when the legislature ended). */
    status: text().$type<"approved" | "rejected" | "withdrawn" | "lapsed">().notNull(),
    submittedAt: date("submitted_at"),
    publishedAt: date("published_at"),
    /** Parliamentary groups as the parliament wrote them, e.g. ["PS", "PSD"] or ["UEDS"]. */
    authorGroups: text("author_groups").array().notNull(),
    /** Our party slugs for those groups, where we have the party. */
    partySlugs: text("party_slugs").array().notNull(),
    /** "Governo", a regional assembly, citizens... when no group signed it. */
    otherAuthor: text("other_author"),
    textUrl: text("text_url"),
  },
  (table) => [index("past_initiatives_legislature_idx").on(table.legislature)],
);

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
    /** Null until parliament sends it to the President. */
    presidency: jsonb().$type<PresidencyRecord>(),
    /** Topic slugs from the title (src/parliament/plain.ts), e.g. ["habitacao", "impostos"]. */
    topics: text().array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("initiatives_feed_idx").on(table.phaseDate.desc(), table.id.desc()),
    index("initiatives_status_idx").on(table.status),
    index("initiatives_topics_idx").using("gin", table.topics),
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

/** News articles about an initiative, found by keywords (see src/matching/matchInitiatives.ts). */
export const articleInitiatives = pgTable(
  "article_initiatives",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    /** Match strength, to filter or review weak links. Null for manual links. */
    score: real(),
    /** "auto" from keyword matching, "manual" when someone linked it by hand. Relinking keeps manual links. */
    linkedBy: text("linked_by").$type<"auto" | "manual">().notNull().default("auto"),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.initiativeId] }),
    index("article_initiatives_initiative_idx").on(table.initiativeId),
  ],
);

/** People in the Government, from portugal.gov.pt (see src/government/portal.ts). */
export const governmentMembers = pgTable(
  "government_members",
  {
    /** The portal's ID for the person, stable across posts. */
    id: text().primaryKey(),
    name: text().notNull(),
    gender: text().$type<"M" | "F">(),
    photoUrl: text("photo_url"),
    /** Plain-text paragraphs of the official biography. */
    bio: text().array().notNull().default([]),
    links: jsonb().$type<{ network: string; url: string }[]>().notNull().default([]),
    /** Their record as a deputy, matched by name, when they sat in this legislature. */
    deputyId: integer("deputy_id").references(() => deputies.id, { onDelete: "set null" }),
    /** As on deputies: from Wikidata, shown after the portal's own `links`. */
    wikidataLinks: jsonb("wikidata_links").$type<{ network: string; url: string }[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("government_members_deputy_idx").on(table.deputyId)],
);

/** Posts held in the Government, current and past. */
export const governmentPositions = pgTable(
  "government_positions",
  {
    /** The portal's ID for this person in this post. */
    id: text().primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => governmentMembers.id, { onDelete: "cascade" }),
    /** Portal code of the government, e.g. "gc25". */
    government: text().notNull(),
    kind: text().$type<"prime_minister" | "minister" | "secretary_of_state">().notNull(),
    /** "Ministro de Estado e das Finanças", "Secretária de Estado dos Assuntos Fiscais". */
    title: text().notNull(),
    /** Ministry slug ("financas"), or "primeiro-ministro". */
    area: text().notNull(),
    areaName: text("area_name").notNull(),
    /** Ministry order (protocol order); 0 is the Prime Minister. */
    areaRank: smallint("area_rank").notNull(),
    /** Order within the ministry: 0 is the minister. */
    rank: smallint().notNull(),
    startDate: date("start_date"),
    /** Null while in office. */
    endDate: date("end_date"),
    url: text().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("government_positions_member_idx").on(table.memberId),
    index("government_positions_government_idx").on(table.government, table.areaRank, table.rank),
  ],
);

/** The government itself, one row per portal code. */
export const governments = pgTable("governments", {
  code: text().primaryKey(),
  name: text().notNull(),
  startDate: date("start_date"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** News articles that name a member of the Government. */
export const articleGovernmentMembers = pgTable(
  "article_government_members",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => governmentMembers.id, { onDelete: "cascade" }),
    mentionCount: integer("mention_count").notNull(),
    linkedBy: text("linked_by").$type<"auto" | "manual">().notNull().default("auto"),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.memberId] }),
    index("article_government_members_member_idx").on(table.memberId),
  ],
);

/** Presidents of the Republic (see src/presidency/presidents.ts). */
export const presidents = pgTable("presidents", {
  id: text().primaryKey(),
  name: text().notNull(),
  fullName: text("full_name").notNull(),
  termStart: date("term_start").notNull(),
  /** Null while in office. */
  termEnd: date("term_end"),
  /** Official biography from presidencia.pt, as plain-text paragraphs. Only kept for the current one. */
  bio: text().array().notNull().default([]),
  photoUrl: text("photo_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** News articles that name the President of the Republic. */
export const articlePresidents = pgTable(
  "article_presidents",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    presidentId: text("president_id")
      .notNull()
      .references(() => presidents.id, { onDelete: "cascade" }),
    mentionCount: integer("mention_count").notNull(),
    linkedBy: text("linked_by").$type<"auto" | "manual">().notNull().default("auto"),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.presidentId] }),
    index("article_presidents_president_idx").on(table.presidentId),
  ],
);

/**
 * Elected local officials with a page of their own. Today only mayors (presidentes de
 * câmara): the results site publishes no other names for autárquicas. Rebuilt from
 * election_candidates by src/places/localOfficials.ts.
 */
export const localOfficials = pgTable(
  "local_officials",
  {
    /** Readable and stable across re-imports: "carlos-moedas-lisboa" (first and last name, municipality). */
    id: text().primaryKey(),
    name: text().notNull(),
    role: text().$type<"mayor">().notNull(),
    placeKey: text("place_key")
      .notNull()
      .references((): AnyPgColumn => places.key),
    electionId: text("election_id")
      .notNull()
      .references((): AnyPgColumn => elections.id, { onDelete: "cascade" }),
    /** The ballot acronym of their list: "PPD/PSD.CDS-PP". */
    list: text().notNull(),
    termStart: date("term_start").notNull(),
    /** When the next autárquicas are due; null once they're replaced. */
    termEnd: date("term_end"),
    current: boolean().notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("local_officials_place_idx").on(table.placeKey)],
);

export const articleLocalOfficials = pgTable(
  "article_local_officials",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    officialId: text("official_id")
      .notNull()
      .references(() => localOfficials.id, { onDelete: "cascade" }),
    mentionCount: integer("mention_count").notNull(),
    linkedBy: text("linked_by").$type<"auto" | "manual">().notNull().default("auto"),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.officialId] }),
    index("article_local_officials_official_idx").on(table.officialId),
  ],
);

/** Places as the electoral administration codes them: "LOCAL-010100" (Águeda), "GLOBAL-990000"... */
export const places = pgTable(
  "places",
  {
    key: text().primaryKey(),
    name: text().notNull(),
    level: text().$type<"global" | "national" | "foreign" | "district" | "municipality" | "parish">().notNull(),
    parentKey: text("parent_key"),
    /** DICOFRE code (6 digits) for places in Portugal: district 01, municipality 0101, parish 010103. */
    dicofre: text(),
  },
  (table) => [index("places_parent_idx").on(table.parentKey)],
);

/** An election, from the electoral administration's results site (see src/elections/catalog.ts). */
export const elections = pgTable("elections", {
  id: text().primaryKey(),
  type: text().$type<"legislativas" | "autarquicas" | "europeias" | "presidenciais">().notNull(),
  name: text().notNull(),
  date: date().notNull(),
  /** Bodies elected: AR, CM (câmara), AM (assembleia municipal), AF (assembleia de freguesia), PE, PR. */
  organs: text().array().notNull(),
  sourceUrl: text("source_url").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }),
});

/** Turnout for one body in one place. */
export const electionTurnout = pgTable(
  "election_turnout",
  {
    electionId: text("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    organ: text().notNull(),
    placeKey: text("place_key")
      .notNull()
      .references(() => places.key),
    registered: integer(),
    voters: integer().notNull(),
    turnoutPct: real("turnout_pct"),
    blank: integer().notNull(),
    null: integer().notNull(),
    /** Seats at stake here (AR círculo, câmara...), when the place elects them. */
    totalMandates: integer("total_mandates"),
  },
  (table) => [primaryKey({ columns: [table.electionId, table.organ, table.placeKey] })],
);

/** Votes for one list (party, coalition, citizens' group or presidential candidate) in one place. */
export const electionResults = pgTable(
  "election_results",
  {
    electionId: text("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    organ: text().notNull(),
    placeKey: text("place_key")
      .notNull()
      .references(() => places.key),
    /** As the ballot shows it: "PPD/PSD.CDS-PP", "B.E.", or a candidate's name. */
    list: text().notNull(),
    /** The list's own name on this ballot, when it differs by place (local coalitions, citizens). */
    label: text(),
    votes: integer().notNull(),
    pct: real().notNull(),
    validPct: real("valid_pct"),
    mandates: integer(),
    /** Autárquicas: presidencies (câmaras or juntas) won, summed over the area. */
    presidents: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.electionId, table.organ, table.placeKey, table.list] }),
    index("election_results_place_idx").on(table.placeKey),
  ],
);

/** The lists that ran in an election, with their full names and our party slugs. */
export const electionLists = pgTable(
  "election_lists",
  {
    electionId: text("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    list: text().notNull(),
    name: text().notNull(),
    coalition: boolean().notNull().default(false),
    citizens: boolean().notNull().default(false),
    /** Our parties in it: ["psd", "cds-pp"] for "PPD/PSD.CDS-PP". Empty for others. */
    partySlugs: text("party_slugs").array().notNull().default([]),
  },
  (table) => [primaryKey({ columns: [table.electionId, table.list] })],
);

/** Candidates on each list, per círculo, as the results site publishes them. */
export const electionCandidates = pgTable(
  "election_candidates",
  {
    electionId: text("election_id")
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    /** The círculo: a district, Europe / outside Europe, or the whole country (europeias). */
    placeKey: text("place_key")
      .notNull()
      .references(() => places.key),
    list: text().notNull(),
    /** Efetivo (in the running for a seat, in order) or suplente (replacement). */
    kind: text().$type<"effective" | "alternate">().notNull(),
    /** Order on the list, from 1. */
    position: smallint().notNull(),
    /** As published, usually in capitals. */
    name: text().notNull(),
    /** Won a seat on election night (an effective candidate within the list's seats). */
    elected: boolean().notNull(),
    /** Their deputy record, matched by full name. */
    deputyId: integer("deputy_id").references(() => deputies.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.electionId, table.placeKey, table.list, table.kind, table.position] }),
    index("election_candidates_deputy_idx").on(table.deputyId),
  ],
);

/**
 * Public contracts, from the BASE portal's open data (IMPIC, on dados.gov.pt). One row per
 * contract; the parties to it are in contract_parties. See src/contracts/base.ts.
 */
export const contracts = pgTable(
  "contracts",
  {
    /** BASE's contract id (idcontrato): base.gov.pt/Base4/pt/detalhe/?type=contratos&id=<id>. */
    id: text().primaryKey(),
    procedureId: text("procedure_id"),
    /** The procedure as published, e.g. "Ajuste Direto Regime Geral". */
    procedure: text().notNull(),
    /** The procedure, grouped: see PROCEDURES in src/contracts/base.ts. */
    procedureKind: text("procedure_kind").notNull(),
    contractTypes: text("contract_types").array().notNull(),
    object: text().notNull(),
    description: text(),
    /** Contract price in euros, without VAT. */
    price: doublePrecision().notNull(),
    /** The procedure's base price, when published. */
    basePrice: doublePrecision("base_price"),
    /** What was actually paid, once the contract closed; null until then. */
    effectivePrice: doublePrecision("effective_price"),
    publishedAt: date("published_at").notNull(),
    signedAt: date("signed_at"),
    /** Main CPV code (the EU procurement vocabulary), e.g. "33600000-6". */
    cpv: text(),
    cpvDescription: text("cpv_description"),
    deadlineDays: integer("deadline_days"),
    /** Where it is carried out, as published: "Portugal, Coimbra, Coimbra". */
    places: text().array().notNull(),
    /** Municipalities and districts those places match (places.key). */
    placeKeys: text("place_keys").array().notNull(),
    legalBasis: text("legal_basis"),
    /** For direct awards: the legal ground given for not opening it to competition. */
    directAwardReason: text("direct_award_reason"),
    frameworkAgreement: text("framework_agreement"),
    centralized: boolean(),
    /** Companies invited to bid, when the procedure lists them. */
    invited: smallint(),
    documentsUrl: text("documents_url"),
    status: text(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("contracts_published_idx").on(table.publishedAt.desc(), table.id.desc()),
    index("contracts_price_idx").on(table.price.desc(), table.id.desc()),
    index("contracts_procedure_idx").on(table.procedureKind, table.publishedAt.desc()),
    index("contracts_place_keys_idx").using("gin", table.placeKeys),
    index("contracts_search_idx").using("gin", sql`to_tsvector('portuguese', ${table.object})`),
  ],
);

/** The public bodies that awarded a contract (entity) and the companies or people it went to (supplier). */
export const contractParties = pgTable(
  "contract_parties",
  {
    contractId: text("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    role: text().$type<"entity" | "supplier">().notNull(),
    position: smallint().notNull(),
    /** Tax number (NIF/NIPC; foreign suppliers may have their own country's); "" when not published. */
    nif: text().notNull(),
    name: text().notNull(),
    country: text(),
  },
  (table) => [
    primaryKey({ columns: [table.contractId, table.role, table.position] }),
    index("contract_parties_nif_idx").on(table.nif, table.role),
  ],
);

/** Which yearly BASE files were imported, so the weekly job skips files that haven't changed. */
export const contractImports = pgTable("contract_imports", {
  year: smallint().primaryKey(),
  sourceModified: text("source_modified").notNull(),
  contracts: integer().notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * People who can sign in to moderate and write: the team and invited authors, never the
 * public (readers stay anonymous). See src/admin/.
 */
export const admins = pgTable("admins", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  email: text().notNull().unique(),
  name: text().notNull(),
  /** scrypt, as written by src/admin/password.ts. */
  passwordHash: text("password_hash").notNull(),
  /** author: writes editorial posts; moderator: also hides content and curates records; admin: also manages admins. */
  role: text().$type<"author" | "moderator" | "admin">().notNull(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/** Signed-in sessions. Only a hash of the cookie's token is stored. */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    adminId: integer("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("admin_sessions_admin_idx").on(table.adminId)],
);

/** Every change made through the admin: who, what, and the record before and after. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    adminId: integer("admin_id").references(() => admins.id, { onDelete: "set null" }),
    /** e.g. "comment.hide", "admin.create". */
    action: text().notNull(),
    entity: text().notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb(),
    after: jsonb(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_log_entity_idx").on(table.entity, table.entityId), index("audit_log_at_idx").on(table.at.desc())],
);

/*
 * The corruption record: judicial cases involving political officeholders, curated by hand
 * through the admin, each with sources. Only published cases are public. Status is the
 * stage the case has reached, never a judgement of our own: see docs/cases-api.md.
 */
export const cases = pgTable(
  "cases",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    /** The name it is known by, e.g. "Operação Influencer". */
    title: text().notNull(),
    summary: text().notNull(),
    /** Crimes at stake, e.g. ["corruption", "influence_peddling"]: see CASE_CRIMES in src/cases/model.ts. */
    crimes: text().array().notNull(),
    /** The stage reached: see CASE_STATUSES. */
    status: text().notNull(),
    statusDate: date("status_date"),
    startedAt: date("started_at"),
    published: boolean().notNull().default(false),
    /** When an editor last checked it against the sources. */
    reviewedAt: date("reviewed_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("cases_published_idx").on(table.published, table.statusDate.desc())],
);

/** People involved in a case, each with their own situation in it. */
export const casePeople = pgTable(
  "case_people",
  {
    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    position: smallint().notNull(),
    name: text().notNull(),
    /** What they were when it happened, e.g. "Ministro das Infraestruturas". */
    roleAtTime: text("role_at_time"),
    partyId: integer("party_id").references(() => parties.id),
    deputyId: integer("deputy_id").references(() => deputies.id, { onDelete: "set null" }),
    governmentMemberId: text("government_member_id").references(() => governmentMembers.id, { onDelete: "set null" }),
    /** Their own stage: suspect, arguido, accused, convicted, acquitted, cleared... see PERSON_STATUSES. */
    status: text().notNull(),
    /** For convictions: the sentence, and whether it is final (transitou em julgado). */
    outcome: text(),
    final: boolean().notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.caseId, table.position] }),
    index("case_people_deputy_idx").on(table.deputyId),
    index("case_people_member_idx").on(table.governmentMemberId),
    index("case_people_party_idx").on(table.partyId),
  ],
);

/** What happened, when: searches, accusations, trial, verdicts, appeals. */
export const caseEvents = pgTable(
  "case_events",
  {
    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    position: smallint().notNull(),
    date: date().notNull(),
    description: text().notNull(),
    /** Positions in case_sources backing this event. */
    sources: smallint().array().notNull(),
  },
  (table) => [primaryKey({ columns: [table.caseId, table.position] })],
);

export const caseSources = pgTable(
  "case_sources",
  {
    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    position: smallint().notNull(),
    url: text().notNull(),
    title: text().notNull(),
    publisher: text().notNull(),
    publishedAt: date("published_at"),
    /** court: a ruling or court document; official: Ministério Público, police or other official statement; news. */
    kind: text().$type<"court" | "official" | "news">().notNull(),
  },
  (table) => [primaryKey({ columns: [table.caseId, table.position] })],
);

/**
 * Officeholders' declared interests (companies, shareholdings, other jobs, clients), curated by
 * hand from their declarations, each with its source. With a NIF, they link to public contracts.
 */
export const interests = pgTable(
  "interests",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    personName: text("person_name").notNull(),
    deputyId: integer("deputy_id").references(() => deputies.id, { onDelete: "set null" }),
    governmentMemberId: text("government_member_id").references(() => governmentMembers.id, { onDelete: "set null" }),
    /** company (owns or founded), shareholding, role (manager, board member...), activity (paid work), client. */
    kind: text().$type<"company" | "shareholding" | "role" | "activity" | "client">().notNull(),
    entityName: text("entity_name").notNull(),
    /** The entity's NIF, when declared or verifiable; links it to contract_parties. */
    nif: text(),
    description: text(),
    startDate: date("start_date"),
    endDate: date("end_date"),
    /** The declaration's date. */
    declaredAt: date("declared_at"),
    sourceUrl: text("source_url").notNull(),
    sourceTitle: text("source_title").notNull(),
    published: boolean().notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("interests_deputy_idx").on(table.deputyId),
    index("interests_member_idx").on(table.governmentMemberId),
    index("interests_nif_idx").on(table.nif),
  ],
);

/*
 * Anonymous forums: one board per party plus a general one. No accounts: posters get an ID
 * per thread derived from their IP and a server secret (like 4chan), so replies can be
 * followed without anyone signing in. See src/forums/ and docs/forums-api.md.
 */
export const forumThreads = pgTable(
  "forum_threads",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    /** A party slug, or "geral". */
    board: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    nickname: text(),
    posterId: text("poster_id").notNull(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Optional link to what the thread is about. */
    articleId: integer("article_id").references(() => articles.id, { onDelete: "set null" }),
    initiativeId: integer("initiative_id").references(() => initiatives.id, { onDelete: "set null" }),
    replyCount: integer("reply_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last reply, for "active" sorting. */
    bumpedAt: timestamp("bumped_at", { withTimezone: true }).notNull().defaultNow(),
    pinned: boolean().notNull().default(false),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    /** Readers' upvotes (forum_votes), kept here for sorting. */
    score: integer().notNull().default(0),
    /** The team's verdict on an idea (board "ideias"), with an optional public answer. */
    status: text().$type<"reviewing" | "planned" | "in_progress" | "done" | "declined">(),
    answer: text(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (table) => [
    index("forum_threads_user_idx").on(table.userId),
    index("forum_threads_board_bumped_idx").on(table.board, table.bumpedAt.desc()),
    index("forum_threads_board_created_idx").on(table.board, table.createdAt.desc()),
    index("forum_threads_board_score_idx").on(table.board, table.score.desc()),
  ],
);

/** One upvote per reader per thread; `voter` is a keyed hash of the IP, never the IP. */
export const forumVotes = pgTable(
  "forum_votes",
  {
    threadId: integer("thread_id")
      .notNull()
      .references(() => forumThreads.id, { onDelete: "cascade" }),
    voter: text().notNull(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.voter] }), index("forum_votes_user_idx").on(table.userId)],
);

export const forumPosts = pgTable(
  "forum_posts",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => forumThreads.id, { onDelete: "cascade" }),
    body: text().notNull(),
    nickname: text(),
    posterId: text("poster_id").notNull(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** The post it quotes, in the same thread. */
    replyTo: integer("reply_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [index("forum_posts_thread_idx").on(table.threadId, table.id), index("forum_posts_user_idx").on(table.userId)],
);

/** Readers' reports of threads, posts and comments, for moderators. */
export const reports = pgTable(
  "reports",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    kind: text().$type<"thread" | "post" | "comment" | "article">().notNull(),
    targetId: integer("target_id").notNull(),
    reason: text().notNull(),
    details: text(),
    /** Hash of the reporter's IP, so one person reporting twice counts once. */
    reporter: text().notNull(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: integer("resolved_by").references(() => admins.id, { onDelete: "set null" }),
    resolution: text().$type<"hidden" | "dismissed">(),
  },
  (table) => [
    index("reports_user_idx").on(table.userId),
    index("reports_open_idx").on(table.resolvedAt, table.createdAt),
    uniqueIndex("reports_once_idx").on(table.kind, table.targetId, table.reporter),
  ],
);

/** Our own editorial: articles, opinion, podcasts and interviews, written in the admin. */
export const editorialPosts = pgTable(
  "editorial_posts",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    slug: text().notNull().unique(),
    kind: text().$type<"article" | "opinion" | "podcast" | "interview" | "video">().notNull(),
    title: text().notNull(),
    subtitle: text(),
    /** Markdown. */
    body: text().notNull(),
    authorId: integer("author_id").references(() => admins.id, { onDelete: "set null" }),
    /** The byline shown; can differ from the admin's name (e.g. a guest). */
    authorName: text("author_name").notNull(),
    coverImageUrl: text("cover_image_url"),
    /** A YouTube, Vimeo, Spotify, SoundCloud or Apple Podcasts link (src/editorial/media.ts). */
    mediaUrl: text("media_url"),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    status: text().$type<"draft" | "published">().notNull().default("draft"),
    featured: boolean().notNull().default(false),
    /** Readers' votes, kept in step with editorial_votes. */
    upvotes: integer().notNull().default(0),
    downvotes: integer().notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("editorial_published_idx").on(table.status, table.publishedAt.desc())],
);

/** One vote (+1 or -1) per reader per editorial post; `voter` is a keyed hash of the IP. */
export const editorialVotes = pgTable(
  "editorial_votes",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => editorialPosts.id, { onDelete: "cascade" }),
    voter: text().notNull(),
    /** The reader's account, when they were logged in. */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    value: smallint().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("editorial_votes_user_idx").on(table.userId),
    primaryKey({ columns: [table.postId, table.voter] }),
    check("editorial_votes_value_check", sql`${table.value} in (-1, 1)`),
  ],
);

/** Reads of a news article on our site, per Lisbon day (one per reader per day; nothing about readers kept). */
export const articleViews = pgTable(
  "article_views",
  {
    articleId: integer("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    day: date().notNull(),
    views: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.articleId, table.day] }), index("article_views_day_idx").on(table.day)],
);

/** Reads of editorial posts, counted per day (Lisbon) and nothing else: no reader data is kept. */
export const editorialViews = pgTable(
  "editorial_views",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => editorialPosts.id, { onDelete: "cascade" }),
    day: date().notNull(),
    views: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.postId, table.day] }), index("editorial_views_day_idx").on(table.day)],
);

/**
 * Newsletter sign-ups, kept to the minimum: the address, when it signed up and whether it confirmed.
 * Confirmation and unsubscribe links are signed tokens (src/newsletter/tokens.ts), not stored.
 * Unsubscribing deletes the row; unconfirmed rows are deleted after a week.
 */
export const newsletterSubscribers = pgTable("newsletter_subscribers", {
  email: text().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

export type AgendaPlace = {
  name: string;
  address: string | null;
  municipality: string | null;
  district: string | null;
  lat: number | null;
  lng: number | null;
};
export type AgendaOnline = { url: string; label: string | null };
export type AgendaAttend = { open: boolean; how: string | null; url: string | null };

/**
 * The political calendar (see src/agenda). Imported events keep their source's id and are
 * replaced on every sync; editors' own events have source "editorial". `featured` and
 * `hidden` are the editors' and survive imports.
 */
export const agendaEvents = pgTable(
  "agenda_events",
  {
    id: text().primaryKey(),
    source: text().$type<"parliament" | "president" | "europarl" | "editorial">().notNull(),
    kind: text().notNull(),
    title: text().notNull(),
    summary: text(),
    allDay: boolean("all_day").notNull(),
    /** Exact start; for all-day events, midnight in Lisbon of the first day. */
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    /** Exact end when known (timed events only). */
    endsAt: timestamp("ends_at", { withTimezone: true }),
    startDay: date("start_day").notNull(),
    /** Last day, inclusive, for all-day events over several days. */
    endDay: date("end_day"),
    /** When it stops being listed: the end, or the end of its last day in Lisbon when unknown. */
    until: timestamp({ withTimezone: true }).notNull(),
    status: text().$type<"scheduled" | "cancelled" | "postponed">().notNull().default("scheduled"),
    place: jsonb().$type<AgendaPlace>(),
    district: text(),
    online: jsonb().$type<AgendaOnline>(),
    attend: jsonb().$type<AgendaAttend>().notNull(),
    organizer: text(),
    partySlugs: text("party_slugs").array().notNull().default(sql`'{}'::text[]`),
    sourceUrl: text("source_url"),
    featured: boolean().notNull().default(false),
    hidden: boolean().notNull().default(false),
    createdBy: integer("created_by").references(() => admins.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("agenda_events_starts_idx").on(table.startsAt, table.id), index("agenda_events_until_idx").on(table.until)],
);

/**
 * Messages from the feedback form. The email (only when the reader wants an answer) is
 * deleted when the message is closed; screenshots after 90 days (see src/feedback).
 */
export const feedbackMessages = pgTable(
  "feedback_messages",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    kind: text().$type<"error" | "idea" | "broken" | "other">().notNull(),
    message: text().notNull(),
    page: text(),
    url: text(),
    correction: text(),
    source: text(),
    email: text(),
    screenshot: bytea(),
    screenshotType: text("screenshot_type"),
    status: text().$type<"open" | "answered" | "closed">().notNull().default("open"),
    /** The team's reply, as sent (or noted when answered outside the admin). */
    reply: text(),
    /** Internal, never shown to the reader. */
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [index("feedback_messages_status_idx").on(table.status, table.createdAt.desc())],
);

/** The public corrections log ("Correções"): what readers pointed out and what we did. */
export const corrections = pgTable(
  "corrections",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    status: text().$type<"fixed" | "checking" | "rejected">().notNull(),
    /** The day it was fixed, or reported while still checking. */
    date: date().notNull(),
    /** The site's section, e.g. "Percursos". */
    area: text().notNull(),
    title: text().notNull(),
    /** A path on the site or a full link. */
    url: text(),
    feedbackId: integer("feedback_id").references(() => feedbackMessages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("corrections_date_idx").on(table.date.desc(), table.id.desc())],
);

/** Our podcast's episodes on Spotify, as the hourly ingest finds them (newest first, from the first one seen). */
export const podcastEpisodes = pgTable(
  "podcast_episodes",
  {
    /** Spotify's episode id: open.spotify.com/episode/<id>. */
    id: text().primaryKey(),
    title: text().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    durationSeconds: integer("duration_seconds"),
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("podcast_episodes_published_idx").on(table.publishedAt.desc())],
);

/*
 * Reader accounts: a public username and a password, nothing else (no email). Taking part
 * (comments, forum, votes, reports) needs one; reading doesn't.
 */
export const users = pgTable(
  "users",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    /** Public, shown on everything they post; unique ignoring case. */
    username: text().notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Set by a moderator: the account can't log in or take part. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("users_username_idx").on(sql`lower(${table.username})`)],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    /** SHA-256 of the cookie's token; the token itself is never stored. */
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("user_sessions_user_idx").on(table.userId)],
);

/** Saved news and stories ("Guardadas"). */
export const userSaves = pgTable(
  "user_saves",
  {
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text().$type<"article" | "story">().notNull(),
    targetId: integer("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.kind, table.targetId] })],
);

/** News the reader hid from their feed. */
export const userHidden = pgTable(
  "user_hidden",
  {
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    articleId: integer("article_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.articleId] })],
);

/** Outlets (by domain) and parties (by slug) the reader muted. */
export const userMutes = pgTable(
  "user_mutes",
  {
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text().$type<"source" | "party">().notNull(),
    value: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.kind, table.value] })],
);

/** Stories the reader has read ("Hoje em 5" ticks). */
export const userReads = pgTable(
  "user_reads",
  {
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    storyId: integer("story_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.storyId] })],
);
