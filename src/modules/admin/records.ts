import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, adminGuard } from "../../admin/sessions.js";
import { caseInputSchema, interestInputSchema, publishProblems } from "../../cases/model.js";
import { assertPeopleExist, loadCases, saveCase } from "../../cases/store.js";
import type { Db } from "../../db/client.js";
import { cases, interests } from "../../db/schema.js";
import { ApiError, notFound } from "../../errors.js";
import { errorSchema } from "../shared.js";

/*
 * Curating the corruption record and declared interests (role moderator). Every change is
 * audited with the record before and after.
 */

const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema };

const storedCaseSchema = caseInputSchema.extend({
  id: z.number(),
  published: z.boolean(),
  updatedAt: z.string(),
  problems: z.array(z.string()).describe("What stops it from being published; empty when it can be"),
});

const storedInterestSchema = interestInputSchema.extend({ id: z.number(), updatedAt: z.string() });

export const adminRecordRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    const requireAdmin = adminGuard(db);

    const loadCase = async (id: number) => {
      const [found] = await loadCases(db, [id]);
      if (!found) throw notFound("Case");
      return found;
    };
    const withProblems = (c: Awaited<ReturnType<typeof loadCase>>) => ({ ...c, problems: publishProblems(c) });

    app.get(
      "/admin/cases",
      {
        schema: {
          tags: ["admin"],
          summary: "Every case, drafts included, last edited first",
          response: {
            200: z.object({
              items: z.array(z.object({ id: z.number(), title: z.string(), status: z.string(), published: z.boolean(), updatedAt: z.string() })),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const rows = await db
          .select({ id: cases.id, title: cases.title, status: cases.status, published: cases.published, updatedAt: cases.updatedAt })
          .from(cases)
          .orderBy(desc(cases.updatedAt));
        return { items: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
      },
    );

    app.get(
      "/admin/cases/:id",
      { schema: { tags: ["admin"], summary: "One case, to edit", params: idParams, response: { 200: storedCaseSchema, ...errors } } },
      async (request) => {
        await requireAdmin(request, "moderator");
        return withProblems(await loadCase(request.params.id));
      },
    );

    app.post(
      "/admin/cases",
      {
        schema: {
          tags: ["admin"],
          summary: "Create a case as a draft",
          body: caseInputSchema,
          response: { 201: storedCaseSchema, ...errors },
        },
      },
      async (request, reply) => {
        const me = await requireAdmin(request, "moderator");
        const id = await saveCase(db, null, request.body);
        const saved = await loadCase(id);
        await audit(db, me.id, "case.create", "case", id, null, saved);
        return reply.status(201).send(withProblems(saved));
      },
    );

    app.put(
      "/admin/cases/:id",
      {
        schema: {
          tags: ["admin"],
          summary: "Replace a case with a new version. A published case stays published only if it still can be",
          params: idParams,
          body: caseInputSchema,
          response: { 200: storedCaseSchema, ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const before = await loadCase(request.params.id);
        if (before.published) {
          const problems = publishProblems(request.body);
          if (problems.length) throw new ApiError(400, "not_publishable", `Unpublish it first, or fix: ${problems.join(" ")}`);
        }
        await saveCase(db, before.id, request.body);
        const after = await loadCase(before.id);
        await audit(db, me.id, "case.update", "case", before.id, before, after);
        return withProblems(after);
      },
    );

    for (const publish of [true, false]) {
      app.post(
        `/admin/cases/:id/${publish ? "publish" : "unpublish"}`,
        {
          schema: {
            tags: ["admin"],
            summary: publish ? "Publish a case (it must be sourced and reviewed)" : "Take a case off the public site",
            params: idParams,
            response: { 200: storedCaseSchema, ...errors },
          },
        },
        async (request) => {
          const me = await requireAdmin(request, "moderator");
          const before = await loadCase(request.params.id);
          if (publish) {
            const problems = publishProblems(before);
            if (problems.length) throw new ApiError(400, "not_publishable", problems.join(" "));
          }
          if (before.published !== publish) {
            await db.update(cases).set({ published: publish, updatedAt: new Date() }).where(eq(cases.id, before.id));
            await audit(db, me.id, publish ? "case.publish" : "case.unpublish", "case", before.id);
          }
          return withProblems(await loadCase(before.id));
        },
      );
    }

    // Declared interests.

    const storedInterest = (row: typeof interests.$inferSelect) => {
      const { createdAt: _created, updatedAt, ...rest } = row;
      return { ...rest, updatedAt: updatedAt.toISOString() };
    };

    app.get(
      "/admin/interests",
      {
        schema: {
          tags: ["admin"],
          summary: "Every declared interest, drafts included",
          querystring: z.object({ deputy: z.coerce.number().int().positive().optional(), member: z.string().max(64).optional() }),
          response: { 200: z.object({ items: z.array(storedInterestSchema) }), ...errors },
        },
      },
      async (request) => {
        await requireAdmin(request, "moderator");
        const { deputy, member } = request.query;
        const rows = await db
          .select()
          .from(interests)
          .where(deputy ? eq(interests.deputyId, deputy) : member ? eq(interests.governmentMemberId, member) : undefined)
          .orderBy(interests.personName, interests.entityName);
        return { items: rows.map(storedInterest) };
      },
    );

    app.post(
      "/admin/interests",
      {
        schema: { tags: ["admin"], summary: "Record a declared interest", body: interestInputSchema, response: { 201: storedInterestSchema, ...errors } },
      },
      async (request, reply) => {
        const me = await requireAdmin(request, "moderator");
        await assertPeopleExist(db, [request.body]);
        const [created] = await db.insert(interests).values(request.body).returning();
        await audit(db, me.id, "interest.create", "interest", created!.id, null, storedInterest(created!));
        return reply.status(201).send(storedInterest(created!));
      },
    );

    app.put(
      "/admin/interests/:id",
      {
        schema: {
          tags: ["admin"],
          summary: "Replace a declared interest",
          params: idParams,
          body: interestInputSchema,
          response: { 200: storedInterestSchema, ...errors },
        },
      },
      async (request) => {
        const me = await requireAdmin(request, "moderator");
        const [before] = await db.select().from(interests).where(eq(interests.id, request.params.id));
        if (!before) throw notFound("Interest");
        await assertPeopleExist(db, [request.body]);
        const [after] = await db
          .update(interests)
          .set({ ...request.body, updatedAt: new Date() })
          .where(eq(interests.id, before.id))
          .returning();
        await audit(db, me.id, "interest.update", "interest", before.id, storedInterest(before), storedInterest(after!));
        return storedInterest(after!);
      },
    );

    app.delete(
      "/admin/interests/:id",
      {
        schema: { tags: ["admin"], summary: "Delete a declared interest (kept in the audit log)", params: idParams, response: { 204: z.null(), ...errors } },
      },
      async (request, reply) => {
        const me = await requireAdmin(request, "moderator");
        const [deleted] = await db.delete(interests).where(eq(interests.id, request.params.id)).returning();
        if (!deleted) throw notFound("Interest");
        await audit(db, me.id, "interest.delete", "interest", deleted.id, storedInterest(deleted), null);
        return reply.status(204).send(null);
      },
    );
  };
