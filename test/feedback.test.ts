import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/admin/password.js";
import { buildApp } from "../src/app.js";
import { admins, feedbackMessages } from "../src/db/schema.js";
import { purgeFeedback } from "../src/feedback/purge.js";
import type { MailMessage } from "../src/newsletter/mailer.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
let human = true;
const sent: MailMessage[] = [];
const app = await buildApp({
  db, corsOrigins: [], verifyRecaptcha: async () => human, loginLimitPerMinute: 1000, feedbackLimitPerHour: 1000,
  mailer: async (message) => void sent.push(message),
});

beforeEach(async () => {
  human = true;
  sent.length = 0;
  await resetDb(db);
  const passwordHash = await hashPassword("correct horse battery");
  await db.insert(admins).values([
    { email: "mod@example.pt", name: "Mod", role: "moderator", passwordHash },
    { email: "ana@example.pt", name: "Ana", role: "author", passwordHash },
  ]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

/** A multipart/form-data body, as a browser sends the form. */
const form = (fields: Record<string, string>, file?: { name?: string; type: string; bytes: Buffer }) => {
  const boundary = "----politicando-test";
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
  );
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name ?? "screenshot"}"; filename="ecra.png"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.bytes, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
};
const send = async (fields: Record<string, string>, file?: Parameters<typeof form>[1]) => {
  const response = await app.inject({ method: "POST", url: "/api/v2/feedback", ...form({ recaptchaToken: "t", ...fields }, file) });
  return { status: response.statusCode, body: response.json() };
};
const login = async (email = "mod@example.pt") => {
  const response = await app.inject({ method: "POST", url: "/api/v2/admin/login", payload: { email, password: "correct horse battery" } });
  return `politicando_admin=${response.cookies.find((c) => c.name === "politicando_admin")!.value}`;
};
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie?: string, payload?: object) => {
  const response = await app.inject({ method, url: `/api/v2${url}`, headers: cookie ? { cookie } : {}, ...(payload && { payload }) });
  return { status: response.statusCode, body: response.headers["content-type"]?.includes("json") ? response.json() : response.rawPayload, headers: response.headers };
};

describe("POST /feedback", () => {
  it("takes the form with a screenshot", async () => {
    const created = await send(
      { kind: "error", message: "O deputado X não é do PS", page: "Percursos", url: "/percursos/x", correction: "É do PSD", source: "parlamento.pt", email: "leitor@example.pt" },
      { type: "image/png", bytes: PNG },
    );
    expect(created).toEqual({ status: 201, body: { id: expect.any(Number) } });
    const [row] = await db.select().from(feedbackMessages);
    expect(row).toMatchObject({ kind: "error", page: "Percursos", correction: "É do PSD", email: "leitor@example.pt", screenshotType: "image/png", status: "open" });
    expect(row!.screenshot!.equals(PNG)).toBe(true);
  });

  it("explains what's wrong with the codes the page knows", async () => {
    expect((await send({ kind: "idea", message: "" })).body.error.code).toBe("validation_failed");
    expect((await send({ kind: "nope", message: "Olá" })).body.error.code).toBe("validation_failed");
    expect((await send({ kind: "idea", message: "x".repeat(1001) })).body.error.code).toBe("validation_failed");
    expect((await send({ kind: "idea", message: "Olá", email: "not-an-email" })).body.error.code).toBe("validation_failed");
    expect(await send({ kind: "broken", message: "Não abre" }, { type: "image/png", bytes: Buffer.from("GIF89a fake") })).toMatchObject({
      status: 415, body: { error: { code: "unsupported_file" } },
    });
    expect(await send({ kind: "broken", message: "Não abre" }, { type: "image/png", bytes: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) })).toMatchObject({
      status: 413, body: { error: { code: "file_too_large" } },
    });
    human = false;
    expect(await send({ kind: "idea", message: "Olá" })).toMatchObject({ status: 403, body: { error: { code: "captcha_failed" } } });
    const json = await app.inject({ method: "POST", url: "/api/v2/feedback", payload: { kind: "idea", message: "Olá" } });
    expect(json.json().error.code).toBe("validation_failed");
    expect(await db.select().from(feedbackMessages)).toHaveLength(0);
  });

  it("deletes screenshots after 90 days", async () => {
    await send({ kind: "broken", message: "Não abre" }, { type: "image/png", bytes: PNG });
    await db.execute(sql`update feedback_messages set created_at = now() - interval '91 days'`);
    await purgeFeedback(db);
    const [row] = await db.select().from(feedbackMessages);
    expect([row!.screenshot, row!.screenshotType, row!.message]).toEqual([null, null, "Não abre"]);
  });
});

