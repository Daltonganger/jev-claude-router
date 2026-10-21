/**
 * The catalog: model prices, windows and what a plan covers, kept as one JSON
 * file on GitHub (`catalog.json` at the repo root) so a change there reaches
 * every install without a new plugin version.
 *
 * The file is data and nothing else. It cannot name an endpoint, a host or a
 * key: where a key goes stays in `provider.ts`. Every value is checked and
 * bounded on the way in, a bad entry is dropped on its own (the built-in
 * table answers for it), and a file that does not parse at all is ignored in
 * favour of the last good copy. The fetch happens at session start, never in
 * a turn.
 *
 * Nothing here touches the engine: the fetch, the store and the clock come
 * in as arguments.
 */

import { fetchText } from "./fetchtext.ts";
import type { HttpInitLike, HttpResponseLike } from "./jev.ts";
import { MODEL_OF, TIERS } from "./policy.ts";
import { priceAt, type Overlay, type Price, type PriceTier } from "./pricing.ts";

/** The format this module reads. A file that says a higher number is ignored. */
export const CATALOG_SCHEMA = 1;

export const CATALOG_URL_DEFAULT =
  "https://raw.githubusercontent.com/Daltonganger/jev-claude-router/main/catalog.json";

/** Hosts a catalog may come from unless `JEV_ROUTER_ALLOW_CUSTOM_CATALOG=1`. */
const CATALOG_HOSTS = ["raw.githubusercontent.com"];

/** Where the last good copy is kept in `$.store`. */
export const CATALOG_KEY = "catalog:v1";

export const DEFAULT_TTL_MS = 6 * 3_600_000;
/** After a failed fetch, no new try for this long: an offline start costs one timeout, not one per session. */
export const FAIL_BACKOFF_MS = 10 * 60_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

// Bounds. A value outside them did not come from a person who meant it.
const MAX_PRICE = 1_000;
const MIN_WINDOW = 1_000;
const MAX_WINDOW = 100_000_000;
const MAX_MODELS = 500;
const MAX_TIERS = 4;
/** A price that moves by more than this factor between two copies is reported. */
export const PRICE_JUMP_FACTOR = 4;

const ID = /^[\w.:@/-]{1,100}$/;
/** A model id a decider answers to (`jev-1.14.0`, `typesafe/jev-1.14`): segments, never a URL. */
const DECIDER_ID = /^[\w.:@-]{1,60}(?:\/[\w.:@-]{1,60}){0,2}$/;
const WORD = /^[a-z][a-z0-9_-]{0,31}$/;

/** Dollars per million tokens, the same fields as pricing.ts. */
export type CatalogPrice = Omit<Price, "tiers">;

export type { PriceTier };

export type CatalogModel = {
  /** `haiku`, `sonnet`, `opus`, `fable`, `mythos`: the API's `line`. */
  line: string;
  maxInputTokens?: number;
  price?: CatalogPrice;
  priceTiers?: PriceTier[];
};

export type CatalogPlan = { excludeLines: string[]; note?: string };

/** The model ids a decider is reachable under; which host serves them is not the catalog's to say. */
export type CatalogDecider = Record<string, string>;

export type Catalog = {
  schema: number;
  updated: string;
  models: Record<string, CatalogModel>;
  plans: Record<string, CatalogPlan>;
  deciders: Record<string, CatalogDecider>;
};

export type ParseResult =
  | { ok: true; catalog: Catalog; dropped: string[] }
  | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

function priceOf(raw: unknown): CatalogPrice | null {
  if (!isRecord(raw)) return null;
  const { input, write5m, write1h, read, output } = raw;
  if (
    !inRange(input, 0, MAX_PRICE) ||
    !inRange(write5m, 0, MAX_PRICE) ||
    !inRange(write1h, 0, MAX_PRICE) ||
    !inRange(read, 0, MAX_PRICE) ||
    !inRange(output, 0, MAX_PRICE)
  )
    return null;
  return { input, write5m, write1h, read, output };
}

function tiersOf(raw: unknown): PriceTier[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TIERS) return null;
  const out: PriceTier[] = [];
  for (const t of raw) {
    if (!isRecord(t) || !inRange(t.abovePromptTokens, 1, MAX_WINDOW)) return null;
    const price = priceOf(t);
    if (price === null) return null;
    out.push({ abovePromptTokens: t.abovePromptTokens, price });
  }
  // A tier that does not climb would never be the one that applies.
  for (let i = 1; i < out.length; i++)
    if (out[i]!.abovePromptTokens <= out[i - 1]!.abovePromptTokens) return null;
  return out;
}

