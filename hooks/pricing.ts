/**
 * What a turn costs, and what a switch would cost, in dollars.
 *
 * Prices are Anthropic's public list, per million tokens, read from
 * platform.claude.com/docs/en/about-claude/pricing on PRICE_DATE. A cache
 * read is a tenth of input on most models, a fortieth on Fable 5.1 and a
 * twentieth on Opus 5.5 and Sonnet 5.5; a cache write is 1.25× input for the five-minute
 * cache and 2× for the one-hour one. Claude Code writes the one-hour cache
 * (every one of 18,204 writes in a week of this machine's transcripts), so
 * that is the default here.
 *
 * Nothing here touches the engine or the network.
 */

import type { Tier } from "./policy.ts";

export const PRICE_DATE = "2026-10-21";

/** Dollars per million tokens. */
export type Price = {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
  /**
   * Haiku 5.5 is priced by the length of a request's prompt (all its input
   * tokens, cache reads and writes included): past a threshold the whole
   * request pays the tier's prices. Each request is priced on its own.
   */
  tiers?: readonly PriceTier[];
};

/** From more than `abovePromptTokens` in one request's prompt, `price` replaces the base. */
export type PriceTier = { abovePromptTokens: number; price: Omit<Price, "tiers"> };

/** The price a request with `promptTokens` of prompt pays: the highest tier it is over, else the base. */
export function priceAt(price: Price, promptTokens: number): Price {
  let at: Price = price;
  for (const tier of price.tiers ?? [])
    if (promptTokens > tier.abovePromptTokens) at = { ...tier.price };
  return at;
}

export type Ttl = "5m" | "1h";

/**
 * What the catalog says in place of the built-in tables: price by model id,
 * and the price and window of each tier's model. Set once the catalog is in;
 * absent, everything below answers from the tables in this file.
 */
export type Overlay = {
  models: ReadonlyMap<string, Price>;
  ladder: Partial<Record<Tier, Price>>;
  windows: Partial<Record<Tier, number>>;
};

let overlay: Overlay | null = null;

export function setOverlay(next: Overlay | null): void {
  overlay = next;
}

/** The price of the model a tier runs: the catalog's when it has one, else the built-in. */
export function ladderPrice(tier: Tier): Price {
  return overlay?.ladder[tier] ?? PRICE[tier];
}

