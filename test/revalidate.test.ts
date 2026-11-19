import { describe, expect, it, vi } from "vitest";
import { createRevalidator } from "../src/revalidate.js";

const SECRET = "s".repeat(32);
const env = { FRONTEND_REVALIDATE_URL: "https://site.example/api/revalidate", REVALIDATE_SECRET: SECRET };

describe("telling the site to refresh", () => {
  it("posts the changed areas once each, with the secret", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    await createRevalidator(env, { fetchFn })(["news", "podcast", "news"]);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(env.FRONTEND_REVALIDATE_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init?.body))).toEqual({ tags: ["news", "podcast"] });
  });

  it("does nothing unconfigured", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await createRevalidator({}, { fetchFn })(["news"]);
    await createRevalidator({ FRONTEND_REVALIDATE_URL: env.FRONTEND_REVALIDATE_URL, REVALIDATE_SECRET: "" }, { fetchFn })(["news"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never throws when the site is down or refuses", async () => {
    const log = vi.fn();
    await createRevalidator(env, { fetchFn: async () => Promise.reject(new Error("ECONNREFUSED")), log })(["blog"]);
    await createRevalidator(env, { fetchFn: async () => new Response(null, { status: 401 }), log })(["blog"]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]![0]).toContain("401");
  });

  it("refuses a short secret, so a misconfiguration shows at start", () => {
    expect(() => createRevalidator({ ...env, REVALIDATE_SECRET: "short" })).toThrow();
  });
});