function modelOf(raw: unknown): CatalogModel | null {
  if (!isRecord(raw) || typeof raw.line !== "string" || !WORD.test(raw.line)) return null;
  const model: CatalogModel = { line: raw.line };
  if (raw.maxInputTokens !== undefined) {
    if (!inRange(raw.maxInputTokens, MIN_WINDOW, MAX_WINDOW) || !Number.isInteger(raw.maxInputTokens))
      return null;
    model.maxInputTokens = raw.maxInputTokens;
  }
  if (raw.price !== undefined) {
    const price = priceOf(raw.price);
    if (price === null) return null;
    model.price = price;
  }
  if (raw.priceTiers !== undefined) {
    // Tiers replace a base price, so they are no use without one.
    const tiers = tiersOf(raw.priceTiers);
    if (tiers === null || model.price === undefined) return null;
    model.priceTiers = tiers;
  }
  return model;
}

function deciderOf(raw: unknown): CatalogDecider | null {
  if (!isRecord(raw)) return null;
  const out: CatalogDecider = {};
  for (const [name, id] of Object.entries(raw)) {
    if (!WORD.test(name) || typeof id !== "string" || !DECIDER_ID.test(id)) return null;
    out[name] = id;
  }
  return out;
}

/**
 * Reads a catalog from parsed JSON. Null-safe on anything: a file that is not
 * a catalog, or is a newer format than this reads, is refused whole; an entry
 * that is wrong is dropped alone and named in `dropped`.
 */
export function parseCatalog(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, reason: "not an object" };
  if (typeof raw.schema !== "number" || !Number.isInteger(raw.schema) || raw.schema < 1)
    return { ok: false, reason: "no schema number" };
  if (raw.schema > CATALOG_SCHEMA)
    return { ok: false, reason: `schema ${raw.schema} is newer than this plugin reads (${CATALOG_SCHEMA})` };

  const dropped: string[] = [];
  const models: Record<string, CatalogModel> = {};
  const rawModels = isRecord(raw.models) ? raw.models : {};
  let seen = 0;
  for (const [id, entry] of Object.entries(rawModels)) {
    if (++seen > MAX_MODELS) {
      dropped.push(`models beyond ${MAX_MODELS}`);
      break;
    }
    const model = ID.test(id) ? modelOf(entry) : null;
    if (model === null) dropped.push(`model ${id.slice(0, 60)}`);
    else models[id] = model;
  }

  const plans: Record<string, CatalogPlan> = {};
  for (const [name, entry] of Object.entries(isRecord(raw.plans) ? raw.plans : {})) {
    const lines = isRecord(entry) ? entry.excludeLines : undefined;
    if (
      !WORD.test(name) ||
      !Array.isArray(lines) ||
      lines.length > 16 ||
      !lines.every((l) => typeof l === "string" && WORD.test(l))
    )
      dropped.push(`plan ${name.slice(0, 60)}`);
    else {
      const note = isRecord(entry) && typeof entry.note === "string" ? entry.note.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      plans[name] = { excludeLines: [...lines] as string[], ...(note !== "" ? { note } : {}) };
    }
  }

  const deciders: Record<string, CatalogDecider> = {};
  for (const [name, entry] of Object.entries(isRecord(raw.deciders) ? raw.deciders : {})) {
    const decider = WORD.test(name) ? deciderOf(entry) : null;
    if (decider === null) dropped.push(`decider ${name.slice(0, 60)}`);
    else deciders[name] = decider;
  }

  const updated = typeof raw.updated === "string" ? raw.updated.slice(0, 32) : "";
  return { ok: true, catalog: { schema: raw.schema, updated, models, plans, deciders }, dropped };
}

/**
 * Models whose price moved by more than `factor` (either way) from one copy to
 * the next, in any field. A typo in the file shows here instead of rerouting
 * everyone's sessions in silence; the new copy is still the one used.
 */
