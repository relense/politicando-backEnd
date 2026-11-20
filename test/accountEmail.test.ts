import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readResetToken, resetToken, verifyToken } from "../src/accounts/emailTokens.js";
import { buildApp } from "../src/app.js";
import { newsletterSubscribers, users } from "../src/db/schema.js";
import type { Mailer, MailMessage } from "../src/newsletter/mailer.js";
import { createTestDb, resetDb } from "./helpers.js";

const { db, pool } = createTestDb();
const sent: MailMessage[] = [];
const mailer = vi.fn<Mailer>(async (message) => void sent.push(message));
const secret = "test-newsletter-secret-test-newsletter-secret";
const settings = { mailer, secret, siteUrl: "https://politicando.example", apiUrl: "https://api.politicando.example" };
const options = { db, corsOrigins: [], verifyRecaptcha: async () => true, forumSecret: "test-secret", loginLimitPerMinute: 1000, registerLimitPerHour: 1000 };
const app = await buildApp({ ...options, newsletter: settings });
const noMail = await buildApp(options);

beforeEach(async () => {
  await resetDb(db);
  sent.length = 0;
  mailer.mockReset();
  mailer.mockImplementation(async (message) => void sent.push(message));
});
afterAll(async () => {
  await app.close();
  await noMail.close();
  await pool.end();
});

const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, cookie?: string, target = app) => {
  const response = await target.inject({ method, url: `/api/v2${url}`, payload, headers: cookie ? { cookie: `politicando_session=${cookie}` } : {} });
  return { status: response.statusCode, body: response.body ? response.json() : null, headers: response.headers, cookie: response.cookies.find((c) => c.name === "politicando_session")?.value };
};
const register = (payload: object = {}, target = app) =>
  call("POST", "/auth/register", { username: "ana", password: "palavra-passe", recaptchaToken: "t", ...payload }, undefined, target);
const tokenIn = (message: MailMessage, path: string) =>
  decodeURIComponent(new URL(message.text.match(new RegExp(`https://\\S+${path}\\?token=\\S+`))![0]).searchParams.get("token")!);
const subscribers = () => db.select().from(newsletterSubscribers);

