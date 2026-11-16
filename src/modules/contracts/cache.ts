/**
 * Answers that only change when new data is imported (contract totals and charts: full
 * scans of the whole table) kept in memory until the data's version changes.
 *
 * - The version (e.g. the last import's time) is checked at most once per `checkEveryMs`.
 * - Identical requests that arrive together share one computation.
 * - The least recently used answers go first past `max`.
 */
export const createVersionedCache = <T>({
  version,
  max = 2000,
  checkEveryMs = 60_000,
  now = Date.now,
}: {
  version: () => Promise<string>;
  max?: number;
  checkEveryMs?: number;
  now?: () => number;
}) => {
  const entries = new Map<string, T>();
  const pending = new Map<string, Promise<T>>();
  let current: string | null = null;
  let checkedAt = -Infinity;
  let checking: Promise<boolean> | null = null;

  /** Whether the version changed (the cache is then emptied). */
  const refresh = (force = false): Promise<boolean> => {
    if (!force && now() - checkedAt < checkEveryMs) return Promise.resolve(false);
    checking ??= version()
      .then((v) => {
        checkedAt = now();
        const changed = current !== null && v !== current;
        if (current !== v) {
          entries.clear();
          pending.clear();
        }
        current = v;
        return changed;
      })
      .finally(() => {
        checking = null;
      });
    return checking;
  };

  const get = async (key: string, compute: () => Promise<T>): Promise<T> => {
    await refresh();
    const hit = entries.get(key);
    if (hit !== undefined) {
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    }
    const running = pending.get(key);
    if (running) return running;
    const at = current;
    const promise = compute()
      .then((value) => {
        if (current === at) {
          entries.set(key, value);
          if (entries.size > max) entries.delete(entries.keys().next().value!);
        }
        return value;
      })
      .finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
    pending.set(key, promise);
    return promise;
  };

  return { get, refresh, size: () => entries.size };
};

/** The same key whatever order the query's fields came in; unset fields left out. */
export const cacheKey = (name: string, query: Record<string, unknown>) =>
  `${name}?${Object.keys(query)
    .filter((k) => query[k] !== undefined)
    .sort()
    .map((k) => `${k}=${String(query[k])}`)
    .join("&")}`;
