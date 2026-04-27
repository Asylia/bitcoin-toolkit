/**
 * Tiny zero-dependency utilities shared by the providers.
 *
 * The package targets browsers, Deno (Supabase Edge Functions), and
 * Node side-by-side, so every helper here only relies on the Web /
 * fetch standard library.
 */

/**
 * Map an array with a fixed concurrency ceiling.
 *
 * Used by Esplora-shaped providers (Blockstream, Mempool, mirrors) to
 * fan out a multi-address request as several single-address calls
 * without blasting the upstream API in parallel. Results are returned
 * in the original input order so the consumer can zip them back to its
 * address list without bookkeeping.
 */
export async function pMap<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const iterator = items.entries();

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = new Array(workerCount).fill(iterator).map(async (iter) => {
    for (const [index, item] of iter) {
      results[index] = await task(item);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Universal base64 encoder. Browser, Deno and Node all expose at least
 * one of `btoa` (Web) or `Buffer` (Node) — we prefer the Web API where
 * available so the package stays free of `node:`-prefixed imports.
 *
 * Used to build HTTP `Authorization: Basic <b64>` headers when a
 * provider needs `clientId:clientSecret`. ASCII input only.
 */
export function toBase64(value: string): string {
  if (typeof btoa === 'function') return btoa(value);
  const g = globalThis as unknown as {
    Buffer?: { from(s: string): { toString(enc: string): string } };
  };
  if (g.Buffer) return g.Buffer.from(value).toString('base64');
  throw new Error('No base64 encoder available in this environment.');
}

/**
 * Parse the value of a `Retry-After` HTTP response header into
 * milliseconds, per RFC 7231:
 *
 *   - Bare integer is interpreted as a delta in *seconds*.
 *   - HTTP-date string is interpreted absolutely; the result is the
 *     positive distance to that timestamp.
 *
 * Returns `null` when the header is missing, malformed, or carries a
 * non-positive value — the caller should fall back to its own
 * baseline cooldown in that case.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    if (asNumber <= 0) return null;
    return Math.floor(asNumber * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isFinite(asDate)) return null;
  const delta = asDate - Date.now();
  return delta > 0 ? delta : null;
}
