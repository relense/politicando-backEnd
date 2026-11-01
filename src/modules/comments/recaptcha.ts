import { z } from "zod";

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

export type RecaptchaVerifier = (token: string, remoteIp: string) => Promise<boolean>;

const responseSchema = z.object({ success: z.boolean() });

/** Throws if Google can't be reached, so comments fail closed. */
export const createRecaptchaVerifier =
  (secret: string, fetchImpl: typeof fetch = fetch): RecaptchaVerifier =>
  async (token, remoteIp) => {
    const response = await fetchImpl(VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`reCAPTCHA responded with HTTP ${response.status}`);
    return responseSchema.parse(await response.json()).success;
  };
