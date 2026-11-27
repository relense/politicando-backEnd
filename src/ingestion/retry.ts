import { USER_AGENT } from "./politeClient.js";

/*
 * Trying again after a passing failure: a timeout, a dropped connection, a 429 or a 5xx. One slow
 * answer from an official site shouldn't fail a whole cron run (it did: a budget run that timed
 * out on parlamento.pt's dataset page, while the next hour's worked). Anything else (a 404, a
 * page that changed) fails at once: waiting won't fix it.
 */

/** Waits before each new attempt: two more tries, after 10 s and 30 s. */
export const RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000];

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

/** Worth trying again: a timeout, a network error, or the server busy or failing. */
export const isTransient = (error: unknown) => {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  if (!(error instanceof Error)) return false;
  // undici: "fetch failed" (refused, reset, DNS) before the answer; "terminated" while reading it.
  return error.name === "TimeoutError" || (error instanceof TypeError && /^(fetch failed|terminated)$/.test(error.message));
};

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Told before each wait. */
  onRetry?: (error: unknown, waitMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs the task, again after each wait while it fails with a passing error. */
export const withRetry = async <T>(task: () => Promise<T>, { delaysMs = RETRY_DELAYS_MS, sleep = defaultSleep, onRetry }: RetryOptions = {}): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const wait = delaysMs[attempt];
      if (wait === undefined || !isTransient(error)) throw error;
      onRetry?.(error, wait);
      await sleep(wait);
    }
  }
};

export interface FetchRetryOptions extends RetryOptions {
  fetchFn?: typeof fetch;
  /** Per attempt, reading the body included. */
  timeoutMs?: number;
  init?: Omit<RequestInit, "signal">;
}

/**
 * GETs a URL and reads its body, trying again on passing failures (the body read counts: a
 * timeout halfway through is tried again too). Sends our User-Agent unless init sets one.
 */
export const fetchWithRetry = async <T>(
  url: string,
  read: (response: Response) => Promise<T>,
  { fetchFn = fetch, timeoutMs = 60_000, init = {}, ...retry }: FetchRetryOptions = {},
): Promise<T> =>
  withRetry(async () => {
    const response = await fetchFn(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(response.status, url);
    }
    return read(response);
  }, retry);

export const fetchText = (url: string, options?: FetchRetryOptions) => fetchWithRetry(url, (r) => r.text(), options);
export const fetchJson = <T = unknown>(url: string, options?: FetchRetryOptions) => fetchWithRetry(url, (r) => r.json() as Promise<T>, options);
