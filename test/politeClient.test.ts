import { describe, expect, it, vi } from "vitest";
import { createPoliteClient, decodeBody, USER_AGENT } from "../src/ingestion/politeClient.js";

type Routes = Record<string, [number, string] | Error>;

const fakeFetch = (routes: Routes) =>
  vi.fn<typeof globalThis.fetch>(async (input) => {
    const route = routes[String(input)];
    if (route instanceof Error) throw route;
    if (!route) return new Response("", { status: 404 });
    return new Response(route[1], { status: route[0] });
  });

const ROBOTS = "https://a.pt/robots.txt";
const clientWith = (fetch: typeof globalThis.fetch, sleep = vi.fn(async () => undefined)) => ({
  client: createPoliteClient({ fetch, sleep, defaultDelayMs: 2_000 }),
  sleep,
});

describe("politeClient", () => {
  it("identifies itself honestly", async () => {
    const fetch = fakeFetch({ "https://a.pt/x": [200, "ok"] });
    await clientWith(fetch).client.get("https://a.pt/x");
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(USER_AGENT);
    expect(headers["user-agent"]).toContain("PoliticandoBot");
  });

  it("doesn't request a path that robots.txt disallows", async () => {
    const fetch = fakeFetch({ [ROBOTS]: [200, "User-agent: *\nDisallow: /privado/"], "https://a.pt/privado/x": [200, "no"] });
    const result = await clientWith(fetch).client.get("https://a.pt/privado/x");
    expect(result).toEqual({ status: "blocked", reason: "robots.txt" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([ROBOTS]);
  });

  it("obeys a rule aimed at the bot by name", async () => {
    const fetch = fakeFetch({ [ROBOTS]: [200, "User-agent: PoliticandoBot\nDisallow: /"] });
    expect((await clientWith(fetch).client.get("https://a.pt/x")).status).toBe("blocked");
  });

  it("treats a missing robots.txt as allowed", async () => {
    const fetch = fakeFetch({ "https://a.pt/x": [200, "ok"] });
    expect(await clientWith(fetch).client.get("https://a.pt/x")).toEqual({ status: "ok", body: "ok" });
  });

  it.each([
    ["refused", [403, ""] as [number, string]],
    ["failing", [500, ""] as [number, string]],
    ["unreachable", new Error("network")],
  ])("stays out when robots.txt is %s", async (_name, route) => {
    const fetch = fakeFetch({ [ROBOTS]: route, "https://a.pt/x": [200, "no"] });
    expect((await clientWith(fetch).client.get("https://a.pt/x")).status).toBe("blocked");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal as final and an outage as retryable", async () => {
    const fetch = fakeFetch({
      "https://a.pt/forbidden": [403, ""],
      "https://a.pt/busy": [429, ""],
      "https://a.pt/down": [503, ""],
      "https://a.pt/net": new Error("network"),
    });
    const { client } = clientWith(fetch);
    expect((await client.get("https://a.pt/forbidden")).status).toBe("blocked");
    expect((await client.get("https://a.pt/busy")).status).toBe("unavailable");
    expect((await client.get("https://a.pt/down")).status).toBe("unavailable");
    expect((await client.get("https://a.pt/net")).status).toBe("unavailable");
  });

  it("spaces requests to one host by its Crawl-delay", async () => {
    const fetch = fakeFetch({
      [ROBOTS]: [200, "User-agent: *\nCrawl-delay: 15"],
      "https://a.pt/1": [200, ""],
      "https://a.pt/2": [200, ""],
    });
    const { client, sleep } = clientWith(fetch);
    await Promise.all([client.get("https://a.pt/1"), client.get("https://a.pt/2")]);
    expect(sleep).toHaveBeenCalledWith(15_000);
  });

  it("sends only one request at a time to a host", async () => {
    let active = 0;
    let peak = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Response("");
    });
    const { client } = clientWith(fetch);
    await Promise.all(["1", "2", "3"].map((path) => client.get(`https://a.pt/${path}`)));
    expect(peak).toBe(1);
  });

  it("rejects an oversized response", async () => {
    const fetch = fakeFetch({ "https://a.pt/big": [200, "x".repeat(8 * 1024 * 1024 + 1)] });
    expect((await clientWith(fetch).client.get("https://a.pt/big")).status).toBe("unavailable");
  });
});

describe("decodeBody", () => {
  const latin1 = Uint8Array.from(Buffer.from("Política", "latin1"));

  it("uses the charset from the header", () => {
    expect(decodeBody(latin1, "text/xml; charset=ISO-8859-1")).toBe("Política");
  });

  it("uses the encoding declared in the XML", () => {
    const xml = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?>'), latin1]);
    expect(decodeBody(xml, "text/xml")).toContain("Política");
  });

  it("uses the charset in an HTML meta tag", () => {
    const html = Buffer.concat([Buffer.from('<meta charset="iso-8859-1">'), latin1]);
    expect(decodeBody(html, "text/html")).toContain("Política");
  });

  it("defaults to UTF-8 and survives an unknown charset", () => {
    expect(decodeBody(Buffer.from("Política"), null)).toBe("Política");
    expect(decodeBody(Buffer.from("Política"), "text/html; charset=nonsense")).toBe("Política");
  });
});
