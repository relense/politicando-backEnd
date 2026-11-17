import { describe, expect, it } from "vitest";
import { createOpenDataClient } from "../src/parliament/openData.js";

const SITE = "https://www.parlamento.pt";
const datasetPage = `<a title="Pasta XVII Legislatura" class="TextoRegular" href="/Cidadania/Paginas/DARegistoBiografico.aspx?t=1&amp;Path=abc">XVII</a>`;
const folderWith = `<a href="https://app.parlamento.pt/webutils/docs/doc.txt?path=x">RegistoBiograficoXVII_json.txt</a>`;
const folderEmpty = `<p>Sem ficheiros</p>`;

/** A fake parliament site whose XVII folder lists the file only from the `readyOn`-th visit. */
const site = (readyOn: number) => {
  let folderVisits = 0;
  const fetchImpl = (async (url: string) => {
    if (url === `${SITE}/Cidadania/Paginas/DARegistoBiografico.aspx`) return new Response(datasetPage);
    if (url.includes("Path=abc")) return new Response(++folderVisits >= readyOn ? folderWith : folderEmpty);
    if (url.includes("doc.txt")) return new Response('﻿[{"id":1}]');
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, visits: () => folderVisits };
};

describe("open data client", () => {
  it("tries again while the parliament regenerates a folder", async () => {
    const fake = site(3);
    const logs: string[] = [];
    const client = createOpenDataClient({ legislature: "XVII", fetch: fake.fetchImpl, retryDelaysMs: [0, 0, 0], log: (m) => logs.push(m) });
    expect(await client.json("biographies")).toEqual([{ id: 1 }]);
    expect(fake.visits()).toBe(3);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("No JSON file in the XVII folder");
  });

  it("gives up after its retries", async () => {
    const fake = site(99);
    const client = createOpenDataClient({ legislature: "XVII", fetch: fake.fetchImpl, retryDelaysMs: [0, 0], log: () => {} });
    await expect(client.json("biographies")).rejects.toThrow("No JSON file in the XVII folder");
    expect(fake.visits()).toBe(3);
  });
});
