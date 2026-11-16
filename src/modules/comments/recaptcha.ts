import { z } from "zod";

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

export type RecaptchaVerifier = (token: string, remoteIp: string) => Promise<boolean>;

const responseSchema = z.object({ success: z.boolean(), hostname: z.string().optional() });

/**
 * Throws if Google can't be reached, so comments fail closed. With `hostnames`, tokens
 * solved on any other site are rejected (a token farmed elsewhere can't be replayed here).
 */
export const createRecaptchaVerifier =
  (secret: string, fetchImpl: typeof fetch = fetch, hostnames: string[] = []): RecaptchaVerifier =>
  async (token, remoteIp) => {
    const response = await fetchImpl(VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`reCAPTCHA responded with HTTP ${response.status}`);
    const result = responseSchema.parse(await response.json());
    if (!result.success) return false;
    return hostnames.length === 0 || (result.hostname !== undefined && hostnames.includes(result.hostname.toLowerCase()));
  };
