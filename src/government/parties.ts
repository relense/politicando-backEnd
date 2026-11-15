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

const byKey = new Map(Object.entries(BY_NAME).map(([name, slug]) => [nameKey(name), slug]));

export const curatedParty = (name: string) => byKey.get(nameKey(name)) ?? null;

/** The party a member is shown with, and where it comes from. */
export const memberParty = (name: string, deputyParty: string | null) =>
  deputyParty
    ? { party: deputyParty, partySource: "deputy" as const }
    : curatedParty(name)
      ? { party: curatedParty(name), partySource: "curated" as const }
      : { party: null, partySource: null };

/** The curated list as SQL rows (name, slug), for queries that count members per party. */
export const curatedPartiesSql = () =>
  sql`(values ${sql.join(
    Object.entries(BY_NAME).map(([name, slug]) => sql`(${name}, ${slug})`),
    sql`, `,
  )}) as curated(name, slug)`;
