import { z } from "zod";

/*
 * Tells the website that something changed, so it drops its cached copy at once instead of
 * serving an old one until its own timer runs out. Each job pings after it writes; the publish
 * API pings when a post goes live or comes off. Best effort: an unreachable site is logged and
 * never fails the job or the request. Unconfigured (local, tests): does nothing.
 *
 *   POST <FRONTEND_REVALIDATE_URL>
 *   Authorization: Bearer <REVALIDATE_SECRET>
 *   { "tags": ["news", "podcast"] }
 */

/** What the site can refresh on its own. Keep in step with docs/revalidate.md. */
export const SITE_TAGS = ["news", "podcast", "agenda", "blog", "parliament", "government", "predictions", "budget"] as const;
export type SiteTag = (typeof SITE_TAGS)[number];
export type Revalidate = (tags: readonly SiteTag[]) => Promise<void>;

const schema = z.object({
  FRONTEND_REVALIDATE_URL: z.url().optional(),
  REVALIDATE_SECRET: z.string().min(32).optional(),
});

export const createRevalidator = (
  env: NodeJS.ProcessEnv = process.env,
  { fetchFn = fetch, log = (message: string) => console.warn(message) }: { fetchFn?: typeof fetch; log?: (message: string) => void } = {},
): Revalidate => {
  const { FRONTEND_REVALIDATE_URL: url, REVALIDATE_SECRET: secret } = schema.parse({
    FRONTEND_REVALIDATE_URL: env.FRONTEND_REVALIDATE_URL || undefined,
    REVALIDATE_SECRET: env.REVALIDATE_SECRET || undefined,
  });
  if (!url || !secret) return async () => {};
  return async (tags) => {
    const unique = [...new Set(tags)];
    if (unique.length === 0) return;
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tags: unique }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) log(`Site refresh (${unique.join(", ")}): the site answered ${response.status}`);
    } catch (error) {
      log(`Site refresh (${unique.join(", ")}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
};
