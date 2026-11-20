import { describe, expect, it, vi } from "vitest";
import { createPoliteClient, decodeBody, isPrivateIp, USER_AGENT } from "../src/ingestion/politeClient.js";

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
    ["refused", [403, ""] as [number, string], "blocked"],
    ["failing", [500, ""] as [number, string], "blocked"],
    // Network trouble isn't a refusal: stay out, but try again on a later run.
    ["unreachable", new Error("network"), "unavailable"],
  ])("stays out when robots.txt is %s", async (_name, route, status) => {
    const fetch = fakeFetch({ [ROBOTS]: route, "https://a.pt/x": [200, "no"] });
    expect((await clientWith(fetch).client.get("https://a.pt/x")).status).toBe(status);
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

  it("follows a redirect hop by hop, each checked against its own host's robots.txt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url === "https://a.pt/x") return new Response("", { status: 301, headers: { location: "https://b.pt/y" } });
      if (url === "https://b.pt/robots.txt") return new Response("User-agent: *\nDisallow: /y");
      if (url === "https://a.pt/z") return new Response("", { status: 302, headers: { location: "/final" } });
      if (url === "https://a.pt/final") return new Response("done");
      return new Response("", { status: 404 });
    });
    const { client } = clientWith(fetch);
    expect(await client.get("https://a.pt/x")).toEqual({ status: "blocked", reason: "robots.txt" });
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain("https://b.pt/y");
    expect(await client.get("https://a.pt/z")).toEqual({ status: "ok", body: "done" });
    for (const [, init] of fetch.mock.calls.filter(([url]) => !String(url).endsWith("robots.txt"))) expect(init?.redirect).toBe("manual");
  });

  it("never fetches a private or internal address, even through a redirect", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input) === "https://a.pt/x" ? new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest" } }) : new Response(""),
    );
    const { client } = clientWith(fetch);
    expect(await client.get("https://a.pt/x")).toEqual({ status: "blocked", reason: "not a public web address" });
    expect(await client.get("http://localhost:4000/")).toMatchObject({ status: "blocked" });
    expect(await client.get("http://10.0.0.5/")).toMatchObject({ status: "blocked" });
    expect(await client.get("http://[::1]/")).toMatchObject({ status: "blocked" });
    expect(fetch.mock.calls.map(([url]) => String(url)).some((u) => /169\.254|localhost|10\.0|::1/.test(u))).toBe(false);
  });

  it("never fetches a public-looking host that resolves to a private address, or a robots.txt that redirects to one", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input) === "https://c.pt/robots.txt" ? new Response("", { status: 301, headers: { location: "http://10.1.2.3/robots.txt" } }) : new Response("ok"),
    );
    const resolve = async (host: string) => (host === "evil.pt" ? ["127.0.0.1"] : ["192.0.2.10"]);
    const client = createPoliteClient({ fetch, sleep: async () => undefined, resolve });
    expect(await client.get("https://evil.pt/x")).toEqual({ status: "blocked", reason: "not a public web address" });
    // robots.txt redirecting to a private address: treated as "can't tell", so nothing is fetched.
    expect(await client.get("https://c.pt/x")).toEqual({ status: "blocked", reason: "robots.txt" });
    expect(fetch.mock.calls.map(([u]) => String(u))).toEqual(["https://c.pt/robots.txt"]);
    expect(isPrivateIp("::7f00:1")).toBe(true);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  it("treats a DNS failure as 'try later', not as blocked, and asks DNS again next time", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("ok"));
    let calls = 0;
    const resolve = async () => {
      calls++;
      if (calls === 1) throw new Error("getaddrinfo EAI_AGAIN d.pt");
      return ["192.0.2.20"];
    };
    const client = createPoliteClient({ fetch, sleep: async () => undefined, resolve });
    expect(await client.get("https://d.pt/x")).toMatchObject({ status: "unavailable" });
    expect(await client.get("https://d.pt/x")).toEqual({ status: "ok", body: "ok" });
  });

  it("an unreachable robots.txt means 'try later' for the site's pages, and is asked again", async () => {
    let robotsCalls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith("robots.txt")) {
        robotsCalls++;
        if (robotsCalls === 1) throw new TypeError("fetch failed: ECONNRESET");
        return new Response("");
      }
      return new Response("page");
    });
    const { client } = clientWith(fetch);
    expect(await client.get("https://e.pt/x")).toEqual({ status: "unavailable", reason: "robots.txt unreachable" });
    expect(await client.get("https://e.pt/x")).toEqual({ status: "ok", body: "page" });
    expect(robotsCalls).toBe(2);
  });

  it("stops reading a body past 8 MB even without Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("robots.txt") ? new Response("") : new Response(stream),
    );
    const result = await clientWith(fetch).client.get("https://a.pt/big");
    expect(result).toMatchObject({ status: "unavailable" });
    expect(sent).toBeLessThan(15);
  });
});
