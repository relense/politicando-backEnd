import { describe, expect, it } from "vitest";
import { fetchText, HttpError, isTransient, withRetry } from "../src/ingestion/retry.js";
import { createOpenDataClient } from "../src/parliament/openData.js";

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const noWait = { delaysMs: [0, 0], sleep: async () => undefined };

/** A fetch that answers each call with the next of these (a Response, or an error to throw). */
const scripted = (...answers: (Response | Error | (() => Response))[]) => {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
};

describe("trying again", () => {
  it("tells passing failures from lasting ones", () => {
    expect(isTransient(timeout())).toBe(true);
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(new TypeError("terminated"))).toBe(true);
    expect(isTransient(new HttpError(503, "x"))).toBe(true);
    expect(isTransient(new HttpError(429, "x"))).toBe(true);
    expect(isTransient(new HttpError(404, "x"))).toBe(false);
    expect(isTransient(new Error("No JSON file"))).toBe(false);
    expect(isTransient(new TypeError("x is not a function"))).toBe(false);
  });

  it("tries again after a timeout, a dropped connection or a 5xx, then answers", async () => {
    const { fetchFn, urls } = scripted(timeout(), new TypeError("fetch failed"), new Response("busy", { status: 503 }), new Response("ok"));
    const waits: number[] = [];
    const text = await fetchText("https://x.pt/a", { fetchFn, delaysMs: [1, 2, 3], sleep: async (ms) => void waits.push(ms) });
    expect(text).toBe("ok");
    expect(urls).toHaveLength(4);
    expect(waits).toEqual([1, 2, 3]);
  });

  it("gives up after its waits, and at once on a lasting failure", async () => {
    const down = scripted(timeout(), timeout(), timeout());
    await expect(fetchText("https://x.pt/a", { fetchFn: down.fetchFn, ...noWait })).rejects.toThrow("timeout");
    expect(down.urls).toHaveLength(3);

    const missing = scripted(new Response("no", { status: 404 }), new Response("ok"));
    await expect(fetchText("https://x.pt/a", { fetchFn: missing.fetchFn, ...noWait })).rejects.toThrow("HTTP 404 for https://x.pt/a");
    expect(missing.urls).toHaveLength(1);

    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("bad data"); }, noWait)).rejects.toThrow("bad data");
    expect(calls).toBe(1);
  });
});

describe("open data client downloads", () => {
  const SITE = "https://www.parlamento.pt";
  const datasetPage = `<a title="Pasta XVII Legislatura" class="TextoRegular" href="/Cidadania/Paginas/DARegistoBiografico.aspx?t=1&amp;Path=abc">XVII</a>`;
  const folder = `<a href="https://app.parlamento.pt/webutils/docs/doc.txt?path=x">RegistoBiograficoXVII_json.txt</a>`;

  it("tries the file download again after a 5xx", async () => {
    let downloads = 0;
    const fetchImpl = (async (url: string) => {
      if (url === `${SITE}/Cidadania/Paginas/DARegistoBiografico.aspx`) return new Response(datasetPage);
      if (url.includes("Path=abc")) return new Response(folder);
      return ++downloads === 1 ? new Response("busy", { status: 502 }) : new Response('[{"id":1},{"id":2}]');
    }) as typeof fetch;
    const client = createOpenDataClient({ legislature: "XVII", fetch: fetchImpl, retryDelaysMs: [], requestRetryDelaysMs: [0], log: () => {} });
    const items = [];
    for await (const item of client.items("biographies")) items.push(item);
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(downloads).toBe(2);
  });

  it("times out on a body that stops arriving, not on one that keeps coming slowly", async () => {
    const encoder = new TextEncoder();
    /** A body sending these chunks this many ms apart, then (if `stall`) nothing more. */
    const body = (chunks: string[], gapMs: number, stall = false) =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            await new Promise((resolve) => setTimeout(resolve, gapMs));
            controller.enqueue(encoder.encode(chunk));
          }
          if (!stall) controller.close();
        },
      });
    const site = (file: () => ReadableStream<Uint8Array>) =>
      (async (url: string) => {
        if (url === `${SITE}/Cidadania/Paginas/DARegistoBiografico.aspx`) return new Response(datasetPage);
        if (url.includes("Path=abc")) return new Response(folder);
        return new Response(file());
      }) as typeof fetch;
    // Six chunks 40 ms apart (240 ms in all) with a 100 ms limit: it's the gaps that count.
    const slow = createOpenDataClient({ legislature: "XVII", fetch: site(() => body(['[{"id":1}', ",", '{"id":2}', ",", '{"id":3}', "]"], 40)), timeoutMs: 100, retryDelaysMs: [], requestRetryDelaysMs: [], log: () => {} });
    expect(await slow.json("biographies")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const stalled = createOpenDataClient({ legislature: "XVII", fetch: site(() => body(['[{"id":1}'], 10, true)), timeoutMs: 100, retryDelaysMs: [], requestRetryDelaysMs: [], log: () => {} });
    await expect(stalled.json("biographies")).rejects.toThrow(/Nothing from .* for 0 s/);
  });
});