/** The ladder's models. */
export const PRICE: Record<Tier, Price> = {
  haiku: {
    input: 0.1,
    write5m: 0.125,
    write1h: 0.2,
    read: 0.01,
    output: 0.5,
    tiers: [
      {
        abovePromptTokens: 100_000,
        price: { input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 },
      },
    ],
  },
  sonnet: { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
  opus: { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  fable: { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
};

/**
 * Models the session may run on that are not on the ladder, so an unrouted
 * turn's cost is still right. Matched by prefix of the id the API reports.
 */
const OPUS_4_0: Price = { input: 15, write5m: 18.75, write1h: 30, read: 1.5, output: 75 };
const HAIKU_4_5: Price = { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 };
/** Sonnet 5 reads its cache at a tenth of input; Sonnet 5.5 at a twentieth. */
const SONNET_5_0: Price = { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 };
/** Fable 5 and Mythos 5: Fable 5.1's price, but four times its cache read. */
const FABLE_5_0: Price = { ...PRICE.fable, read: 1 };

// First match wins, so a longer id goes above the prefix it starts with.
const OTHER_PRICE: readonly (readonly [string, Price])[] = [
  ["claude-opus-5-5", PRICE.opus],
  ["claude-opus-5", { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }],
  // Opus 4 and 4.1, and Opus 4's dated id: three times the later 4.x price.
  ["claude-opus-4-0", OPUS_4_0],
  ["claude-opus-4-1", OPUS_4_0],
  ["claude-opus-4-2025", OPUS_4_0],
  ["claude-opus-4", { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 }],
  ["claude-sonnet-5-5", PRICE.sonnet],
  ["claude-sonnet-5", SONNET_5_0],
  ["claude-sonnet-4", { input: 3, write5m: 3.75, write1h: 6, read: 0.3, output: 15 }],
  // Only the version the page prices: a Haiku 5.x it does not list is no
  // guess at 5.5's tiered price.
  ["claude-haiku-5-5", PRICE.haiku],
  ["claude-haiku-4", HAIKU_4_5],
  ["claude-fable-5-1", PRICE.fable],
  ["claude-mythos-5-1", PRICE.fable],
  ["claude-fable-5", FABLE_5_0],
  ["claude-mythos-5", FABLE_5_0],
];

/** The cache TTL from the environment; `1h` unless told `5m`. */
export function ttlOf(raw: string | undefined): Ttl {
  return (raw ?? "").trim().toLowerCase() === "5m" ? "5m" : "1h";
}

/** The price of the model the API named, or null for one we do not know. */
export function priceOfModel(model: string): Price | null {
  if (typeof model !== "string") return null;
  // Bedrock spells an id `us.anthropic.claude-…-v1:0`, Vertex `claude-…@date`:
  // the same model, priced by the id inside.
  const id = model
    .toLowerCase()
    .replace(/^(?:[a-z]{2,}\.)*anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/@\d{8}$/, "");
  // Bare, it is Opus 4.0 (Vertex's `claude-opus-4@date` comes to this).
  if (id === "claude-opus-4") return OPUS_4_0;
  // The catalog names a model by its id; a dated spelling is the same model.
  const listed = overlay?.models.get(id) ?? overlay?.models.get(id.replace(/-\d{8}$/, ""));
  if (listed !== undefined) return listed;
  for (const [prefix, price] of OTHER_PRICE)
    if (id.startsWith(prefix)) return price;
  return null;
}

/**
 * The rung a model id or alias sits on: `claude-opus-5` and `opus` are both
 * opus-class, whatever the session runs. Null for a model off the ladder.
 */
export function tierOfModel(model: string): Tier | null {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase();
  if (id.includes("haiku")) return "haiku";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("opus")) return "opus";
  if (id.includes("fable") || id.includes("mythos")) return "fable";
  return null;
}

/** Token counts as the engine's `TurnUsage` carries them. */
type Tokens = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/**
 * What one turn's requests cost, from the API's own counts. Null when the
 * model is one we have no price for, which is better than a wrong number.
 */
export function usageCost(
  model: string,
  usage: Tokens,
  ttl: Ttl = "1h",
): number | null {
  const base = priceOfModel(model);
  if (base === null) return null;
  // A request's prompt is everything it carried in, cached or not.
  const p = priceAt(
    base,
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
  );
  const write = ttl === "1h" ? p.write1h : p.write5m;
  return (
    (usage.input_tokens * p.input +
      usage.cache_creation_input_tokens * write +
      usage.cache_read_input_tokens * p.read +
      usage.output_tokens * p.output) /
    1e6
  );
}

/**
 * The context window of each tier's model, in tokens: 1M on every model on
 * the ladder (platform.claude.com/docs/en/about-claude/models/overview,
 * 2026-10-21). Haiku 4.5 took 200K, and a week of transcripts held three
 * "Prompt is too long" refusals, each right after a turn at 358k–605k was
 * routed to it; Haiku 5.5 has the full window, though past 100K a request
 * pays its higher prices (see `Price.tiers`). The plain ids the router sends
 * were answered at 737k on fable and 344k on sonnet, so a session with a
 * `[1m]` model is not larger than these.
 */
export const WINDOW_TOKENS: Record<Tier, number> = {
  haiku: 1_000_000,
  sonnet: 1_000_000,
  opus: 1_000_000,
  fable: 1_000_000,
};

/** Room left for the prompt and the reply when a turn is judged to fit. */
const WINDOW_HEADROOM_TOKENS = 16_000;

/** True when a turn carrying `contextTokens` can be sent to `tier` at all. */
export function fitsWindow(tier: Tier, contextTokens: number): boolean {
  return contextTokens + WINDOW_HEADROOM_TOKENS <= windowOf(tier);
}

let syncedWindows: Partial<Record<Tier, number>> = {};

/** The windows the model list reported, for the tiers it named; null forgets them. */
export function setSyncedWindows(windows: Partial<Record<Tier, number>> | null): void {
  syncedWindows = windows ?? {};
}

/** A tier's window: the catalog's when it has one, else the model list's, else the built-in. */
export function windowOf(tier: Tier): number {
  return overlay?.windows[tier] ?? syncedWindows[tier] ?? WINDOW_TOKENS[tier];
}

/** `claude-opus-5-5[1m]` and `claude-opus-5-5` are one model: the suffix is the engine's. */
export function baseModel(model: string): string {
  // By hand, not `/\[[^\]]*\]$/`, which rescans to the end from every `[`.
  if (!model.endsWith("]")) return model;
  const open = model.indexOf("[", model.lastIndexOf("]", model.length - 2) + 1);
  return open === -1 || open === model.length - 1 ? model : model.slice(0, open);
}

/** The model a spelling names: without `[1m]` or a date suffix, so both read as one. */
export function sameModelAs(a: string, b: string): boolean {
  return modelKey(a) === modelKey(b);
}

/**
 * A model's name without its spelling: `[1m]`, a date, and the Bedrock and
 * Vertex wrappings (`us.anthropic.…-v1:0`, an ARN, `…@20260901`, a path)
 * all name the same model as the plain id.
 */
function modelKey(model: string): string {
  let m = baseModel(model).toLowerCase();
  m = m.slice(m.lastIndexOf("/") + 1);
  m = m.replace(/^(?:us|eu|apac|global|au|jp|ca)\./, "").replace(/^anthropic\./, "");
  m = m.replace(/@.*$/, "").replace(/-v\d+(?::\d+)?$/, "").replace(/-\d{8}$/, "");
  return m;
}

/** Ladder order, low to high, for telling a downgrade from an upgrade. */
const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

export function isDowngrade(from: Tier, to: Tier): boolean {
  return RANK[to] < RANK[from];
}

/**
 * The two prices a shaky downgrade is decided between.
 *
 * `stay` is the next turn on the tier already running, warm: its context
 * read from cache plus its output. `go` is the same turn on the cheaper
 * tier, cold: the whole context written to that tier's cache, its output,
 * and then the write that comes due when the session returns to the tier it
 * left, whose cache the detour let go cold (measured over a week of
 * transcripts: 31 of 38 returns from haiku to fable paid it in full).
 *
 * A downgrade that costs more than it saves is held. Output tokens are the
 * only term where the cheaper tier wins, so the balance tips with context:
 * at a few thousand tokens the cheaper output carries it; at the sizes a
 * working session actually runs (150k–330k at the median, measured) the
 * writes are tens of times the output and no downgrade pays.
 */
export type SwitchVerdict = {
  /** Dollars for this turn on the running tier, cache warm. */
  stay: number;
  /** Dollars for this turn on the new tier, cache cold, return write included. */
  go: number;
  /** True when going costs at least as much as staying. */
  hold: boolean;
  /**
   * For an upgrade: the most the move may cost over staying. Absent for a
   * downgrade, which has to pay for itself.
   */
  limit?: number;
};

export function switchVerdict(
  from: Tier,
  to: Tier,
  contextTokens: number,
  outputTokens: number,
  ttl: Ttl = "1h",
  /**
   * The running model's own price when it is not the ladder's model for its
   * tier: a session on `claude-opus-5` reads its cache at $0.50, not the
   * $0.20 of the opus tier's `claude-opus-5-5`.
   */
  fromPrice: Price = ladderPrice(from),
  /** The running model's cache has expired: staying writes it too. */
  fromCold = false,
): SwitchVerdict {
  const write = (p: Price) => (ttl === "1h" ? p.write1h : p.write5m);
  const ctx = contextTokens / 1e6;
  const out = outputTokens / 1e6;
  // The next request's prompt is the whole context, whichever tier it goes to.
  const from_ = priceAt(fromPrice, contextTokens);
  const to_ = priceAt(ladderPrice(to), contextTokens);
  const stay = ctx * (fromCold ? write(from_) : from_.read) + out * from_.output;
  const go = ctx * write(to_) + out * to_.output + ctx * write(from_);
  return { stay, go, hold: go >= stay };
}

/**
 * What moving up from `from` to `to` costs this turn, against staying. Going
 * writes the whole context to the dearer tier's cache and pays its output
 * price; staying reads the warm cache. The way back is not counted: it may
 * never happen, and if it does, the downgrade is priced then. The move is
 * held when it costs more than `limit` over staying.
 */
export function upgradeVerdict(
  from: Tier,
  to: Tier,
  contextTokens: number,
  outputTokens: number,
  limit: number,
  ttl: Ttl = "1h",
  fromPrice: Price = ladderPrice(from),
  /** The running model's cache has expired: staying writes it too. */
  fromCold = false,
): SwitchVerdict {
  const write = (p: Price) => (ttl === "1h" ? p.write1h : p.write5m);
  const ctx = contextTokens / 1e6;
  const out = outputTokens / 1e6;
  const from_ = priceAt(fromPrice, contextTokens);
  const to_ = priceAt(ladderPrice(to), contextTokens);
  const stay = ctx * (fromCold ? write(from_) : from_.read) + out * from_.output;
  const go = ctx * write(to_) + out * to_.output;
  return { stay, go, hold: go - stay > limit, limit };
}

/**
 * The context size below which a downgrade from `from` to `to` still pays,
 * for a turn of `outputTokens`. Shown in the status report so the bar is
 * visible; zero when no context is small enough.
 */
export function breakEvenTokens(
  from: Tier,
  to: Tier,
  outputTokens: number,
  ttl: Ttl = "1h",
  /** The running model's own price, as in `switchVerdict`. */
  fromPrice: Price = ladderPrice(from),
  /** The running model's cache has expired, as in `switchVerdict`. */
  fromCold = false,
): number {
  const write = (p: Price) => (ttl === "1h" ? p.write1h : p.write5m);
  // stay = ctx·read(from) + out·output(from); go = ctx·(write(to)+write(from)) + out·output(to)
  // go < stay  ⇔  ctx·(write(to)+write(from)−read(from)) < out·(output(from)−output(to))
  // Cold, staying writes too: read(from) becomes write(from).
  // A tiered price changes with the context, so the line is solved region by
  // region between the tiers' thresholds, and the largest context that pays wins.
  const edges = [
    ...new Set([0, ...(fromPrice.tiers ?? []).map((t) => t.abovePromptTokens), ...(ladderPrice(to).tiers ?? []).map((t) => t.abovePromptTokens)]),
  ].sort((x, y) => x - y);
  let best = 0;
  edges.forEach((lo, i) => {
    const hi = edges[i + 1] ?? Infinity;
    // Prices that apply from just past `lo` (a tier starts above its threshold).
    const f = priceAt(fromPrice, lo + 1);
    const t = priceAt(ladderPrice(to), lo + 1);
    const perCtx = write(t) + write(f) - (fromCold ? write(f) : f.read);
    const perOut = f.output - t.output;
    if (perOut <= 0 || perCtx <= 0) return;
    const x = Math.floor((outputTokens * perOut) / perCtx);
    // Pays up to x; the region caps it at hi, and it counts only if some context in it pays.
    if (x > lo) best = Math.max(best, Math.min(x, hi));
  });
  return best;
}

/** `$4.41`, `$0.36`, `$0.024`, `$0.0035`: enough places to show a small turn. */
export function usd(n: number): string {
  // Decided on the rounded figure: $0.09999 is $0.10, not $0.100.
  if (Number(n.toFixed(3)) >= 0.1) return `$${n.toFixed(2)}`;
  if (Number(n.toFixed(4)) >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}
