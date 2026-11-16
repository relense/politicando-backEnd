import { z } from "zod";

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

export type RecaptchaVerifier = (token: string, remoteIp: string) => Promise<boolean>;

const responseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  "error-codes": z.array(z.string()).optional(),
});

/**
 * Throws if Google can't be reached, so comments fail closed. With `hostnames`, tokens
 * solved on any other site are rejected (a token farmed elsewhere can't be replayed here).
 * Each rejection is passed to `warn` with Google's reason, so a misconfigured key or
 * hostname list shows up in the logs instead of as a silent 403.
 */
export const createRecaptchaVerifier =
  (
    secret: string,
    fetchImpl: typeof fetch = fetch,
    hostnames: string[] = [],
    warn: (message: string) => void = () => {},
  ): RecaptchaVerifier =>
  async (token, remoteIp) => {
    const response = await fetchImpl(VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`reCAPTCHA responded with HTTP ${response.status}`);
    const result = responseSchema.parse(await response.json());
    if (!result.success) {
      warn(`reCAPTCHA rejected by Google: ${(result["error-codes"] ?? ["no reason given"]).join(", ")}`);
      return false;
    }
    if (hostnames.length === 0 || (result.hostname !== undefined && hostnames.includes(result.hostname.toLowerCase()))) return true;
    warn(`reCAPTCHA solved on "${result.hostname ?? "unknown"}", which isn't in RECAPTCHA_HOSTNAMES (${hostnames.join(",")})`);
    return false;
  };
