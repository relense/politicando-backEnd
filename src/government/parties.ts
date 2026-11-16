import { sql } from "drizzle-orm";
import { nameKey } from "./sync.js";

/*
 * Party of Government members who aren't deputies, kept by hand. The portal doesn't say, and
 * many members are independents, so only add someone whose membership is public record (a
 * party office, an election on its lists). Everyone else stays null: unknown, not
 * "independent". Deputies' parties come from parliament and take precedence.
 */
const BY_NAME: Record<string, string> = {
  "Luís Montenegro": "psd",
  "Joaquim Miranda Sarmento": "psd",
  "Paulo Rangel": "psd",
  "Miguel Pinto Luz": "psd",
  "Carlos Abreu Amorim": "psd",
  "Manuel Castro Almeida": "psd",
  "Maria da Graça Carvalho": "psd",
  "Margarida Balseiro Lopes": "psd",
  "José Manuel Fernandes": "psd",
  "Telmo Correia": "cds-pp",
};

/**
 * Members known to belong to no party, each with the public source that says so (an official
 * biography, an interview). Without one they stay unknown rather than independent.
 */
const INDEPENDENTS: Record<string, string> = {};

const independents = new Set(Object.keys(INDEPENDENTS).map(nameKey));
export const isIndependent = (name: string) => independents.has(nameKey(name));

const byKey = new Map(Object.entries(BY_NAME).map(([name, slug]) => [nameKey(name), slug]));

export const curatedParty = (name: string) => byKey.get(nameKey(name)) ?? null;

/** The party a member is shown with, and where it comes from. */
export const memberParty = (name: string, deputyParty: string | null) =>
  deputyParty
    ? { party: deputyParty, partySource: "deputy" as const, independent: false }
    : curatedParty(name)
      ? { party: curatedParty(name), partySource: "curated" as const, independent: false }
      : { party: null, partySource: null, independent: isIndependent(name) };

/** The curated list as SQL rows (name, slug), for queries that count members per party. */
export const curatedPartiesSql = () =>
  sql`(values ${sql.join(
    Object.entries(BY_NAME).map(([name, slug]) => sql`(${name}, ${slug})`),
    sql`, `,
  )}) as curated(name, slug)`;
