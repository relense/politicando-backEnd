import { describe, expect, it } from "vitest";
import { cacheKey, createVersionedCache } from "../src/modules/contracts/cache.js";

describe("versioned cache", () => {
  const setup = (checkEveryMs = 60_000) => {
    let version = "v1";
    let clock = 0;
    let computed = 0;
    const cache = createVersionedCache<number>({ version: async () => version, checkEveryMs, now: () => clock, max: 2 });
    const compute = async () => ++computed;
    return {
      cache,
      compute,
      setVersion: (v: string) => (version = v),
      tick: (ms: number) => (clock += ms),
      computed: () => computed,
    };
  };

  it("answers from memory until the version changes, checking it at most once a minute", async () => {
    const t = setup();
    expect(await t.cache.get("a", t.compute)).toBe(1);
    expect(await t.cache.get("a", t.compute)).toBe(1);
    t.setVersion("v2");
    expect(await t.cache.get("a", t.compute)).toBe(1);
    t.tick(60_000);
    expect(await t.cache.get("a", t.compute)).toBe(2);
  });

  it("shares one computation between identical requests", async () => {
    const t = setup();
    const answers = await Promise.all([t.cache.get("a", t.compute), t.cache.get("a", t.compute), t.cache.get("b", t.compute)]);
    expect(answers.sort()).toEqual([1, 1, 2]);
    expect(t.computed()).toBe(2);
  });

  it("drops the least recently used past its size, and doesn't keep failures", async () => {
    const t = setup();
    await t.cache.get("a", t.compute);
    await t.cache.get("b", t.compute);
    await t.cache.get("a", t.compute);
    await t.cache.get("c", t.compute);
    expect(t.cache.size()).toBe(2);
    expect(await t.cache.get("a", t.compute)).toBe(1);
    expect(await t.cache.get("b", t.compute)).toBe(4);
    await expect(t.cache.get("x", async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    expect(await t.cache.get("x", t.compute)).toBe(5);
  });

  it("reports when the version changed", async () => {
    const t = setup();
    expect(await t.cache.refresh(true)).toBe(false);
    t.setVersion("v2");
    expect(await t.cache.refresh(true)).toBe(true);
  });

  it("builds the same key whatever the order", () => {
    expect(cacheKey("stats", { by: "year", place: undefined, limit: 8 })).toBe(cacheKey("stats", { limit: 8, by: "year" }));
  });
});
