import { Readable, Transform } from "node:stream";
import StreamArray from "stream-json/streamers/StreamArray.js";

/**
 * Downloads files from the parliament's open data pages (parlamento.pt › Dados Abertos).
 * Download links carry tokens that change, so every run finds them from the pages:
 * dataset page → legislature folder → "<Name><Leg>_json.txt".
 */

const SITE = "https://www.parlamento.pt";
const USER_AGENT = "PoliticandoBot/1.0 (+https://github.com/relense/politicando-backEnd)";

export const DATASETS = {
  deputies: "DAInformacaoBase",
  biographies: "DARegistoBiografico",
  initiatives: "DAIniciativas",
  organs: "DAComposicaoOrgaos",
  /** The coming days' agenda ("Agenda Parlamentar"). */
  agenda: "DABoletimInformativo",
} as const;

export type Dataset = keyof typeof DATASETS;

/** Reads a dataset whole, or one array element at a time for files too big to hold in memory. */
export interface OpenDataLoader {
  json(dataset: Dataset): Promise<unknown>;
  items(dataset: Dataset): AsyncIterable<unknown>;
}

/** Removes a UTF-8 byte order mark at the start of a stream. */
const stripBom = () => {
  let first = true;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (first) {
        first = false;
        if (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) chunk = chunk.subarray(3);
      }
      done(null, chunk);
    },
  });
};

/** Yields the elements of a top-level JSON array without loading the whole document. */
export async function* streamJsonArray(body: Readable): AsyncIterable<unknown> {
  const elements = body.pipe(stripBom()).pipe(StreamArray.withParser());
  for await (const { value } of elements as AsyncIterable<{ value: unknown }>) yield value;
}

const decode = (href: string) => href.replace(/&amp;/g, "&");

export const findFolderLink = (html: string, legislature: string) => {
  // The Constituent Assembly's folder is just "Pasta Constituinte".
  const folder = legislature === "Constituinte" ? "Pasta Constituinte" : `Pasta ${legislature} Legislatura`;
  const match = new RegExp(`title="${folder}"[^>]*href="([^"]+)"`).exec(html);
  return match ? new URL(decode(match[1]!), SITE).href : null;
};

export const findJsonLink = (html: string) => {
  const match = /<a[^>]*href="([^"]+)"[^>]*>\s*[^<]*_json\.txt\s*<\/a>/.exec(html);
  return match ? new URL(decode(match[1]!), SITE).href : null;
};

export const createOpenDataClient = ({
  legislature,
  fetch: fetchImpl = fetch,
  timeoutMs = 300_000,
}: {
  legislature: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): OpenDataLoader => {
  const request = async (url: string) => {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response;
  };
  const get = async (url: string) => (await request(url)).text();

  const fileUrl = async (dataset: Dataset) => {
    const page = `${SITE}/Cidadania/Paginas/${DATASETS[dataset]}.aspx`;
    const folder = findFolderLink(await get(page), legislature);
    if (!folder) throw new Error(`No ${legislature} folder on ${page}`);
    const file = findJsonLink(await get(folder));
    if (!file) throw new Error(`No JSON file in the ${legislature} folder of ${page}`);
    return file;
  };

  return {
    json: async (dataset) => JSON.parse((await get(await fileUrl(dataset))).replace(/^\uFEFF/, "")),
    items: async function* (dataset) {
      const response = await request(await fileUrl(dataset));
      if (!response.body) throw new Error(`Empty response for ${dataset}`);
      yield* streamJsonArray(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream));
    },
  };
};
