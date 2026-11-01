import { describe, expect, it, vi } from "vitest";
import { createEventRegistrySource, NEWS_SOURCES } from "../src/ingestion/eventRegistry.js";

// Hand-written from the fields the old Rails task read. Replace it with a real
// recorded response once there is an API key to record one with.
const validResult = {
  uri: "8123456789",
  title: "Título",
  body: "Corpo do artigo.",
  url: "https://publico.pt/artigo",
  dateTime: "2026-10-01T10:00:00Z",
  source: { uri: "publico.pt" },
  image: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const request = { dateStart: "2026-10-01", dateEnd: "2026-10-02", page: 2 };

const sourceWith = (fetch: typeof globalThis.fetch) =>
  createEventRegistrySource({ apiKey: "secret-key", fetch, retryDelayMs: 0 });

describe("Event Registry source", () => {
  it("sends the expected query and normalises results", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ articles: { results: [validResult], pages: 4 } }),
    );
    const page = await sourceWith(fetch).fetchPage(request);

    expect(page.totalPages).toBe(4);
    expect(page.malformed).toBe(0);
    expect(page.articles).toEqual([
      {
        sourceUri: "8123456789",
        title: "Título",
        content: "Corpo do artigo.",
        url: "https://publico.pt/artigo",
        source: "publico.pt",
        imageUrl: null,
        publishedAt: new Date("2026-10-01T10:00:00Z"),
      },
    ]);

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.articlesPage).toBe(2);
    expect(body.query.$query.$and[0].$or).toHaveLength(NEWS_SOURCES.length);
    expect(body.query.$query.$and[1]).toEqual({
      dateStart: "2026-10-01",
      dateEnd: "2026-10-02",
      lang: "por",
    });
  });

  it("counts invalid results instead of failing the page", async () => {
    const page = await sourceWith(async () =>
      json({
        articles: { results: [validResult, { ...validResult, title: null }, "junk"], pages: 1 },
      }),
    ).fetchPage(request);
    expect(page.articles).toHaveLength(1);
    expect(page.malformed).toBe(2);
  });

  it("retries a server error and then succeeds", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(json({ articles: { results: [], pages: 0 } }));
    await expect(sourceWith(fetch).fetchPage(request)).resolves.toMatchObject({ totalPages: 0 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after three attempts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({}, 500));
    await expect(sourceWith(fetch).fetchPage(request)).rejects.toThrow("HTTP 500");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry an auth error or put the key in the message", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({}, 401));
    const error = await sourceWith(fetch).fetchPage(request).catch((e: Error) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(error)).toContain("HTTP 401");
    expect(String(error)).not.toContain("secret-key");
  });

  it("rejects the error bodies the API returns with HTTP 200", async () => {
    await expect(
      sourceWith(async () => json({ error: "Invalid key" })).fetchPage(request),
    ).rejects.toThrow("unexpected response format");
  });
});
