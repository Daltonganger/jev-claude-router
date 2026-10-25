/**
 * Asking Jev, TypeSafe's decision model, through either the Vercel AI
 * Gateway or TypeSafe's direct API.
 *
 * The gateway (POST /v1/evaluate) speaks its own vocabulary: question types
 * are `choice` and `score` (never TypeSafe's native `noul`, which it rejects
 * outright). Probabilities and confidences come back rounded to two decimal
 * places.
 *
 * TypeSafe direct (POST /v1/systemone) supports choice, score, and noul and
 * returns probabilities rounded to four decimal places.
 *
 * Both support the same `choice` and `score` question types and the same
 * `answers` response shape, so the request/response handling is identical.
 *
 * `fetch` and `sleep` are arguments rather than imports so this file runs
 * under plain `node` in tests, with no engine and no network.
 */

import { EFFORT_CRITERIA, PLAIN_DECIMAL, TIER_CRITERIA, type Tier } from "./policy.ts";
import type { ProviderOk, ProviderResult, RouteName } from "./provider.ts";

/**
 * Measured against the live gateway on 2026-09-20: ten prompts ran 402ms to
 * 839ms. An 800ms budget failed open on the slowest of them, so this leaves
 * real headroom while still capping what a turn waits before giving up.
 * `JEV_ROUTER_TIMEOUT_MS` overrides it.
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Jev takes 32k tokens of state and reads the whole of it; TypeSafe's own
 * guidance is that accuracy falls as the state grows with content unrelated
 * to the decision. A routing decision is made on how a request opens, so a
 * long paste is cut here rather than sent whole and refused with a 422.
 */
export const MAX_STATE_CHARS = 12_000;

/**
 * The first `n` UTF-16 units of `text`, one fewer when the cut would split a
 * surrogate pair: half an emoji is not valid Unicode, and a strict JSON
 * parser on the other end refuses the whole body.
 */
export function headOf(text: string, n: number): string {
  if (n <= 0) return "";
  if (text.length <= n) return text;
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/** The state Jev is sent: the prompt, cut at MAX_STATE_CHARS. */
export function stateOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_STATE_CHARS
    ? trimmed
    : `${headOf(trimmed, MAX_STATE_CHARS)}…`;
}

/**
 * An error's message as text, whatever was thrown: a fetch may reject with
 * something that is not an Error, or one whose message is not a string, and
 * turning that into text must not itself throw.
 */
export function messageOf(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") return error.message || "unknown error";
    // A bare number or a blank string says nothing a person can use either.
    if (typeof error === "string") return error.trim() || "unknown error";
    // `undefined`, `[object Object]` and the like say nothing to a person.
    return "unknown error";
  } catch {
    return "unknown error";
  }
}

/**
 * `text` with a `Bearer` value that reads as a credential taken out: one
 * with a digit or an underscore, sixteen characters or more, or letters of
 * both cases — not the words an error uses about one ("Bearer required",
 * "Invalid Bearer token.", "Bearer auth/OAuth"). Each value is judged on
 * its own, so the work is linear. The configured key is taken out by
 * `withoutKey` wherever it is.
 */
export function withoutBearer(text: string): string {
  // U+0085 counts as a gap too: `\s` leaves it out, and a line split later
  // turns it into a space next to the token.
  return text.replace(/\bBearer([\s\u0085]+)(["']?)([^\s\u0085"']+)(["']?)/gi, (all, space: string, _open: string, value: string) => {
    // Trailing punctuation found by hand: `[…]+$` rescanned a long run of
    // it from each position.
    let cut = value.length;
    while (cut > 0 && ".,;:!?)]".includes(value[cut - 1]!)) cut--;
    const trail = value.slice(cut);
    const bare = value.slice(0, value.length - trail.length);
    const credential =
      /[\d_]/.test(bare) || bare.length >= 16 || (/^[A-Za-z]{8,}$/.test(bare) && /[a-z]/.test(bare) && /[A-Z]/.test(bare));
    return credential ? `${all.slice(0, 6)}${space}…${trail}` : all;
  });
}

/** `text` with every occurrence of `key` taken out: an error can quote it anywhere. */
export function withoutKey(text: string, key: string | undefined): string {
  return key && key.length >= 4 ? text.split(key).join("…") : text;
}

/**
 * An engine fetch error as a few words for the route line: without the
 * engine's "<plugin>: $.http.fetch(<url>) failed:" preamble, repeats and
 * advice, e.g. "ECONNREFUSED" or "getaddrinfo ENOTFOUND host".
 */