describe("an account's email", () => {
  it("is optional: without it the account works, and asks for one", async () => {
    const { status, body, cookie } = await register();
    expect(status).toBe(201);
    expect(body).toEqual({ user: expect.objectContaining({ username: "ana", email: null, emailConfirmed: false, askForEmail: true }) });
    expect(sent).toEqual([]);
    const me = await call("GET", "/me", undefined, cookie);
    expect(me.headers["cache-control"]).toBe("private, no-store");

    // "Agora não": quiet for 30 days, then it asks again.
    expect((await call("POST", "/me/email/remind-later", undefined, cookie)).status).toBe(204);
    expect((await call("GET", "/me", undefined, cookie)).body.askForEmail).toBe(false);
    await db.update(users).set({ emailRemindedAt: new Date(Date.now() - 31 * 86_400_000) });
    expect((await call("GET", "/me", undefined, cookie)).body.askForEmail).toBe(true);
  });

  it("is confirmed by the button on the emailed page, which subscribes the newsletter with it", async () => {
    const { body, cookie } = await register({ email: " Ana@Example.PT ", newsletter: true });
    expect(body).toMatchObject({ user: { email: "ana@example.pt", emailConfirmed: false, askForEmail: true }, emailSent: true, newsletter: "pending" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("https://politicando.example/conta/confirmar-email?token=");
    expect(sent[0]!.text).toContain("newsletter");
    // The wish waits on the account: nothing is written for the address until it's confirmed.
    expect(await subscribers()).toEqual([]);

    // Logged out, on another device: it still works.
    const confirmed = await call("POST", "/auth/email/confirm", { token: tokenIn(sent[0]!, "/conta/confirmar-email") });
    expect(confirmed.body).toEqual({ status: "confirmed", newsletter: true });
    expect((await subscribers())[0]!.confirmedAt).toBeInstanceOf(Date);
    expect((await call("GET", "/me", undefined, cookie)).body).toMatchObject({ emailConfirmed: true, askForEmail: false });
  });

  it("refuses a bad email, or the newsletter without one, before creating anything", async () => {
    expect((await register({ email: "nope" })).body.error.code).toBe("invalid_email");
    expect((await register({ newsletter: true })).body.error.code).toBe("invalid_email");
    expect((await register({ email: "ana@example.pt" }, noMail)).body.error.code).toBe("mail_unavailable");
    expect(await db.select().from(users)).toEqual([]);
  });

  it("keeps the account when the confirmation can't be sent", async () => {
    mailer.mockRejectedValueOnce(new Error("SMTP down"));
    const { status, body } = await register({ email: "ana@example.pt" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ user: { email: "ana@example.pt", emailConfirmed: false }, emailSent: false });
  });

  it("can be added or changed later, and a link for the old address stops working", async () => {
    const { cookie } = await register();
    expect((await call("PUT", "/me/email", { email: "ana@example.pt" })).status).toBe(401);
    const added = await call("PUT", "/me/email", { email: "ana@example.pt" }, cookie);
    expect(added.body).toMatchObject({ user: { email: "ana@example.pt", emailConfirmed: false }, emailSent: true });
    const first = tokenIn(sent[0]!, "/conta/confirmar-email");
    await call("PUT", "/me/email", { email: "outro@example.pt" }, cookie);
    expect((await call("POST", "/auth/email/confirm", { token: first })).body.error.code).toBe("invalid_token");
    expect((await call("POST", "/auth/email/confirm", { token: tokenIn(sent[1]!, "/conta/confirmar-email") })).status).toBe(200);
    // The same confirmed address again: nothing to do.
    expect((await call("PUT", "/me/email", { email: "outro@example.pt" }, cookie)).body).toMatchObject({ emailSent: false, user: { emailConfirmed: true } });
    expect((await call("DELETE", "/me/email", undefined, cookie)).status).toBe(204);
    expect((await call("GET", "/me", undefined, cookie)).body).toMatchObject({ email: null, emailConfirmed: false });
  });

  it("belongs to one account once confirmed; typing it elsewhere can't block or take it", async () => {
    const ana = await register({ email: "ana@example.pt" });
    const rui = await call("POST", "/auth/register", { username: "rui", password: "palavra-passe", recaptchaToken: "t", email: "ana@example.pt" });
    expect(rui.status).toBe(201);
    expect((await call("POST", "/auth/email/confirm", { token: tokenIn(sent[0]!, "/conta/confirmar-email") })).status).toBe(200);
    expect((await call("POST", "/auth/email/confirm", { token: tokenIn(sent[1]!, "/conta/confirmar-email") })).body.error.code).toBe("email_taken");
    expect(ana.status).toBe(201);
  });

  it("refuses forged and expired confirmation tokens", async () => {
    const { body } = await register({ email: "ana@example.pt" });
    expect((await call("POST", "/auth/email/confirm", { token: "abc.def" })).status).toBe(400);
    const old = verifyToken(secret, body.user.id, "ana@example.pt", Date.now() - 8 * 86_400_000);
    expect((await call("POST", "/auth/email/confirm", { token: old })).body.error.code).toBe("invalid_token");
    const reset = resetToken(secret, body.user.id, "hash");
    expect((await call("POST", "/auth/email/confirm", { token: reset })).body.error.code).toBe("invalid_token");
  });
});

describe("the newsletter switch", () => {
  it("needs an email, subscribes a confirmed one at once, and turns off", async () => {
    const { cookie, body } = await register();
    expect(body.user.newsletter).toBe("none");
    expect((await call("PUT", "/me/newsletter", undefined, cookie)).body.error.code).toBe("no_email");

    await call("PUT", "/me/email", { email: "ana@example.pt" }, cookie);
    await call("POST", "/auth/email/confirm", { token: tokenIn(sent[0]!, "/conta/confirmar-email") });
    expect((await call("PUT", "/me/newsletter", undefined, cookie)).body).toEqual({ newsletter: "confirmed", emailSent: false });
    expect((await call("GET", "/me", undefined, cookie)).body.newsletter).toBe("confirmed");

    expect((await call("DELETE", "/me/newsletter", undefined, cookie)).status).toBe(204);
    expect((await call("GET", "/me", undefined, cookie)).body.newsletter).toBe("none");
    expect(await subscribers()).toEqual([]);
  });

  it("with an unconfirmed email is pending, and confirming the email confirms it", async () => {
    const { cookie } = await register({ email: "ana@example.pt" });
    sent.length = 0;
    expect((await call("PUT", "/me/newsletter", undefined, cookie)).body).toEqual({ newsletter: "pending", emailSent: true });
    expect(sent[0]!.text).toContain("newsletter");
    // Until the email is confirmed, "pending" is the account's own wish, not the address's state.
    expect((await call("GET", "/me", undefined, cookie)).body).toMatchObject({ emailConfirmed: false, newsletter: "pending" });
    await call("POST", "/auth/email/confirm", { token: tokenIn(sent[0]!, "/conta/confirmar-email") });
    expect((await call("GET", "/me", undefined, cookie)).body.newsletter).toBe("confirmed");
  });

  it("never tells or changes the newsletter of an address the account hasn't confirmed", async () => {
    await db.insert(newsletterSubscribers).values({ email: "vitima@example.pt", confirmedAt: new Date() });
    const { cookie, body } = await register({ email: "vitima@example.pt" });
    expect(body.user).toMatchObject({ emailConfirmed: false, newsletter: "none" });
    expect((await call("GET", "/me", undefined, cookie)).body.newsletter).toBe("none");
    // Asking for it shows the account's own wish ("pending"), never that the address is subscribed.
    expect((await call("PUT", "/me/email", { email: "vitima@example.pt", newsletter: true }, cookie)).body.user.newsletter).toBe("pending");
    // The switch answers the same as for any unconfirmed address, and resends the confirmation.
    sent.length = 0;
    expect((await call("PUT", "/me/newsletter", undefined, cookie)).body).toEqual({ newsletter: "pending", emailSent: true });
    expect(sent).toHaveLength(1);
    // Switching it off can't unsubscribe someone else's address.
    expect((await call("DELETE", "/me/newsletter", undefined, cookie)).status).toBe(204);
    expect(await subscribers()).toEqual([expect.objectContaining({ email: "vitima@example.pt", confirmedAt: expect.any(Date) })]);
  });
});

describe("the newsletter switch, before the email is confirmed", () => {
  it("switched on then off, confirming the email later doesn't subscribe it", async () => {
    const { cookie } = await register({ email: "rita@example.pt" });
    sent.length = 0;
    expect((await call("PUT", "/me/newsletter", undefined, cookie)).body).toEqual({ newsletter: "pending", emailSent: true });
    const link = tokenIn(sent[0]!, "/conta/confirmar-email");
    // Asked again straight away: no second email.
    expect((await call("PUT", "/me/newsletter", undefined, cookie)).body).toEqual({ newsletter: "pending", emailSent: false });
    expect(sent).toHaveLength(1);
    expect((await call("DELETE", "/me/newsletter", undefined, cookie)).status).toBe(204);
    expect(await subscribers()).toEqual([]);
    expect((await call("POST", "/auth/email/confirm", { token: link })).body).toEqual({ status: "confirmed", newsletter: false });
    expect(await subscribers()).toEqual([]);
  });

  // A fresh app: PUT /me/email's hourly limit counts per account id, and ids restart in each test.
  const freshApp = () => buildApp({ ...options, newsletter: settings });

  it("the profile's 'resend' (no newsletter field) still confirms the newsletter chosen at sign-up", async () => {
    const fresh = await freshApp();
    try {
      const { cookie } = await register({ email: "eva@example.pt", newsletter: true }, fresh);
      sent.length = 0;
      expect((await call("PUT", "/me/email", { email: "eva@example.pt" }, cookie, fresh)).status).toBe(200);
      const resent = tokenIn(sent[0]!, "/conta/confirmar-email");
      expect((await call("POST", "/auth/email/confirm", { token: resent }, undefined, fresh)).body).toEqual({ status: "confirmed", newsletter: true });
    } finally {
      await fresh.close();
    }
  });

  it("keeps the reader's choice on the account: other sign-ups for the address can't change it", async () => {
    const { cookie } = await register({ email: "rita@example.pt", newsletter: true });
    const link = tokenIn(sent[0]!, "/conta/confirmar-email");
    // Nothing written for the address yet, so another account can't drop or delay the owner's own sign-up.
    expect(await subscribers()).toEqual([]);
    await call("DELETE", "/me/newsletter", undefined, cookie);
    expect((await call("GET", "/me", undefined, cookie)).body.newsletter).toBe("none");
    // Someone else's pending sign-up for the address appears: the reader said no, so confirming leaves it pending.
    await db.insert(newsletterSubscribers).values({ email: "rita@example.pt" });
    expect((await call("POST", "/auth/email/confirm", { token: link })).body).toEqual({ status: "confirmed", newsletter: false });
    expect(await subscribers()).toEqual([expect.objectContaining({ email: "rita@example.pt", confirmedAt: null })]);
  });

  it("switched off and on again within minutes, the link already sent still subscribes", async () => {
    const { cookie } = await register({ email: "ivo@example.pt" });
    sent.length = 0;
    await call("PUT", "/me/newsletter", undefined, cookie);
    const link = tokenIn(sent[0]!, "/conta/confirmar-email");
    await call("DELETE", "/me/newsletter", undefined, cookie);
    expect((await call("PUT", "/me/newsletter", undefined, cookie)).body).toEqual({ newsletter: "pending", emailSent: false });
    expect((await call("POST", "/auth/email/confirm", { token: link })).body).toEqual({ status: "confirmed", newsletter: true });
  });

  it("a new address gets its own confirmation straight away, even just after one for the old address", async () => {
    const fresh = await freshApp();
    try {
      const { cookie } = await register({ email: "old@example.pt" }, fresh);
      await call("PUT", "/me/newsletter", undefined, cookie, fresh);
      expect((await call("PUT", "/me/email", { email: "new@example.pt", newsletter: false }, cookie, fresh)).status).toBe(200);
      sent.length = 0;
      expect((await call("PUT", "/me/newsletter", undefined, cookie, fresh)).body).toEqual({ newsletter: "pending", emailSent: true });
      const link = tokenIn(sent[0]!, "/conta/confirmar-email");
      expect((await call("POST", "/auth/email/confirm", { token: link }, undefined, fresh)).body).toEqual({ status: "confirmed", newsletter: true });
    } finally {
      await fresh.close();
    }
  });

  it("confirming an email sent without the newsletter doesn't subscribe it, nor cancel a sign-up left pending", async () => {
    await db.insert(newsletterSubscribers).values({ email: "rui@example.pt" });
    const { body } = await register({ email: "rui@example.pt" });
    expect(body.user.emailConfirmed).toBe(false);
    const link = tokenIn(sent.at(-1)!, "/conta/confirmar-email");
    expect((await call("POST", "/auth/email/confirm", { token: link })).body).toEqual({ status: "confirmed", newsletter: false });
    // The account's choice decides, not the link: the other sign-up for the address is left alone.
    expect(await subscribers()).toEqual([expect.objectContaining({ email: "rui@example.pt", confirmedAt: null })]);
  });
});

describe("forgot password", () => {
  const confirmedAccount = async () => {
    const { cookie } = await register({ email: "ana@example.pt" });
    await call("POST", "/auth/email/confirm", { token: tokenIn(sent[0]!, "/conta/confirmar-email") });
    sent.length = 0;
    return cookie!;
  };

  it("emails a one-time link that sets a new password, logs out elsewhere and logs in", async () => {
    const old = await confirmedAccount();
    const asked = await call("POST", "/auth/password/forgot", { email: "ANA@example.pt", recaptchaToken: "t" });
    expect(asked).toMatchObject({ status: 202, body: { status: "sent" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("«ana»");
    const token = tokenIn(sent[0]!, "/conta/nova-palavra-passe");

    const reset = await call("POST", "/auth/password/reset", { token, password: "nova-palavra" });
    expect(reset.status).toBe(200);
    expect(reset.cookie).toBeTruthy();
    expect((await call("GET", "/me", undefined, old)).status).toBe(401);
    expect((await call("POST", "/auth/password/reset", { token, password: "outra-vez-1" })).body.error.code).toBe("invalid_token");
    expect((await call("POST", "/auth/login", { username: "ana", password: "nova-palavra", recaptchaToken: "t" })).status).toBe(200);
  });

  it("answers the same for unknown or unconfirmed addresses, and sends nothing", async () => {
    await register({ email: "ana@example.pt" });
    sent.length = 0;
    for (const email of ["ninguem@example.pt", "ana@example.pt"]) {
      expect((await call("POST", "/auth/password/forgot", { email, recaptchaToken: "t" })).body).toEqual({ status: "sent" });
    }
    expect(sent).toEqual([]);
  });

  it("sends at most one email every 10 minutes per account", async () => {
    await confirmedAccount();
    await call("POST", "/auth/password/forgot", { email: "ana@example.pt", recaptchaToken: "t" });
    await call("POST", "/auth/password/forgot", { email: "ana@example.pt", recaptchaToken: "t" });
    expect(sent).toHaveLength(1);
  });

  it("refuses expired and forged reset links", async () => {
    await confirmedAccount();
    const [user] = await db.select().from(users).where(eq(users.username, "ana"));
    const expired = resetToken(secret, user!.id, user!.passwordHash, Date.now() - 2 * 3_600_000);
    expect(readResetToken(secret, expired)).toBeNull();
    expect((await call("POST", "/auth/password/reset", { token: expired, password: "nova-palavra" })).status).toBe(400);
    expect((await call("POST", "/auth/password/reset", { token: "x.y", password: "nova-palavra" })).status).toBe(400);
  });
});
