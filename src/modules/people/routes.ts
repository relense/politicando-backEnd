import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { deputies, governmentMembers, governmentPositions, parties, presidents } from "../../db/schema.js";
import { notFound } from "../../errors.js";
import { LEGISLATURES } from "../../parliament/legislatures.js";
import { PARTY_LEADERS } from "../../parliament/leadership.js";
import { candidaciesOf } from "../../elections/candidates.js";
import {
  candidacySteps,
  deputyCurrentRoles,
  deputyOtherRoles,
  deputySteps,
  governmentSteps,
  presidencySteps,
  sortPath,
} from "../../people/path.js";
import { BIOGRAPHY_URL, PRESIDENTS, currentPresident } from "../../presidency/presidents.js";
import { photoUrl } from "../parliament/routes.js";
import { errorSchema } from "../shared.js";

const kindSchema = z.enum(["deputy", "government", "president"]);

const stepSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable().describe("Null while ongoing"),
  precision: z
    .enum(["day", "legislature"])
    .describe("legislature: they sat at some point in that legislature, whose dates these are"),
  title: z.string(),
  detail: z.string().nullable(),
  kind: z.enum(["election", "parliament", "government", "presidency", "party", "local", "other"]),
  current: z.boolean(),
  source: z.string().nullable().describe("Official page this comes from; for elections, our endpoint with the full list"),
});

const refSchema = z.object({ kind: kindSchema, id: z.string() });

const personSchema = z.object({
  name: z.string(),
  photoUrl: z.string().nullable(),
  party: z.object({ slug: z.string(), acronym: z.string() }).nullable(),
  links: z
    .object({ deputyId: z.number().nullable(), governmentMemberId: z.string().nullable(), presidentId: z.string().nullable() })
    .describe("The same person's records elsewhere: /deputies/:id, /government/members/:id, /president"),
});

const LEGISLATURE = LEGISLATURES.at(-1)!.id;

