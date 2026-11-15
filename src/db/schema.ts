import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  date,
  index,
  boolean,
  doublePrecision,
  integer,
  real,
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
  promulgatedAt: string | null;
  vetoedAt: string | null;
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
