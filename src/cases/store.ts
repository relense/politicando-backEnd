import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { caseEvents, casePeople, caseSources, cases, deputies, governmentMembers, parties } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { CaseInput } from "./model.js";

export type StoredCase = CaseInput & { id: number; published: boolean; updatedAt: string };

/** Cases with their people, events and sources, in the shape editors write them. */
export const loadCases = async (db: Db, ids: number[]): Promise<StoredCase[]> => {
  if (ids.length === 0) return [];
  const [rows, people, events, sources] = await Promise.all([
    db.select().from(cases).where(inArray(cases.id, ids)),
    db
      .select({ person: casePeople, party: parties.slug })
      .from(casePeople)
      .leftJoin(parties, eq(parties.id, casePeople.partyId))
      .where(inArray(casePeople.caseId, ids))
      .orderBy(asc(casePeople.position)),
    db.select().from(caseEvents).where(inArray(caseEvents.caseId, ids)).orderBy(asc(caseEvents.position)),
    db.select().from(caseSources).where(inArray(caseSources.caseId, ids)).orderBy(asc(caseSources.position)),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const c = byId.get(id);
    if (!c) return [];
    return [
      {
        id: c.id,
        title: c.title,
        summary: c.summary,
        crimes: c.crimes as CaseInput["crimes"],
        status: c.status as CaseInput["status"],
        statusDate: c.statusDate,
        startedAt: c.startedAt,
        reviewedAt: c.reviewedAt,
        published: c.published,
        updatedAt: c.updatedAt.toISOString(),
        people: people
          .filter((p) => p.person.caseId === id)
          .map(({ person: p, party }) => ({
            name: p.name, roleAtTime: p.roleAtTime, party, deputyId: p.deputyId, governmentMemberId: p.governmentMemberId,
            status: p.status as CaseInput["people"][number]["status"], outcome: p.outcome, final: p.final,
          })),
        events: events
          .filter((e) => e.caseId === id)
          .map((e) => ({ date: e.date, description: e.description, sources: e.sources })),
        sources: sources
          .filter((s) => s.caseId === id)
          .map((s) => ({ url: s.url, title: s.title, publisher: s.publisher, publishedAt: s.publishedAt, kind: s.kind })),
      },
    ];
  });
};

/** 400 if a deputy or Government member id doesn't exist (rather than a foreign-key error). */
export const assertPeopleExist = async (db: Db, people: { deputyId: number | null; governmentMemberId: string | null }[]) => {
  const deputyIds = [...new Set(people.flatMap((p) => p.deputyId ?? []))];
  const memberIds = [...new Set(people.flatMap((p) => p.governmentMemberId ?? []))];
  const [foundDeputies, foundMembers] = await Promise.all([
    deputyIds.length ? db.select({ id: deputies.id }).from(deputies).where(inArray(deputies.id, deputyIds)) : [],
    memberIds.length ? db.select({ id: governmentMembers.id }).from(governmentMembers).where(inArray(governmentMembers.id, memberIds)) : [],
  ]);
  const missingDeputies = deputyIds.filter((id) => !foundDeputies.some((d) => d.id === id));
  const missingMembers = memberIds.filter((id) => !foundMembers.some((m) => m.id === id));
  if (missingDeputies.length) throw new ApiError(400, "unknown_deputy", `Unknown deputy: ${missingDeputies.join(", ")}`);
  if (missingMembers.length) throw new ApiError(400, "unknown_government_member", `Unknown Government member: ${missingMembers.join(", ")}`);
};

/** Creates (id null) or replaces a case with its people, events and sources. Keeps `published` as is. */
export const saveCase = async (db: Db, id: number | null, input: CaseInput) => {
  const slugs = [...new Set(input.people.flatMap((p) => p.party ?? []))];
  const partyRows = slugs.length ? await db.select({ id: parties.id, slug: parties.slug }).from(parties).where(inArray(parties.slug, slugs)) : [];
  const partyId = new Map(partyRows.map((p) => [p.slug, p.id]));
  const unknown = slugs.filter((s) => !partyId.has(s));
  if (unknown.length) throw new ApiError(400, "unknown_party", `Unknown party: ${unknown.join(", ")}`);
  await assertPeopleExist(db, input.people);

  return db.transaction(async (tx) => {
    const fields = {
      title: input.title, summary: input.summary, crimes: input.crimes, status: input.status,
      statusDate: input.statusDate, startedAt: input.startedAt, reviewedAt: input.reviewedAt, updatedAt: new Date(),
    };
    let caseId = id;
    if (caseId === null) {
      const [created] = await tx.insert(cases).values(fields).returning({ id: cases.id });
      caseId = created!.id;
    } else {
      await tx.update(cases).set(fields).where(eq(cases.id, caseId));
      await tx.delete(casePeople).where(eq(casePeople.caseId, caseId));
      await tx.delete(caseEvents).where(eq(caseEvents.caseId, caseId));
      await tx.delete(caseSources).where(eq(caseSources.caseId, caseId));
    }
    const at = <T>(list: T[]) => list.map((item, i) => ({ ...item, caseId: caseId!, position: i + 1 }));
    if (input.people.length) {
      await tx.insert(casePeople).values(
        at(input.people).map(({ party, ...p }) => ({ ...p, partyId: party ? partyId.get(party)! : null })),
      );
    }
    if (input.events.length) await tx.insert(caseEvents).values(at(input.events));
    if (input.sources.length) await tx.insert(caseSources).values(at(input.sources));
    return caseId;
  });
};