export function priceJumps(
  before: Catalog,
  after: Catalog,
  factor: number = PRICE_JUMP_FACTOR,
): string[] {
  const out: string[] = [];
  for (const [id, now] of Object.entries(after.models)) {
    const was = before.models[id]?.price;
    if (was === undefined || now.price === undefined) continue;
    const moved = (Object.keys(now.price) as (keyof CatalogPrice)[]).some((k) => {
      const a = was[k];
      const b = now.price![k];
      if (a === b) return false;
      if (a === 0 || b === 0) return true;
      return Math.max(a, b) / Math.min(a, b) > factor;
    });
    if (moved) out.push(id);
  }
  return out;
}

/** The price a request pays on `model`: the tier its prompt reaches, else the base. Null with no base price. */
export function priceForPrompt(model: CatalogModel, promptTokens: number): Price | null {
  if (model.price === undefined) return null;
  return priceAt(pricedModel(model), promptTokens);
}

/** The model's prices as pricing.ts holds them: the base with its tiers. Null with no base price. */
export function pricedModel(model: CatalogModel): Price {
  const price = model.price!;
  return model.priceTiers !== undefined && model.priceTiers.length > 0
    ? { ...price, tiers: model.priceTiers }
    : { ...price };
}

/** The lines a plan leaves out, or none for a plan the catalog does not know. */
export function excludedLinesOf(catalog: Catalog | null, plan: string | undefined): string[] {
  const p = (plan ?? "").trim().toLowerCase();
  return catalog?.plans[p]?.excludeLines ?? [];
}

const flagOff = (raw: string | undefined) =>
  ["0", "false", "no", "off", "none"].includes((raw ?? "").trim().toLowerCase());
const flagOn = (raw: string | undefined) =>
  ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());

/** `JEV_ROUTER_CATALOG`: on unless `0`, `false`, `no`, `off` or `none`. */
export function catalogOnOf(raw: string | undefined): boolean {
  return !flagOff(raw);
}

/**
 * `JEV_ROUTER_CATALOG_URL`, or the default. https only, and only from GitHub's
 * raw host unless `JEV_ROUTER_ALLOW_CUSTOM_CATALOG=1`: the catalog sets prices,
 * so where it comes from is not left to a mistyped setting.
 */
export function catalogUrlOf(
  raw: string | undefined,
  allowCustom: string | undefined,
): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, url: CATALOG_URL_DEFAULT };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "JEV_ROUTER_CATALOG_URL is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "JEV_ROUTER_CATALOG_URL must use https" };
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "JEV_ROUTER_CATALOG_URL must not carry a login" };
  if (!CATALOG_HOSTS.includes(url.hostname.toLowerCase()) && !flagOn(allowCustom))
    return {
      ok: false,
      reason:
        "JEV_ROUTER_CATALOG_URL host is not allowlisted; set " +
        "JEV_ROUTER_ALLOW_CUSTOM_CATALOG=1 to permit it",
    };
  return { ok: true, url: url.href };
}

/** `JEV_ROUTER_CATALOG_TTL_HOURS`: hours to keep a fetched copy; the default when unset or unusable. */
export function catalogTtlOf(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  const hours = Number(v);
  if (!/^\d+(\.\d+)?$/.test(v) || !(hours >= 0.1)) return DEFAULT_TTL_MS;
  return Math.min(hours, 24 * 30) * 3_600_000;
}

export type CatalogStore = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<unknown>;
};

export type LoadArgs = {
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<unknown>;
  store: CatalogStore;
  url: string;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
};

export type LoadResult = {
  /** The copy to use, or null when there is none and the built-in table answers. */
  catalog: Catalog | null;
  /** `fresh`: just fetched. `cache`: a copy still in date. `stale`: the last good copy, the fetch failed. */
  source: "fresh" | "cache" | "stale" | "none";
  /** Things worth a line in the status: why a fetch failed, what was dropped, prices that jumped. */
  notes: string[];
};

type Saved = { at: number; url: string; failedAt?: number; catalog: unknown };

function savedOf(raw: unknown): Saved | null {
  if (!isRecord(raw) || !inRange(raw.at, 0, Number.MAX_SAFE_INTEGER) || typeof raw.url !== "string")
    return null;
  const failedAt = inRange(raw.failedAt, 0, Number.MAX_SAFE_INTEGER) ? raw.failedAt : undefined;
  return { at: raw.at, url: raw.url, ...(failedAt !== undefined ? { failedAt } : {}), catalog: raw.catalog };
}

