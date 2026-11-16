import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { newsletterSubscribers } from "../src/db/schema.js";
import type { RecaptchaVerifier } from "../src/modules/comments/recaptcha.js";
import type { Mailer, MailMessage } from "../src/newsletter/mailer.js";
import { createToken, readToken } from "../src/newsletter/tokens.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const verifyRecaptcha = vi.fn<RecaptchaVerifier>();
const sent: MailMessage[] = [];
const mailer = vi.fn<Mailer>(async (message) => void sent.push(message));
const secret = "test-newsletter-secret-test-newsletter-secret";
const settings = { mailer, secret, siteUrl: "https://politicando.example/", apiUrl: "https://api.politicando.example" };

const app = await buildApp({ db, corsOrigins: [], verifyRecaptcha, commentLimitPerMinute: 1_000, newsletter: settings });
const off = await buildApp({ db, corsOrigins: [], verifyRecaptcha, commentLimitPerMinute: 1_000 });

beforeEach(async () => {
  await resetDb(db);
  sent.length = 0;
  mailer.mockClear();
  verifyRecaptcha.mockReset();
  verifyRecaptcha.mockResolvedValue(true);
});
afterAll(async () => {
  await app.close();
  await off.close();
  await pool.end();
});

const subscribe = async (email: string, target = app) => {
  const response = await target.inject({ method: "POST", url: "/api/v2/newsletter/subscribe", payload: { email, recaptchaToken: "t" } });
  return { status: response.statusCode, body: response.json() };
};
const visit = async (url: string) => {
  const response = await app.inject({ method: "GET", url: url.replace("https://api.politicando.example", "") });
  return { status: response.statusCode, location: response.headers.location };
};
const linkIn = (message: MailMessage, path: string) => message.text.match(new RegExp(`https://\\S+/newsletter/${path}\\?token=\\S+`))![0];
const rows = () => db.select().from(newsletterSubscribers);

describe("newsletter tokens", () => {
  it("only accept their own purpose, unforged and unexpired", () => {
    const token = createToken(secret, "confirm", "a@b.pt", Date.UTC(2026, 0, 1));
    expect(readToken(secret, "confirm", token, Date.UTC(2026, 0, 7))).toBe("a@b.pt");
    expect(readToken(secret, "confirm", token, Date.UTC(2026, 0, 9))).toBeNull();
    expect(readToken(secret, "unsubscribe", token, Date.UTC(2026, 0, 2))).toBeNull();
    expect(readToken("another-secret-another-secret-another", "confirm", token, Date.UTC(2026, 0, 2))).toBeNull();
    const unsubscribe = createToken(secret, "unsubscribe", "a@b.pt");
    expect(readToken(secret, "unsubscribe", unsubscribe, Date.UTC(2040, 0, 1))).toBe("a@b.pt");
    expect(readToken(secret, "unsubscribe", "garbage")).toBeNull();
  });
});

describe("POST /newsletter/subscribe", () => {
  it("stores the address unconfirmed and emails a confirmation link, then confirms it", async () => {
    expect(await subscribe("  Ana@Example.PT ")).toEqual({ status: 202, body: { status: "pending" } });
    expect(await rows()).toEqual([{ email: "ana@example.pt", createdAt: expect.any(Date), confirmedAt: null }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ana@example.pt");
    expect(sent[0]!.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/api\.politicando\.example\/api\/v2\/newsletter\/unsubscribe\?token=/);

    expect(await visit(linkIn(sent[0]!, "confirm"))).toEqual({ status: 302, location: "https://politicando.example/newsletter?estado=confirmado" });
    expect((await rows())[0]!.confirmedAt).toBeInstanceOf(Date);
    // Already subscribed: the same answer, and no email.
    expect((await subscribe("ana@example.pt")).status).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it("doesn't resend to a pending address within 10 minutes", async () => {
    await subscribe("ana@example.pt");
    await subscribe("ana@example.pt");
    expect(sent).toHaveLength(1);
    await db.update(newsletterSubscribers).set({ createdAt: new Date(Date.now() - 11 * 60_000) });
    await subscribe("ana@example.pt");
    expect(sent).toHaveLength(2);
  });

  it("forgets addresses that never confirmed after a week", async () => {
    await subscribe("old@example.pt");
    await db.update(newsletterSubscribers).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
    await subscribe("new@example.pt");
    expect((await rows()).map((r) => r.email)).toEqual(["new@example.pt"]);
  });

  it.each(["nope", "a@", "@b.pt", `${"a".repeat(250)}@b.pt`])("rejects %s as invalid_email", async (email) => {
    const { status, body } = await subscribe(email);
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_email");
  });

  it("checks reCAPTCHA", async () => {
    verifyRecaptcha.mockResolvedValue(false);
    expect((await subscribe("ana@example.pt")).body.error.code).toBe("recaptcha_failed");
    expect(await rows()).toEqual([]);
  });

  it("answers 503 and keeps nothing when the email can't be sent", async () => {
    mailer.mockRejectedValueOnce(new Error("SMTP down"));
    const { status, body } = await subscribe("ana@example.pt");
    expect(status).toBe(503);
    expect(body.error.code).toBe("mail_unavailable");
    expect(await rows()).toEqual([]);
  });

  it("answers 503 when no mail is configured", async () => {
    expect((await subscribe("ana@example.pt", off)).body.error.code).toBe("newsletter_unavailable");
  });

  it("rate-limits sign-ups", async () => {
    const limited = await buildApp({ db, corsOrigins: [], verifyRecaptcha, commentLimitPerMinute: 1, newsletter: settings });
    const post = () => limited.inject({ method: "POST", url: "/api/v2/newsletter/subscribe", payload: { email: "a@b.pt", recaptchaToken: "t" } });
    expect((await post()).statusCode).toBe(202);
    const second = await post();
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("rate_limited");
    await limited.close();
  });
});

describe("confirm and unsubscribe links", () => {
  it("unsubscribing deletes the address; the old confirmation link then lands on invalido", async () => {
    await subscribe("ana@example.pt");
    const confirm = linkIn(sent[0]!, "confirm");
    expect(await visit(linkIn(sent[0]!, "unsubscribe"))).toEqual({ status: 302, location: "https://politicando.example/newsletter?estado=cancelado" });
    expect(await rows()).toEqual([]);
    expect((await visit(confirm)).location).toBe("https://politicando.example/newsletter?estado=invalido");
  });

  it("lands forged links on invalido", async () => {
    expect((await visit("/api/v2/newsletter/confirm?token=abc.def")).location).toBe("https://politicando.example/newsletter?estado=invalido");
    expect((await visit("/api/v2/newsletter/unsubscribe?token=abc")).location).toBe("https://politicando.example/newsletter?estado=invalido");
  });

  it("supports one-click unsubscribe from mail clients", async () => {
    await subscribe("ana@example.pt");
    await db.update(newsletterSubscribers).set({ confirmedAt: new Date() }).where(eq(newsletterSubscribers.email, "ana@example.pt"));
    const url = linkIn(sent[0]!, "unsubscribe").replace("https://api.politicando.example", "");
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    expect(response.statusCode).toBe(204);
    expect(await rows()).toEqual([]);
  });
});
