import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

export type Mailer = (message: MailMessage) => Promise<void>;

/**
 * SMTP_URL picks how mail goes out:
 *   ""          no mail: the newsletter answers 503
 *   "log"       printed to the console, links included (local development only)
 *   smtp(s)://  any SMTP provider, e.g. smtps://user:password@smtp.example.com:465
 */
export const createMailer = (smtpUrl: string, from: string, log: (text: string) => void = console.log): Mailer | null => {
  if (smtpUrl === "") return null;
  if (smtpUrl === "log") {
    return async (message) => log(`[mail] to ${message.to}: ${message.subject}\n${message.text}`);
  }
  const transport = nodemailer.createTransport(smtpUrl);
  return async (message) => {
    await transport.sendMail({ from, ...message });
  };
};