async function readSaved($: CatalogStore): Promise<Saved | null> {
  try {
    return savedOf(await $.get(CATALOG_KEY));
  } catch {
    return null;
  }
}

/** The last good copy, parsed again: the store is not trusted more than the network. */
function cachedCatalog(saved: Saved | null, url: string): Catalog | null {
  if (saved === null || saved.url !== url) return null;
  const parsed = parseCatalog(saved.catalog);
  return parsed.ok ? parsed.catalog : null;
}

/**
 * The catalog to use this session. A copy still in date is returned without a
 * request. Otherwise it is fetched, checked, and saved; when that fails the
 * last good copy answers, however old, and the reason is a note.
 */
export async function loadCatalog(args: LoadArgs): Promise<LoadResult> {
  const now = (args.now ?? Date.now)();
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS;
  const saved = await readSaved(args.store);
  const cached = cachedCatalog(saved, args.url);

  if (cached !== null && saved !== null && now - saved.at >= 0 && now - saved.at < ttl)
    return { catalog: cached, source: "cache", notes: [] };

  const stale = (reason: string): LoadResult => ({
    catalog: cached,
    source: cached === null ? "none" : "stale",
    notes: [`catalog: ${reason}`],
  });

  if (saved !== null && saved.url === args.url && saved.failedAt !== undefined && now - saved.failedAt >= 0 && now - saved.failedAt < FAIL_BACKOFF_MS)
    return { catalog: cached, source: cached === null ? "none" : "stale", notes: [] };

  const remember = async (value: Saved) => {
    try {
      await args.store.set(CATALOG_KEY, value);
    } catch {
      // A store that will not take it costs a fetch next session, nothing else.
    }
  };
  const failed = async (reason: string) => {
    await remember({
      at: saved?.url === args.url ? saved.at : 0,
      url: args.url,
      failedAt: now,
      catalog: saved?.url === args.url ? saved.catalog : null,
    });
    return stale(reason);
  };

  const body = await fetchText({
    fetch: args.fetch,
    sleep: args.sleep,
    url: args.url,
    headers: { accept: "application/json" },
    timeoutMs: args.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  });
  if (!body.ok) return failed(body.reason);

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return failed("not JSON");
  }
  const parsed = parseCatalog(json);
  if (!parsed.ok) return failed(parsed.reason);

  await remember({ at: now, url: args.url, catalog: json });
  const notes: string[] = [];
  if (parsed.dropped.length > 0) notes.push(`catalog: ignored ${parsed.dropped.join(", ")}`);
  if (cached !== null) {
    const jumps = priceJumps(cached, parsed.catalog);
    if (jumps.length > 0) notes.push(`catalog: price moved more than ${PRICE_JUMP_FACTOR}× for ${jumps.join(", ")}`);
  }
  return { catalog: parsed.catalog, source: "fresh", notes };
}

/** What the pricing functions read from a catalog: prices by id, and each tier's model. */
export function overlayOf(catalog: Catalog): Overlay {
  const models = new Map<string, Price>();
  for (const [id, model] of Object.entries(catalog.models))
    if (model.price !== undefined) models.set(id.toLowerCase(), pricedModel(model));
  const ladder: Overlay["ladder"] = {};
  const windows: Overlay["windows"] = {};
  for (const tier of TIERS) {
    const model = catalog.models[MODEL_OF[tier]];
    if (model?.price !== undefined) ladder[tier] = pricedModel(model);
    if (model?.maxInputTokens !== undefined) windows[tier] = model.maxInputTokens;
  }
  return { models, ladder, windows };
}

/** One line for `/jev`: where the catalog came from, and how old its data is. */
export function catalogLine(result: LoadResult | null, loading: boolean): string {
  if (result === null) return loading ? "loading (the built-in tables answer until it is in)" : "not loaded";
  const how =
    result.source === "fresh"
      ? "fetched"
      : result.source === "cache"
        ? "saved copy"
        : result.source === "stale"
          ? "saved copy, the fetch failed"
          : "none, the built-in tables answer";
  const on = result.catalog === null ? "" : result.catalog.updated === "" ? "" : ` · data from ${result.catalog.updated}`;
  const notes = result.notes.length > 0 ? ` · ${result.notes.map((n) => n.replace(/^catalog: /, "")).join("; ")}` : "";
  return `${how}${on}${notes}`;
}
