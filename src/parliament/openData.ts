import { Readable, Transform } from "node:stream";
import StreamArray from "stream-json/streamers/StreamArray.js";
import { HttpError, RETRY_DELAYS_MS, withRetry } from "../ingestion/retry.js";

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
  retryDelaysMs = [120_000, 300_000, 600_000],
  requestRetryDelaysMs = RETRY_DELAYS_MS,
  log = (message: string) => console.warn(message),
}: {
  legislature: string;
  fetch?: typeof fetch;
  /** How long a request may go without receiving anything (the files are large: not a cap on the whole download). */
  timeoutMs?: number;
  /**
   * Waits before trying again when a dataset's file can't be found or a page fails. The
   * parliament regenerates its files at night, and for a while a folder can list no file.
   */
  retryDelaysMs?: number[];
  /** Waits before trying one request again after a timeout, a dropped connection or a 5xx. */
  requestRetryDelaysMs?: readonly number[];
  log?: (message: string) => void;
}): OpenDataLoader => {
  /** One request, failing when nothing arrives for timeoutMs (waiting for the answer or between chunks of its body). */
  const requestOnce = async (url: string) => {
    const controller = new AbortController();
    // The body's own stream, failed directly on expiry: reading it fails then, whatever fetch does with the abort.
    let output: TransformStreamDefaultController<Uint8Array> | null = null;
    const expire = () => {
      const reason = new DOMException(`Nothing from ${url} for ${Math.round(timeoutMs / 1000)} s`, "TimeoutError");
      controller.abort(reason);
      output?.error(reason);
    };
    let timer = setTimeout(expire, timeoutMs);
    // A body nobody finishes reading mustn't keep the process alive.
    timer.unref();
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(expire, timeoutMs);
      timer.unref();
    };
    try {
      const response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
      if (!response.ok) {
        clearTimeout(timer);
        await response.body?.cancel().catch(() => {});
        throw new HttpError(response.status, url);
      }
      if (!response.body) {
        clearTimeout(timer);
        return response;
      }
      touch();
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          start: (out) => {
            output = out;
          },
          transform: (chunk, out) => {
            touch();
            out.enqueue(chunk);
          },
          flush: () => clearTimeout(timer),
        }),
      );
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  };
  const retrying = { delaysMs: requestRetryDelaysMs, onRetry: (error: unknown, wait: number) => log(`${error instanceof Error ? error.message : String(error)}; trying again in ${Math.round(wait / 1000)} s`) };
  /** Pages and whole files: the read is tried again too. */
  const get = (url: string) => withRetry(async () => (await requestOnce(url)).text(), retrying);
  /** A streamed file: only getting its answer is tried again (what was already read can't be taken back). */
  const request = (url: string) => withRetry(() => requestOnce(url), retrying);

  const findFile = async (dataset: Dataset) => {
    const page = `${SITE}/Cidadania/Paginas/${DATASETS[dataset]}.aspx`;
    const folder = findFolderLink(await get(page), legislature);
    if (!folder) throw new Error(`No ${legislature} folder on ${page}`);
    const file = findJsonLink(await get(folder));
    if (!file) throw new Error(`No JSON file in the ${legislature} folder of ${page}`);
    return file;
  };
  const fileUrl = async (dataset: Dataset) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await findFile(dataset);
      } catch (error) {
        const wait = retryDelaysMs[attempt];
        if (wait === undefined) throw error;
        log(`${error instanceof Error ? error.message : String(error)}; trying again in ${Math.round(wait / 1000)} s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
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
