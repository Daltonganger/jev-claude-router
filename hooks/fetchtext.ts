/**
 * One GET with a deadline, for the data the router fetches at session start
 * (the catalog, the model list). Whatever goes wrong comes back as a short
 * reason with no URL, header or body in it: a reason lands in `/jev`, and
 * the headers may carry a key.
 */

import type { HttpInitLike, HttpResponseLike } from "./jev.ts";

export type FetchTextArgs = {
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  /** The engine's `$.clock.sleep`; `signal` ends the wait early, so no timer outlives the call. */
  sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<unknown>;
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
};

export async function fetchText(
  args: FetchTextArgs,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = new AbortController();
  const TIMED_OUT = Symbol("timed-out");
  // Started inside an async function, so a fetch that throws at once is a rejection handled below.
  const call = (async () =>
    args.fetch(args.url, { method: "GET", headers: args.headers ?? {}, signal: controller.signal }))();
  try {
    const raced = await Promise.race([
      call,
      args.sleep(args.timeoutMs, { signal: timer.signal }).then(
        () => TIMED_OUT,
        () => new Promise<never>(() => {}),
      ),
    ]);
    if (raced === TIMED_OUT) {
      controller.abort();
      void call.catch(() => undefined);
      return { ok: false, reason: `timed out after ${args.timeoutMs}ms` };
    }
    const response = raced as HttpResponseLike;
    if (!response) return { ok: false, reason: "no response" };
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, text: response.text };
  } catch {
    return { ok: false, reason: "request failed" };
  } finally {
    timer.abort();
  }
}
