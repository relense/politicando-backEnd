import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { BECOME_DEPUTY } from "../../explainers/becomeDeputy.js";

const sectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.array(z.string()).describe("Paragraphs, plain text"),
  sources: z.array(z.object({ label: z.string(), url: z.string().nullable() })).describe("Legal basis"),
});

export const explainerRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/explainers/become-deputy",
      {
        schema: {
          tags: ["explainers"],
          summary: "How one becomes a deputy: the rules, with their legal basis, and seats per círculo",
          response: {
            200: z.object({
              title: z.string(),
              reviewedAt: z.string().describe("When the text was last checked against the law"),
              sections: z.array(sectionSchema),
              circles: z
                .object({
                  election: z.string().describe("The legislativas the seats come from"),
                  items: z.array(z.object({ key: z.string(), name: z.string(), seats: z.number() })),
                })
                .nullable()
                .describe("Seats per círculo in the latest legislativas, biggest first; null before any is imported"),
            }),
          },
        },
      },
      async () => {
        const rows = await db.execute<{ election_id: string; key: string; name: string; seats: number }>(sql`
          with latest as (
            select id from elections where type = 'legislativas' and imported_at is not null order by date desc limit 1
          )
          select t.election_id, p.key, p.name, t.total_mandates as seats
          from election_turnout t
          join latest on latest.id = t.election_id
          join places p on p.key = t.place_key
          where t.organ = 'AR' and t.total_mandates > 0
            and (p.level = 'district' or p.key in ('FOREIGN-800000', 'FOREIGN-900000'))
          order by t.total_mandates desc, p.name`);
        return {
          ...BECOME_DEPUTY,
          circles:
            rows.rows.length > 0
              ? { election: rows.rows[0]!.election_id, items: rows.rows.map(({ key, name, seats }) => ({ key, name, seats })) }
              : null,
        };
      },
    );
  };
