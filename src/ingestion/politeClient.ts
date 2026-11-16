import robotsParserModule from "robots-parser";

// The package is CommonJS, but its types describe an ES default export.
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;

export const USER_AGENT =
  "PoliticandoBot/1.0 (+https://github.com/relense/politicando-backEnd)";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HOST_DELAY_MS = 2_000;
const MAX_HOST_DELAY_MS = 30_000;

/** Several Portuguese outlets still serve ISO-8859-1, declared in the header or the document. */
export const decodeBody = (bytes: Uint8Array, contentType: string | null) => {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const charset =
    contentType?.match(/charset=["']?([\w-]+)/i)?.[1] ??
    head.match(/<\?xml[^>]*encoding=["']([\w-]+)/i)?.[1] ??
    head.match(/<meta[^>]*charset=["']?([\w-]+)/i)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

export type FetchResult =
  | { status: "ok"; body: string }
  /** robots.txt or the site refused us. Final: never retried or worked around. */
  | { status: "blocked"; reason: string }
  /** Network or server trouble. Worth trying on a later run. */
  | { status: "unavailable"; reason: string };

interface Robots {
  isAllowed(url: string, userAgent: string): boolean | undefined;
  delayMs: number;
}

export interface PoliteClientOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  defaultDelayMs?: number;
}

/**
 * All outbound scanning goes through here. It identifies the bot honestly, obeys
 * robots.txt and Crawl-delay, and sends one request at a time per host.
 */
export const createPoliteClient = ({
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  defaultDelayMs = DEFAULT_HOST_DELAY_MS,
}: PoliteClientOptions = {}) => {
  const robotsByOrigin = new Map<string, Promise<Robots>>();
  const queues = new Map<string, Promise<unknown>>();

  const request = async (url: string) => {
    const response = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xml,*/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("Response too large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error("Response too large");
    return { status: response.status, body: decodeBody(bytes, response.headers.get("content-type")) };
  };

  /** One request at a time per host, spaced by that host's delay. */
  const inHostQueue = <T>(host: string, delayMs: () => number, task: () => Promise<T>) => {
    const previous = queues.get(host);
    const run = (previous ?? Promise.resolve()).then(async () => {
      if (previous) await sleep(delayMs());
      return task();
    });
    queues.set(host, run.catch(() => undefined));
    return run;
  };

  const loadRobots = (origin: string, host: string): Promise<Robots> => {
    const cached = robotsByOrigin.get(origin);
    if (cached) return cached;
    const robotsUrl = `${origin}/robots.txt`;
    const denyAll: Robots = { isAllowed: () => false, delayMs: defaultDelayMs };
    const loaded = inHostQueue(host, () => defaultDelayMs, async (): Promise<Robots> => {
      try {
        const { status, body } = await request(robotsUrl);
        // 401/403 and server errors mean we can't tell what's allowed, so stay out.
        if (status === 401 || status === 403 || status >= 500) return denyAll;
        const parsed = robotsParser(robotsUrl, status === 200 ? body : "");
        const crawlDelayMs = (parsed.getCrawlDelay(USER_AGENT) ?? 0) * 1000;
        return {
          isAllowed: (url, agent) => parsed.isAllowed(url, agent),
          delayMs: Math.min(Math.max(defaultDelayMs, crawlDelayMs), MAX_HOST_DELAY_MS),
        };
      } catch {
        return denyAll;
      }
    });
    robotsByOrigin.set(origin, loaded);
    return loaded;
  };

  return {
    async get(url: string): Promise<FetchResult> {
      const { origin, host } = new URL(url);
      const robots = await loadRobots(origin, host);
      if (robots.isAllowed(url, USER_AGENT) === false) {
        return { status: "blocked", reason: "robots.txt" };
      }
      return inHostQueue(host, () => robots.delayMs, async (): Promise<FetchResult> => {
        try {
          const { status, body } = await request(url);
          if (status >= 200 && status < 300) return { status: "ok", body };
          if (status === 429 || status >= 500) {
            return { status: "unavailable", reason: `HTTP ${status}` };
          }
          return { status: "blocked", reason: `HTTP ${status}` };
        } catch (error) {
          return { status: "unavailable", reason: String(error) };
        }
      });
    },
  };
};

export type PoliteClient = ReturnType<typeof createPoliteClient>;