export function shortError(detail: string): string {
  // Cut first, and newlines folded by splitting: `\s*\n\s*` is quadratic
  // on a long run of spaces with no newline in it.
  // Control characters become spaces and credentials go before the cut, so
  // none can hide a token from the Bearer rule or split one at the cut.
  const bare = withoutBearer(
    // eslint-disable-next-line no-control-regex
    detail.replace(/[\x00-\x08\x0e-\x1f\x7f-\x84\x86-\x9f]/g, " "),
  )
    .slice(0, 2000)
    .split(/[\n\r\v\f\u0085\u2028\u2029]/)
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .join(" ")
    .replace(/^[\w.-]+: \$\.http\.fetch\([^)]*\) failed: /, "");
  const said = bare
    .split(/[.?!]\s/)[0]!
    .replace(/^(\w+): \1\b:?\s*/, "$1: ")
    .replace(/:\s*$/, "")
    .trim();
  return said.length > 60 ? `${said.slice(0, 57)}…` : said;
}

/**
 * Below this a budget is taken for a mistake, most likely seconds written
 * where milliseconds are read (`1.5`), which would time every turn out.
 */
export const MIN_TIMEOUT_MS = 100;

/** A timeout from the environment, or the default when it is unusable. */
export function timeoutOf(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  const parsed = Number(v);
  if (!PLAIN_DECIMAL.test(v) || parsed < MIN_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

/**
 * The longest a turn may wait for Jev. The wait runs on `$.clock`, which
 * counts against the hook's 10-second budget; a hook over it is skipped as
 * absent and its turn goes unrecorded. So the budget from the environment is
 * held under it, with room for the hook's own work.
 */
export const MAX_TIMEOUT_MS = 8000;

export type HttpResponseLike = {
  ok: boolean;
  status: number;
  text: string;
};

/**
 * What one attempt at Jev came to. A failure carries its reason so the
 * session can say why a turn went unrouted instead of going quiet.
 */
export type JevResult =
  | { ok: true; answers: unknown; ms: number; via?: RouteName; model?: string; tries?: Try[] }
  | { ok: false; reason: string; ms: number; tries?: Try[] };

/**
 * One provider's part in a decision asked of several: whether it was asked,
 * when, and how it ended. Kept for every provider, not only the one taken,
 * so `/jev stats` can show why a provider keeps being passed over. Asking a
 * provider bills it whether or not its answer is taken (no request is
 * stopped once sent: the engine's fetch takes no abort signal).
 */
export type Try = {
  name: RouteName;
  /** `won`: taken; `answered`: answered, another taken; `pending`: still asking when the decision was made. */
  outcome: "won" | "answered" | "failed" | "timed out" | "pending" | "not asked";
  /** When it was asked, ms after the decision started; absent when it was not asked. */
  start?: number;
  /** How long it took to answer or fail, ms; absent while pending or not asked. */
  ms?: number;
};

/** The outcome of an attempt that ended. */
function outcomeOf(result: JevResult, won: boolean): Try["outcome"] {
  if (result.ok) return won ? "won" : "answered";
  return result.reason.startsWith("timed out") ? "timed out" : "failed";
}

export type AskArgs = {
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  /** The engine's `$.clock.sleep`; `signal` ends the wait early, so no timer outlives the call. */
  sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<unknown>;
  provider: ProviderResult;
  state: string;
  offered: readonly Tier[];
  /** Who wrote `state`, which the question to Jev says; `prompt` when absent. */
  source?: StateSource;
  timeoutMs?: number;
  /**
   * Aborted by the caller when the answer is no longer wanted (the turn was
   * ceded to a newer copy before this resolved). Wired to the same fetch
   * signal as the timeout abort; whether it actually stops the request
   * depends on the fetch implementation honouring it — see the note below.
   */
  signal?: AbortSignal;
  /** Injected so tests can measure without a real clock. */
  now?: () => number;
};

export type HttpInitLike = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

/** What the text Jev grades is: a typed prompt, a subagent's task, a finished task's report. */
export type StateSource = "prompt" | "task" | "notification";

/**
 * How the text is introduced to Jev. A subagent's task is written by the
 * model, and a finished task's report is a line about work done, not the
 * work to do next: graded as a developer's request, "Agent X completed"
 * reads as trivial when the turn is about to work through its results.
 */
const TIER_QUESTION: Record<StateSource, string> = {
  prompt: "A developer typed this request to a coding agent. Which model tier should answer it?",
  task:
    "A coding agent handed this task to a subagent of its own. Which model tier " +
    "should the subagent run on?",
  notification:
    "A background task the coding agent started has finished and reported back; " +
    "this is its report. The agent now works through the result and decides what " +
    "to do next. Which model tier should do that?",
};

/**
 * The request body for one routing decision: two questions Jev answers in
 * parallel, the tier as a Choice and the effort as a Score.
 *
 * The model field is added by askJev depending on which provider is used.
 */
export function requestBodyOf(
  state: string,
  offered: readonly Tier[],
  source: StateSource = "prompt",
  /**
   * Other wording for the tier question, to try it out (scripts/bench): the
   * description of some tiers, and the sentence the question opens with. The
   * router itself passes none, and sends `TIER_CRITERIA`.
   */
  wording?: { criteria?: Partial<Record<Tier, string>>; instructions?: string },
) {
  const criteria: Record<string, string> = {};
  for (const tier of offered) criteria[tier] = wording?.criteria?.[tier] ?? TIER_CRITERIA[tier];

  return {
    state,
    questions: {
      tier: {
        type: "choice",
        instructions: wording?.instructions ?? TIER_QUESTION[source],
        criteria,
      },
      effort: {
        type: "score",
        instructions: "How much thinking does answering this request take?",
        criteria: [...EFFORT_CRITERIA],
      },
    },
  };
}

/**
 * Asks Jev and answers with the response's `answers` object, or a reason.
 *
 * Every failure is still a pass for the turn, but it is a named one: the
 * caller reports the reason rather than leaving the person guessing whether
 * the router ran at all.
 *
 * On timeout, or on the caller's own `signal` aborting (the turn was ceded
 * before this resolved), the turn moves on without the answer. The engine's
 * `$.http.fetch` takes no abort signal, so the request itself runs to
 * completion and is billed (about $0.00003) either way; the signal is
 * passed for a plain `fetch`, as the scripts use, which does honour it.
 */
export async function askJev(args: AskArgs): Promise<JevResult> {
  const {
    fetch,
    sleep,
    provider,
    state,
    offered,
    now = () => Date.now(),
  } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();
  const since = () => now() - started;

  if (!provider.ok) return { ok: false, reason: provider.reason, ms: 0 };
  if (state.trim() === "") return { ok: false, reason: "empty prompt", ms: 0 };
  if (offered.length === 0)
    return { ok: false, reason: "no tiers offered", ms: 0 };
  if (args.signal?.aborted) return { ok: false, reason: "ceded", ms: 0 };

  const TIMED_OUT = Symbol("timed-out");
  const CEDED = Symbol("ceded");
  const controller = new AbortController();
  // The caller's signal cancels the same in-flight request the timeout does,
  // and resolves the race below the moment it fires.
  let onCeded: (() => void) | undefined;
  const ceded = new Promise<typeof CEDED>((resolve) => {
    onCeded = () => {
      controller.abort();
      resolve(CEDED);
    };
    args.signal?.addEventListener("abort", onCeded);
  });

  const body = {
    ...requestBodyOf(stateOf(state), offered, args.source, provider.wording),
    model: provider.model,
  };

  // Called inside an async function, so a fetch that throws at once is a
  // rejection handled below, not an escape past the finally.
  const call = (async () =>
    fetch(provider.endpoint, {
      method: "POST",
      headers: {
        // A Laya server on your own network may ask for no key.
        ...(provider.apiKey === "" ? {} : { authorization: `Bearer ${provider.apiKey}` }),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }))();
  // Ended in the finally, so the timeout does not keep running (and a
  // script's process alive) after the answer is in.
  const timer = new AbortController();

  let response: HttpResponseLike;
  try {
    const raced = await Promise.race([
      call,
      sleep(timeoutMs, { signal: timer.signal }).then(
        () => TIMED_OUT,
        () => new Promise<never>(() => {}),
      ),
      ceded,
    ]);
    if (raced === CEDED) {
      void call.catch(() => undefined);
      return { ok: false, reason: "ceded", ms: since() };
    }
    if (raced === TIMED_OUT) {
      controller.abort();
      void call.catch(() => undefined);
      return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms`,
        ms: since(),
      };
    }
    response = raced as HttpResponseLike;
  } catch (error) {
    if (args.signal?.aborted) {
      return { ok: false, reason: "ceded", ms: since() };
    }
    if (controller.signal.aborted) {
      return {
        ok: false,
        reason: `timed out after ${timeoutMs}ms`,
        ms: since(),
      };
    }
    return { ok: false, reason: `request failed: ${shortError(withoutKey(messageOf(error), provider.apiKey))}`, ms: since() };
  } finally {
    timer.abort();
    if (onCeded) args.signal?.removeEventListener("abort", onCeded);
  }

  if (!response) return { ok: false, reason: "no response", ms: since() };

  if (!response.ok) {
    const who = provider.name;
    return {
      ok: false,
      reason: `${who} said HTTP ${response.status}${providerNoteOf(response)}`,
      ms: since(),
    };
  }

  try {
    const parsed = JSON.parse(response.text) as { answers?: unknown };
    if (typeof parsed !== "object" || parsed === null || !parsed.answers) {
      return { ok: false, reason: "response carried no answers", ms: since() };
    }
    return { ok: true, answers: parsed.answers, ms: since(), via: provider.name, model: provider.model };
  } catch {
    return { ok: false, reason: "response was not JSON", ms: since() };
  }
}

export type ChainArgs = Omit<AskArgs, "provider"> & { providers: readonly ProviderOk[] };

/**
 * Asks each provider in turn until one answers. They share one budget: a
 * provider that fails at once (a refused connection, an HTTP error) leaves
 * the rest of the time to the next; one that times out has spent it, and
 * the turn goes unrouted. A turn ceded to a newer copy stops the chain.
 */
export async function askJevChain(args: ChainArgs): Promise<JevResult> {
  const now = args.now ?? (() => Date.now());
  const started = now();
  const budget = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: { name: string; reason: string }[] = [];
  const tries: Try[] = args.providers.map((p) => ({ name: p.name, outcome: "not asked" }));
  // Only with several providers is there anything to tell apart.
  const withTries = (r: JevResult): JevResult => ({ ...r, ms: now() - started, ...(args.providers.length > 1 ? { tries } : {}) });
  for (const [i, provider] of args.providers.entries()) {
    const left = budget - (now() - started);
    if (left < MIN_TIMEOUT_MS) break;
    const start = now() - started;
    const result = await askJev({ ...args, provider, timeoutMs: left });
    tries[i] = { name: provider.name, outcome: outcomeOf(result, true), start, ms: Math.round(result.ms) };
    if (result.ok) return withTries(result);
    if (result.reason === "ceded") return withTries(result);
    failures.push({ name: provider.name, reason: result.reason });
    if (result.reason.startsWith("timed out")) break;
  }
  // One provider says what it said; several say which said what.
  const reason =
    failures.length === 0
      ? "no provider"
      : args.providers.length === 1
        ? failures[0]!.reason
        : failures.map((f) => (f.reason.startsWith(f.name) ? f.reason : `${f.name}: ${f.reason}`)).join("; then ");
  return withTries({ ok: false, reason, ms: 0 });
}

/**
 * How long an answer from a later provider in the list waits for an earlier
 * one still asking, before it is taken. The order is a preference (the first
 * named is the one wanted), not only a fallback. `JEV_ROUTER_PREFER_MS`
 * overrides it.
 */
export const DEFAULT_PREFER_MS = 300;

/** The grace from the environment, or the default when it is unusable. 0 takes the first answer. */
export function preferOf(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!PLAIN_DECIMAL.test(v)) return DEFAULT_PREFER_MS;
  return Math.min(Number(v), MAX_TIMEOUT_MS);
}

/**
 * How long each later provider waits for the ones before it to answer before
 * it is asked too, when the providers are asked "at once". 0 asks them all
 * together. `JEV_ROUTER_STAGGER_MS` sets it; set it from the answer times
 * `/jev stats` shows per provider.
 */
export const DEFAULT_STAGGER_MS = 0;

/** The stagger from the environment, or the default when it is unusable. */
export function staggerOf(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (!PLAIN_DECIMAL.test(v)) return DEFAULT_STAGGER_MS;
  return Math.min(Number(v), MAX_TIMEOUT_MS);
}

/**
 * Asks the providers side by side within one budget, and answers with the
 * first in list order that answers: a later one that answers sooner waits
 * `preferMs` for an earlier one still asking, then is taken. A provider that
 * times out does not spend the others' time, as it does in `askJevChain`,
 * so `vllm,openrouter` still routes when vLLM is slow.
 *
 * With `staggerMs` 0 every provider is asked at once. Above 0, provider n is
 * asked n × `staggerMs` after the start, or at once when every provider before
 * it has failed, and not at all once an answer is taken: a fast first provider
 * then costs one request instead of one per provider. Each asked provider is
 * billed for its question (about $0.00003 each), taken or not. Every
 * provider's part comes back in `tries`.
 */
export async function askJevRace(args: ChainArgs & { preferMs?: number; staggerMs?: number }): Promise<JevResult> {
  const providers = args.providers;
  if (providers.length <= 1) return askJevChain(args);
  const now = args.now ?? (() => Date.now());
  const started = now();
  const prefer = args.preferMs ?? DEFAULT_PREFER_MS;
  const stagger = args.staggerMs ?? DEFAULT_STAGGER_MS;
  const budget = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: (JevResult | undefined)[] = providers.map(() => undefined);
  const starts: (number | undefined)[] = providers.map(() => undefined);

  return new Promise<JevResult>((resolve) => {
    let done = false;
    let grace: AbortController | null = null;
    // The waits of providers not asked yet, ended when the decision is made.
    const waits = new AbortController();
    const triesOf = (won: number): Try[] =>
      providers.map((p, i): Try => {
        const r = results[i];
        const start = starts[i];
        if (start === undefined) return { name: p.name, outcome: "not asked" };
        if (r === undefined) return { name: p.name, outcome: "pending", start };
        return { name: p.name, outcome: outcomeOf(r, i === won), start, ms: Math.round(r.ms) };
      });
    const finish = (taken: number, result: JevResult) => {
      if (done) return;
      done = true;
      grace?.abort();
      waits.abort();
      resolve({ ...result, ms: now() - started, tries: triesOf(taken) });
    };
    // The index of the answer to take: the first in order that answered,
    // waiting on an earlier one still asking (or not asked yet) unless
    // `skipPending`; -1 for none.
    const pick = (skipPending: boolean): number => {
      for (const [i, r] of results.entries()) {
        if (r === undefined) {
          if (skipPending) continue;
          return -1;
        }
        if (r.ok || r.reason === "ceded") return i;
      }
      return -1;
    };
    const failure = (): JevResult => {
      const failures = providers.map((p, i) => ({ name: p.name, reason: (results[i] as { reason?: string } | undefined)?.reason ?? "no answer" }));
      return {
        ok: false,
        reason: failures.map((f) => (f.reason.startsWith(f.name) ? f.reason : `${f.name}: ${f.reason}`)).join("; "),
        ms: 0,
      };
    };
    const settle = (): void => {
      if (done) return;
      if (results.every((r) => r !== undefined)) {
        const i = pick(true);
        return i >= 0 ? finish(i, results[i]!) : finish(-1, failure());
      }
      const taken = pick(false);
      if (taken >= 0) return finish(taken, results[taken]!);
      // Every provider asked so far has failed: the next is asked now.
      const next = results.findIndex((r, i) => r === undefined && starts[i] === undefined);
      if (next > 0 && results.slice(0, next).every((r) => r !== undefined && !r.ok)) return ask(next);
      if (grace === null && results.some((r) => r?.ok)) {
        grace = new AbortController();
        args.sleep(prefer, { signal: grace.signal }).then(
          () => {
            const late = pick(true);
            if (late >= 0) finish(late, results[late]!);
          },
          () => undefined,
        );
      }
    };
    const ask = (i: number): void => {
      if (done || starts[i] !== undefined || results[i] !== undefined) return;
      const start = now() - started;
      starts[i] = start;
      const left = budget - start;
      if (left < MIN_TIMEOUT_MS) {
        // Too late to ask: it counts as not asked, and as a failure here.
        starts[i] = undefined;
        results[i] = { ok: false, reason: "no time left to ask", ms: 0 };
        return settle();
      }
      askJev({ ...args, provider: providers[i]!, timeoutMs: left }).then(
        (r) => {
          results[i] = r;
          settle();
        },
        (error) => {
          results[i] = { ok: false, reason: messageOf(error), ms: 0 };
          settle();
        },
      );
    };
    providers.forEach((_, i) => {
      if (i === 0 || stagger === 0) return ask(i);
      args.sleep(stagger * i, { signal: waits.signal }).then(
        () => ask(i),
        () => undefined,
      );
    });
  });
}

/** The provider's own error type, when it sent one, for the status line. */
export function providerNoteOf(response: HttpResponseLike): string {
  try {
    const body = JSON.parse(response.text) as { error?: { type?: string } };
    const type = body?.error?.type;
    // It lands in the reply's route line: a short, plain word or nothing.
    if (typeof type !== "string") return "";
    const plain = type.replace(/[^\w.-]/g, "").slice(0, 40);
    return plain === "" ? "" : ` (${plain})`;
  } catch {
    return "";
  }
}
