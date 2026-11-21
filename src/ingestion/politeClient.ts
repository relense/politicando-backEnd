import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import robotsParserModule from "robots-parser";

// The package is CommonJS, but its types describe an ES default export.
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;

export const USER_AGENT =
  "PoliticandoBot/1.0 (+https://github.com/relense/politicando-backEnd)";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HOST_DELAY_MS = 2_000;
const MAX_REDIRECTS = 5;
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

export type FetchResult<Ok = { status: "ok"; body: string }> =
  | Ok
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
  /** A host's addresses. Real DNS with the real fetch; with a fake fetch (tests), nothing is looked up. */
  resolve?: (host: string) => Promise<string[]>;
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
  resolve = fetchImpl === globalThis.fetch ? defaultResolve : async () => ["192.0.2.1"],
}: PoliteClientOptions = {}) => {
  const robotsByOrigin = new Map<string, Promise<Robots | "unavailable">>();
  // One lookup per host per run.
  const resolved = new Map<string, Promise<string[]>>();
  const resolveOnce = (host: string) => {
    const known = resolved.get(host);
    if (known) return known;
    const lookedUp = resolve(host);
    resolved.set(host, lookedUp);
    // A failed lookup isn't remembered: the next request for that host asks again.
    lookedUp.catch(() => resolved.delete(host));
    return lookedUp;
  };
  const isPublic = (url: URL) => isPublicAddress(url, resolveOnce);
  const queues = new Map<string, Promise<unknown>>();

  /**
   * One request. Redirects aren't followed here: get() and the robots.txt loader follow them
   * themselves, so each hop is checked (robots.txt, its own host's queue, a public address).
   */
  const request = async (url: string) => {
    const response = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xml,*/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location !== null) {
      await response.body?.cancel();
      return { status: response.status, bytes: new Uint8Array(0), contentType: null, location: new URL(location, url).toString() };
    }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("Response too large");
    }
    // Read up to the limit, whatever Content-Length said (or didn't).
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return { status: response.status, bytes, contentType: response.headers.get("content-type"), location: null };
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

  /**
   * The site's robots.txt rules, once per run. "unavailable" when it couldn't be read for
   * network reasons (DNS, a timeout, a reset): not remembered, so pages answer "try later" and
   * the next request asks again, instead of the whole site counting as blocked for the run.
   */
  const loadRobots = (origin: string, host: string): Promise<Robots | "unavailable"> => {
    const cached = robotsByOrigin.get(origin);
    if (cached) return cached;
    const robotsUrl = `${origin}/robots.txt`;
    const denyAll: Robots = { isAllowed: () => false, delayMs: defaultDelayMs };
    const loaded = inHostQueue(host, () => defaultDelayMs, async (): Promise<Robots | "unavailable"> => {
      try {
        // Redirects followed by hand, each hop checked like any other address.
        let at = robotsUrl;
        let fetched = await request(at);
        for (let hop = 0; fetched.location !== null && hop < MAX_REDIRECTS; hop++) {
          at = fetched.location;
          if (!(await isPublic(new URL(at)))) return denyAll;
          fetched = await request(at);
        }
        if (fetched.location !== null) return denyAll;
        const { status } = fetched;
        const body = decodeBody(fetched.bytes, fetched.contentType);
        // 401/403 and server errors mean we can't tell what's allowed, so stay out.
        if (status === 401 || status === 403 || status >= 500) return denyAll;
        const parsed = robotsParser(robotsUrl, status === 200 ? body : "");
        const crawlDelayMs = (parsed.getCrawlDelay(USER_AGENT) ?? 0) * 1000;
        return {
          isAllowed: (url, agent) => parsed.isAllowed(url, agent),
          delayMs: Math.min(Math.max(defaultDelayMs, crawlDelayMs), MAX_HOST_DELAY_MS),
        };
      } catch {
        return "unavailable";
      }
    });
    robotsByOrigin.set(origin, loaded);
    void loaded.then((robots) => {
      if (robots === "unavailable") robotsByOrigin.delete(origin);
    });
    return loaded;
  };

  type Raw = { status: "ok"; bytes: Uint8Array; contentType: string | null };
  const fetchRaw = async (url: string, hops = 0): Promise<FetchResult<Raw>> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { status: "blocked", reason: "bad URL" };
    }
    let isPublicHost: boolean;
    try {
      isPublicHost = await isPublic(parsed);
    } catch (error) {
      return { status: "unavailable", reason: `DNS: ${String(error)}` };
    }
    if (!isPublicHost) return { status: "blocked", reason: "not a public web address" };
    const { origin, host } = parsed;
    const robots = await loadRobots(origin, host);
    if (robots === "unavailable") return { status: "unavailable", reason: "robots.txt unreachable" };
    if (robots.isAllowed(url, USER_AGENT) === false) {
      return { status: "blocked", reason: "robots.txt" };
    }
    const result = await inHostQueue(host, () => robots.delayMs, async (): Promise<FetchResult<Raw> | { status: "redirect"; to: string }> => {
      try {
        const { status, bytes, contentType, location } = await request(url);
        if (location !== null) return { status: "redirect", to: location };
        if (status >= 200 && status < 300) return { status: "ok", bytes, contentType };
        if (status === 429 || status >= 500) {
          return { status: "unavailable", reason: `HTTP ${status}` };
        }
        return { status: "blocked", reason: `HTTP ${status}` };
      } catch (error) {
        return { status: "unavailable", reason: String(error) };
      }
    });
    if (result.status !== "redirect") return result;
    if (hops >= MAX_REDIRECTS) return { status: "unavailable", reason: "too many redirects" };
    // Each hop is a request of its own: its host's robots.txt, queue and delay.
    return fetchRaw(result.to, hops + 1);
  };

  return {
    /** A page as text. */
    get: async (url: string): Promise<FetchResult> => {
      const result = await fetchRaw(url);
      return result.status === "ok" ? { status: "ok", body: decodeBody(result.bytes, result.contentType) } : result;
    },
    /** A file as bytes (a PDF), with the same checks. */
    getBytes: (url: string) => fetchRaw(url),
  };
};

export type PoliteClient = ReturnType<typeof createPoliteClient>;

/** Loopback, private, link-local (the cloud's metadata address), carrier-grade NAT, multicast, reserved. */
export const isPrivateIp = (ip: string) => {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  // Anything starting "::" (unspecified, loopback, IPv4-compatible or -mapped), unique-local
  // (fc00::/7), link-local (fe80::/10), multicast (ff00::/8).
  return v6.startsWith("::") || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff") || v6.startsWith("0:0:0:0:0:");
};

/**
 * Only http(s) to a host that is, and resolves to, a public address: a redirect (or a link in a
 * feed) to localhost, a private network or the cloud's metadata address is never fetched.
 */
export const isPublicWebUrl = (url: URL) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  return isIP(host) === 0 || !isPrivateIp(host);
};

/**
 * isPublicWebUrl, and for a named host, every address it resolves to. A lookup that fails (DNS
 * trouble) throws, so the caller treats it as "try again later", never as a final "blocked".
 */
export const isPublicAddress = async (url: URL, resolve: (host: string) => Promise<string[]> = defaultResolve) => {
  if (!isPublicWebUrl(url)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return true;
  const addresses = await resolve(host);
  return addresses.length > 0 && !addresses.some(isPrivateIp);
};
const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);