describe("feedback admin and corrections", () => {
  it("lets moderators read, answer by email and close, deleting the email", async () => {
    const { body } = await send({ kind: "error", message: "Data errada", page: "Agenda", email: "leitor@example.pt" }, { type: "image/png", bytes: PNG });
    const id = body.id;
    expect((await call("GET", "/admin/feedback", await login("ana@example.pt"))).status).toBe(403);
    const cookie = await login();

    const list = await call("GET", "/admin/feedback?status=open", cookie);
    expect(list.body.items).toEqual([expect.objectContaining({ id, email: "leitor@example.pt", screenshot: `/api/v2/admin/feedback/${id}/screenshot` })]);
    const image = await call("GET", `/admin/feedback/${id}/screenshot`, cookie);
    expect([image.status, image.headers["content-type"], (image.body as Buffer).equals(PNG)]).toEqual([200, "image/png", true]);
    expect((await call("GET", `/admin/feedback/${id}/screenshot`)).status).toBe(401);

    const answered = await call("POST", `/admin/feedback/${id}/answer`, cookie, { reply: "Obrigado, já corrigimos.", send: true });
    expect(answered.body).toMatchObject({ status: "answered", reply: "Obrigado, já corrigimos.", answeredAt: expect.any(String) });
    expect(sent).toEqual([expect.objectContaining({ to: "leitor@example.pt", text: expect.stringContaining("Data errada") })]);

    const closed = await call("POST", `/admin/feedback/${id}/close`, cookie);
    expect(closed.body).toMatchObject({ status: "closed", email: null, closedAt: expect.any(String) });
    expect((await call("POST", `/admin/feedback/${id}/answer`, cookie, { reply: "Mais uma coisa", send: true })).body.error.code).toBe("no_email");
  });

  it("turns a message into a public correction, and summarises", async () => {
    const cookie = await login();
    const { body } = await send({ kind: "error", message: "Partido errado", page: "Percursos" });
    const made = await call("POST", `/admin/feedback/${body.id}/correction`, cookie, { status: "fixed", title: "Partido de um deputado corrigido", url: "/percursos" });
    expect(made).toMatchObject({ status: 201, body: { status: "fixed", area: "Percursos", url: "/percursos", date: expect.any(String) } });
    await call("POST", "/admin/corrections", cookie, { status: "checking", date: "2020-01-02", area: "Agenda", title: "Hora de uma reunião", url: null });
    const extra = await call("POST", "/admin/corrections", cookie, { status: "rejected", date: "2020-01-01", area: "Contratos", title: "Valor de um contrato", url: "https://www.base.gov.pt/x" });
    expect((await call("POST", "/admin/corrections", cookie, { status: "fixed", area: "X", title: "Mau link", url: "javascript:alert(1)" })).status).toBe(400);

    const log = await call("GET", "/corrections?limit=2");
    expect(log.body.items.map((c: { title: string }) => c.title)).toEqual(["Partido de um deputado corrigido", "Hora de uma reunião"]);
    expect(log.body.items[0]).toEqual({ id: made.body.id, status: "fixed", date: made.body.date, area: "Percursos", title: "Partido de um deputado corrigido", url: "/percursos" });
    const rest = await call("GET", `/corrections?limit=2&cursor=${log.body.nextCursor}`);
    expect(rest.body).toEqual({ items: [expect.objectContaining({ id: extra.body.id })], nextCursor: null });

    expect((await call("PUT", `/admin/corrections/${extra.body.id}`, cookie, { status: "fixed", area: "Contratos", title: "Valor corrigido", url: null })).body).toMatchObject({ status: "fixed", date: "2020-01-01" });
    expect((await call("GET", `/admin/feedback/${body.id}`, cookie)).body.corrections).toHaveLength(1);

    const summary = await call("GET", "/feedback/summary");
    expect(summary.body).toEqual({
      stats: { responseDays: null, correctionsThisMonth: 1 },
      corrections: expect.arrayContaining([expect.objectContaining({ id: made.body.id })]),
    });
    expect(summary.body.corrections).toHaveLength(3);
    expect((await call("DELETE", `/admin/corrections/${extra.body.id}`, cookie)).status).toBe(204);
  });

  it("gives the median days to a first answer once there are five answers", async () => {
    for (const days of [1, 2, 3, 4, 10]) {
      await db.insert(feedbackMessages).values({
        kind: "other", message: "m", status: "answered",
        createdAt: new Date(Date.now() - 20 * 86_400_000), answeredAt: new Date(Date.now() - (20 - days) * 86_400_000),
      });
    }
    expect((await call("GET", "/feedback/summary")).body.stats.responseDays).toBe(3);
    await db.delete(feedbackMessages).where(eq(feedbackMessages.message, "m"));
  });
});
