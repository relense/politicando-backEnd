import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { parties } from "../../db/schema.js";
import { GOVERNMENTS, HEADS_OF_GOVERNMENT_URL, LEGISLATIVE_ELECTION_DATES, portalUrl } from "../../government/history.js";
import { PRESIDENTS } from "../../presidency/presidents.js";

const endReasonSchema = z.enum([
  "end_of_term", "early_election", "censure", "confidence_rejected", "programme_rejected",
  "resignation", "dismissed", "death", "provisional", "in_office",
]);

export const partySchema = z.object({ slug: z.string(), acronym: z.string(), name: z.string() });

export const governmentSchema = z.object({
  code: z.string().describe('"gc01"-"gc25" (constitutional), "gp1"-"gp6" (provisional, 1974-76)'),
  kind: z.enum(["constitutional", "provisional"]),
  name: z.string(),
  primeMinister: z.string(),
  start: z.string(),
  end: z.string().nullable().describe("The day the next government took office; null while in office"),
  days: z.number().describe("Days in office (so far, for the current one)"),
  parties: z.array(partySchema).describe("Parties in government; empty for provisional and presidential-initiative governments"),
  support: z.string().describe('e.g. "Maioria absoluta do PSD", "Minoria do PS"'),
  endReason: endReasonSchema,
  endNote: z.string().nullable().describe("What happened, in one sentence"),
  portalUrl: z.string().nullable().describe("Its pages on portugal.gov.pt (from the XXI Government on)"),
  current: z.boolean(),
});

const DAY = 24 * 60 * 60 * 1000;
const daysBetween = (from: string, to: string | null) =>
  Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / DAY);

const timelineKind = z.enum(["government", "election", "president"]);

/** Every government, oldest first, with its parties resolved. */
export const historicGovernments = async (db: Db) => {
  const known = new Map(
    (await db.select({ slug: parties.slug, acronym: parties.acronym, name: parties.name }).from(parties)).map((p) => [p.slug, p]),
  );
  return GOVERNMENTS.map((gov) => ({
    ...gov,
    days: daysBetween(gov.start, gov.end),
    parties: gov.parties.flatMap((slug) => (known.has(slug) ? [known.get(slug)!] : [])),
    portalUrl: portalUrl(gov.code),
    current: gov.end === null,
  }));
};

export const historyRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const governments = () => historicGovernments(db);

    app.get(
      "/governments/history",
      {
        schema: {
          tags: ["history"],
          summary: "Every government since 1974, newest first, with how each one ended",
          response: {
            200: z.object({
              items: z.array(governmentSchema),
              source: z.string().describe("The Government's list of heads of government, which the dates follow"),
            }),
          },
        },
      },
      async () => ({ items: (await governments()).reverse(), source: HEADS_OF_GOVERNMENT_URL }),
    );

    app.get(
      "/timeline",
      {
        schema: {
          tags: ["history"],
          summary: "Governments, elections and Presidents since 1974 on one timeline, newest first",
          querystring: z.object({
            from: z.iso.date().optional().describe("Only events that end on or after this date"),
            to: z.iso.date().optional().describe("Only events that start on or before this date"),
            kinds: z
              .string()
              .regex(/^(government|election|president)(,(government|election|president))*$/)
              .optional()
              .describe("Comma-separated: government, election, president. Default: all"),
          }),
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  kind: timelineKind,
                  date: z.string(),
                  endDate: z.string().nullable().describe("For spans (governments, Presidents); null if ongoing or a single day"),
                  title: z.string(),
                  detail: z.string().nullable(),
                  ref: z
                    .object({ kind: z.string(), id: z.string() })
                    .nullable()
                    .describe("government: /governments/history code; election: /elections/:id; president: /people/president/:id/path"),
                }),
              ),
            }),
          },
        },
      },
      async (request) => {
        const kinds = new Set(request.query.kinds?.split(",") ?? ["government", "election", "president"]);
        type Item = { kind: z.infer<typeof timelineKind>; date: string; endDate: string | null; title: string; detail: string | null; ref: { kind: string; id: string } | null };
        const items: Item[] = [];

        if (kinds.has("government")) {
          for (const gov of await governments()) {
            items.push({
              kind: "government", date: gov.start, endDate: gov.end, title: gov.name,
              detail: `${gov.primeMinister}. ${gov.support}${gov.endNote ? `. ${gov.endNote}` : ""}`,
              ref: { kind: "government", id: gov.code },
            });
          }
        }

        if (kinds.has("president")) {
          for (const p of PRESIDENTS) {
            items.push({
              kind: "president", date: p.termStart, endDate: p.termEnd, title: `Presidente da República: ${p.name}`,
              detail: null, ref: { kind: "president", id: p.id },
            });
          }
        }

        if (kinds.has("election")) {
          // Imported elections, with who came first in the whole country.
          const imported = await db.execute<{ id: string; type: string; name: string; date: string; winner: string | null; valid_pct: number | null }>(sql`
            select e.id, e.type, e.name, e.date::text as date, w.name as winner, w.valid_pct
            from elections e
            left join lateral (
              select coalesce(r.label, l.name, r.list) as name, r.valid_pct
              from election_results r
              left join election_lists l on l.election_id = r.election_id and l.list = r.list
              where r.election_id = e.id and r.organ = e.organs[1]
                and r.place_key = (
                  select t.place_key from election_turnout t
                  where t.election_id = e.id and t.organ = e.organs[1] and t.place_key in ('GLOBAL-990000', 'LOCAL-500000')
                  order by t.place_key limit 1
                )
              order by r.votes desc limit 1
            ) w on true`);
          const importedLegislativas = new Set(imported.rows.filter((e) => e.type === "legislativas").map((e) => e.date));
          for (const e of imported.rows) {
            items.push({
              kind: "election", date: e.date, endDate: null, title: e.name,
              detail: e.winner ? `Mais votado: ${e.winner}${e.valid_pct !== null ? ` (${e.valid_pct.toLocaleString("pt-PT")}%)` : ""}` : null,
              ref: { kind: "election", id: e.id },
            });
          }
          for (const date of LEGISLATIVE_ELECTION_DATES) {
            if (importedLegislativas.has(date)) continue;
            items.push({
              kind: "election", date, endDate: null,
              title: date === "1975-04-25" ? "Eleições para a Assembleia Constituinte" : `Legislativas ${date.slice(0, 4)}`,
              detail: null, ref: null,
            });
          }
        }

        const { from, to } = request.query;
        return {
          items: items
            .filter((i) => (!from || (i.endDate ?? (i.kind === "election" ? i.date : "9999")) >= from) && (!to || i.date <= to))
            .sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind)),
        };
      },
    );
  };
