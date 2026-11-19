import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { newsletterSubscribers } from "../db/schema.js";
import type { Mailer } from "./mailer.js";
import { CONFIRM_TTL_DAYS, createToken } from "./tokens.js";

export interface NewsletterSettings {
  mailer: Mailer;
  /** Signs the confirmation and unsubscribe links. Changing it breaks every link already sent. */
  secret: string;
  /** The website: the links in the emails open its pages, where a button does the rest. */
  siteUrl: string;
  /** This API's public address, for mail clients' own one-click unsubscribe (List-Unsubscribe). */
  apiUrl: string;
}

/** Ask again for a pending address at most this often, so the form can't be used to flood an inbox. */
const RESEND_AFTER_MINUTES = 10;

/** The address as stored, or null when it isn't one. */
export const normalEmail = (value: string) => {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && z.email().safeParse(email).success ? email : null;
};

/*
 * The links open pages on the website that ask for a button press: mail security scanners open
 * every link in an email, and a link that acted on its own would confirm (or unsubscribe) people
 * who never clicked. Mail clients' own unsubscribe button (List-Unsubscribe-Post, RFC 8058) is
 * made for one click and posts to the API directly.
 */
export const confirmPage = (settings: NewsletterSettings, token: string) =>
  `${settings.siteUrl.replace(/\/$/, "")}/newsletter/confirmar?token=${encodeURIComponent(token)}`;
export const unsubscribePage = (settings: NewsletterSettings, token: string) =>
  `${settings.siteUrl.replace(/\/$/, "")}/newsletter/cancelar?token=${encodeURIComponent(token)}`;
export const oneClickUnsubscribe = (settings: NewsletterSettings, token: string) =>
  `${settings.apiUrl.replace(/\/$/, "")}/api/v2/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;

export class MailUnavailable extends Error {}

/**
 * Signs an address up, pending until confirmed, and emails the confirmation. New or pending and
 * not asked recently: (re)sent. Confirmed or just asked: nothing is sent, and the caller answers
 * the same either way, so it never reveals whether an address is subscribed. Throws
 * MailUnavailable (keeping nothing) when the email can't be sent.
 */
export const requestSubscription = async (db: Db, settings: NewsletterSettings, email: string) => {
  // Forget addresses that never confirmed.
  await db
    .delete(newsletterSubscribers)
    .where(and(isNull(newsletterSubscribers.confirmedAt), lt(newsletterSubscribers.createdAt, sql`now() - make_interval(days => ${CONFIRM_TTL_DAYS})`)));

  const [toAsk] = await db
    .insert(newsletterSubscribers)
    .values({ email })
    .onConflictDoUpdate({
      target: newsletterSubscribers.email,
      set: { createdAt: sql`now()` },
      setWhere: sql`${newsletterSubscribers.confirmedAt} is null and ${newsletterSubscribers.createdAt} < now() - make_interval(mins => ${RESEND_AFTER_MINUTES})`,
    })
    .returning({ email: newsletterSubscribers.email });
  if (!toAsk) return;

  const unsubscribeToken = createToken(settings.secret, "unsubscribe", email);
  try {
    await settings.mailer({
      to: email,
      subject: "Confirma a tua inscrição na newsletter do Politicando",
      text: [
        "Olá,",
        "",
        "Recebemos um pedido para inscrever este endereço na newsletter do Politicando.",
        "Para confirmar, abre esta ligação e carrega em «Confirmar»:",
        "",
        confirmPage(settings, createToken(settings.secret, "confirm", email)),
        "",
        `A ligação é válida durante ${CONFIRM_TTL_DAYS} dias. Se não foste tu, ignora este email: sem confirmação, o endereço é apagado.`,
        "",
        `Para não receberes mais nada: ${unsubscribePage(settings, unsubscribeToken)}`,
      ].join("\n"),
      headers: { "List-Unsubscribe": `<${oneClickUnsubscribe(settings, unsubscribeToken)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
  } catch (error) {
    await db.delete(newsletterSubscribers).where(and(eq(newsletterSubscribers.email, email), isNull(newsletterSubscribers.confirmedAt)));
    throw new MailUnavailable(error instanceof Error ? error.message : String(error));
  }
};