export const peopleRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const deputyById = async (id: number) => {
      const [row] = await db
        .select({
          id: deputies.id,
          name: deputies.name,
          constituency: deputies.constituency,
          sittingPeriods: deputies.sittingPeriods,
          pastLegislatures: deputies.pastLegislatures,
          positions: deputies.positions,
          roles: deputies.roles,
          gender: deputies.gender,
          slug: parties.slug,
          acronym: parties.acronym,
        })
        .from(deputies)
        .leftJoin(parties, eq(parties.id, deputies.partyId))
        .where(eq(deputies.id, id));
      return row ?? null;
    };

    const memberBy = async (where: ReturnType<typeof eq>) => {
      const [member] = await db
        .select({ id: governmentMembers.id, name: governmentMembers.name, photoUrl: governmentMembers.photoUrl, deputyId: governmentMembers.deputyId })
        .from(governmentMembers)
        .where(where);
      if (!member) return null;
      const posts = await db
        .select({
          title: governmentPositions.title,
          areaName: governmentPositions.areaName,
          startDate: governmentPositions.startDate,
          endDate: governmentPositions.endDate,
          url: governmentPositions.url,
        })
        .from(governmentPositions)
        .where(eq(governmentPositions.memberId, member.id));
      return { ...member, posts };
    };

    const build = async (kind: z.infer<typeof kindSchema>, id: string) => {
      let deputy: Awaited<ReturnType<typeof deputyById>> = null;
      let member: Awaited<ReturnType<typeof memberBy>> = null;
      let president: (typeof PRESIDENTS)[number] | null = null;

      if (kind === "deputy") {
        if (!/^\d{1,9}$/.test(id)) throw notFound("Deputy");
        deputy = await deputyById(Number(id));
        if (!deputy) throw notFound("Deputy");
        member = await memberBy(eq(governmentMembers.deputyId, deputy.id));
      } else if (kind === "government") {
        member = await memberBy(eq(governmentMembers.id, id));
        if (!member) throw notFound("Government member");
        if (member.deputyId !== null) deputy = await deputyById(member.deputyId);
      } else {
        president = PRESIDENTS.find((p) => p.id === id) ?? null;
        if (!president) throw notFound("President");
      }

      const record = deputy && { ...deputy, legislature: LEGISLATURE };
      const candidacies = deputy
        ? (await candidaciesOf(db, deputy.id)).rows.map((r) => ({
            electionId: r.election_id, electionName: r.election_name, date: r.date, place: r.place,
            list: r.list, kind: r.kind, position: r.position, elected: r.elected,
          }))
        : [];
      const steps = [
        ...candidacySteps(candidacies, deputy?.gender ?? null),
        ...(record ? deputySteps(record) : []),
        ...(member ? governmentSteps(member.posts) : []),
        ...(president ? presidencySteps(president, BIOGRAPHY_URL) : []),
      ];
      let presidentPhoto: string | null = null;
      if (president) {
        const [row] = await db.select({ photoUrl: presidents.photoUrl }).from(presidents).where(eq(presidents.id, president.id));
        presidentPhoto = row?.photoUrl ?? null;
      }
      return {
        person: {
          name: president?.name ?? member?.name ?? deputy!.name,
          photoUrl: presidentPhoto ?? member?.photoUrl ?? (deputy ? photoUrl(deputy.id) : null),
          party: deputy?.slug && deputy.acronym ? { slug: deputy.slug, acronym: deputy.acronym } : null,
          links: { deputyId: deputy?.id ?? null, governmentMemberId: member?.id ?? null, presidentId: president?.id ?? null },
        },
        path: sortPath(steps),
        currentRoles: record ? deputyCurrentRoles(record) : [],
        otherRoles: record ? deputyOtherRoles(record) : [],
      };
    };

    app.get(
      "/people/:kind/:id/path",
      {
        schema: {
          tags: ["people"],
          summary: "A person's career path: parliament, Government and Presidency, from official records",
          params: z.object({ kind: kindSchema, id: z.string().regex(/^[a-z0-9-]{1,64}$/) }),
          response: {
            200: z.object({
              person: personSchema,
              path: z.array(stepSchema).describe("Dated steps, ongoing first, then newest"),
              currentRoles: z.array(stepSchema).describe("Positions held now that the sources don't date"),
              otherRoles: z.array(stepSchema).describe("Other roles from their parliament biography, undated"),
            }),
            400: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (request) => build(request.params.kind, request.params.id),
    );

    app.get(
      "/people/featured",
      {
        schema: {
          tags: ["people"],
          summary: "People whose paths are worth showing first: the President, the Prime Minister, party leaders",
          response: {
            200: z.object({
              items: z.array(
                refSchema.extend({
                  name: z.string(),
                  role: z.string(),
                  photoUrl: z.string().nullable(),
                  party: z.object({ slug: z.string(), acronym: z.string() }).nullable(),
                }),
              ),
            }),
          },
        },
      },
      async () => {
        type Item = z.infer<typeof refSchema> & { name: string; role: string; photoUrl: string | null; party: { slug: string; acronym: string } | null };
        const items: Item[] = [];

        const president = currentPresident();
        const [stored] = await db.select({ photoUrl: presidents.photoUrl }).from(presidents).where(eq(presidents.id, president.id));
        items.push({ kind: "president", id: president.id, name: president.name, role: "Presidente da República", photoUrl: stored?.photoUrl ?? null, party: null });

        const [pm] = await db
          .select({ id: governmentMembers.id, name: governmentMembers.name, photoUrl: governmentMembers.photoUrl, slug: parties.slug, acronym: parties.acronym })
          .from(governmentPositions)
          .innerJoin(governmentMembers, eq(governmentMembers.id, governmentPositions.memberId))
          .leftJoin(deputies, eq(deputies.id, governmentMembers.deputyId))
          .leftJoin(parties, eq(parties.id, deputies.partyId))
          .where(and(eq(governmentPositions.kind, "prime_minister"), isNull(governmentPositions.endDate)))
          .orderBy(desc(governmentPositions.startDate))
          .limit(1);
        if (pm) {
          items.push({
            kind: "government", id: pm.id, name: pm.name, role: "Primeiro-Ministro", photoUrl: pm.photoUrl,
            party: pm.slug && pm.acronym ? { slug: pm.slug, acronym: pm.acronym } : null,
          });
        }

        // The Assembly's President, then party leaders who sit as deputies, biggest party first.
        const ids = Object.keys(PARTY_LEADERS).map(Number);
        const rows = await db
          .select({ id: deputies.id, name: deputies.name, role: deputies.parliamentRole, slug: parties.slug, acronym: parties.acronym, seats: parties.assemblySeats })
          .from(deputies)
          .leftJoin(parties, eq(parties.id, deputies.partyId))
          .where(and(eq(deputies.active, true), sql`(${deputies.parliamentRole} = 'Presidente' or ${inArray(deputies.id, ids)})`))
          .orderBy(sql`${deputies.parliamentRole} = 'Presidente' desc nulls last`, desc(parties.assemblySeats), deputies.name);
        for (const row of rows) {
          items.push({
            kind: "deputy", id: String(row.id), name: row.name,
            role: row.role === "Presidente" ? "Presidente da Assembleia da República" : PARTY_LEADERS[row.id]!,
            photoUrl: photoUrl(row.id),
            party: row.slug && row.acronym ? { slug: row.slug, acronym: row.acronym } : null,
          });
        }
        return { items };
      },
    );
  };
