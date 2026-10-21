/**
 * The model list from Anthropic's Models API (`GET /v1/models`), and what the
 * router takes from it: the window of each tier's model, the efforts it
 * accepts, and whether a newer model has come out for the tier.
 *
 * The list carries no prices, so a newer model is taken for a tier only once
 * it has a price (from the catalog or the built-in table). Until then the
 * router stays on the model it has and says that a newer one is out.
 *
 * The host is fixed: the key goes to api.anthropic.com and nowhere else,
 * whatever `ANTHROPIC_BASE_URL` says. Nothing here touches the engine: the
 * fetch, the store and the clock come in as arguments.
 */

import { fetchText } from "./fetchtext.ts";
import type { HttpInitLike, HttpResponseLike } from "./jev.ts";
import { EFFORTS, TIERS, type Effort, type Tier } from "./policy.ts";

export const MODELS_URL = "https://api.anthropic.com/v1/models";
export const MODELS_VERSION = "2023-06-01";

/** Where the last good list is kept in `$.store`. */
export const MODELS_KEY = "models:v1";

export const MODELS_TTL_MS = 24 * 3_600_000;
export const MODELS_FAIL_BACKOFF_MS = 10 * 60_000;
export const MODELS_TIMEOUT_MS = 3_000;
const MAX_PAGES = 5;
const MAX_MODELS = 500;

const ID = /^[\w.:@/-]{1,100}$/;
const WORD = /^[a-z][a-z0-9_-]{0,31}$/;
const LIFECYCLES = ["active", "deprecated", "retired"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export type ModelInfo = {
  id: string;
  displayName: string;
  /** The API's `line` (`opus`, `fable`, …), or null; never read off the id. */
  line: string | null;
  lifecycle: Lifecycle;
  /** Milliseconds since the epoch; 0 when the API gave none. */
  createdAt: number;
  /** When a deprecated model retires, milliseconds, or null. */
  retiresAt: number | null;
  maxInputTokens: number | null;
  /** The efforts the model accepts, or null when it takes none or the API did not say. */
  efforts: Effort[] | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const supported = (v: unknown): boolean => isRecord(v) && v.supported === true;

function effortsOf(capabilities: unknown): Effort[] | null {
  if (!isRecord(capabilities) || !isRecord(capabilities.effort)) return null;
  const effort = capabilities.effort;
  if (!supported(effort)) return null;
  const levels = EFFORTS.filter((level) => supported(effort[level]));
  return levels.length > 0 ? levels : null;
}

function timeOf(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function modelOf(raw: unknown): ModelInfo | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !ID.test(raw.id)) return null;
  const lifecycle = LIFECYCLES.find((l) => l === raw.lifecycle) ?? "active";
  const max = raw.max_input_tokens;
  return {
    id: raw.id,
    displayName: typeof raw.display_name === "string" ? raw.display_name.slice(0, 80) : raw.id,
    line: typeof raw.line === "string" && WORD.test(raw.line) ? raw.line : null,
    lifecycle,
    createdAt: timeOf(raw.created_at) ?? 0,
    retiresAt: timeOf(raw.retires_at),
    maxInputTokens:
      typeof max === "number" && Number.isInteger(max) && max >= 1_000 && max <= 100_000_000 ? max : null,
    efforts: effortsOf(raw.capabilities),
  };
}

export type PageResult = { models: ModelInfo[]; dropped: number; hasMore: boolean; lastId: string | null };

/** One page of the list. Null when it is not a list at all. */
export function parsePage(raw: unknown): PageResult | null {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return null;
  const models: ModelInfo[] = [];
  let dropped = 0;
  for (const entry of raw.data.slice(0, MAX_MODELS)) {
    const model = modelOf(entry);
    if (model === null) dropped++;
    else models.push(model);
  }
  const lastId = typeof raw.last_id === "string" && ID.test(raw.last_id) ? raw.last_id : null;
  return { models, dropped, hasMore: raw.has_more === true && lastId !== null, lastId };
}

/** A saved list read back: the same checks, since the store is trusted no more than the network. */
function reviveList(raw: unknown): ModelInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ModelInfo[] = [];
  for (const m of raw.slice(0, MAX_MODELS)) {
    if (!isRecord(m)) continue;
    const efforts = Array.isArray(m.efforts)
      ? EFFORTS.filter((e) => (m.efforts as unknown[]).includes(e))
      : null;
    const model = modelOf({
      id: m.id,
      display_name: m.displayName,
      line: m.line,
      lifecycle: m.lifecycle,
      created_at: typeof m.createdAt === "number" && m.createdAt > 0 ? new Date(m.createdAt).toISOString() : undefined,
      retires_at: typeof m.retiresAt === "number" ? new Date(m.retiresAt).toISOString() : undefined,
      max_input_tokens: m.maxInputTokens,
    });
    if (model !== null) out.push({ ...model, efforts: efforts !== null && efforts.length > 0 ? efforts : null });
  }
  return out;
}

export type ModelsStore = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<unknown>;
};

export type LoadModelsArgs = {
  fetch: (url: string, init?: HttpInitLike) => Promise<HttpResponseLike>;
  sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<unknown>;
  store: ModelsStore;
  apiKey: string;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
};

export type ModelsResult = {
  models: ModelInfo[] | null;
  /** `fresh`: just fetched. `cache`: a copy still in date. `stale`: the last good copy, the fetch failed. */
  source: "fresh" | "cache" | "stale" | "none";
  notes: string[];
};

type Saved = { at: number; failedAt?: number; models: unknown };

function savedOf(raw: unknown): Saved | null {
  if (!isRecord(raw) || typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
  const failedAt = typeof raw.failedAt === "number" && Number.isFinite(raw.failedAt) ? raw.failedAt : undefined;
  return { at: raw.at, ...(failedAt !== undefined ? { failedAt } : {}), models: raw.models };
}

/** Every page of the list, or the reason it could not be had. */
async function fetchAll(args: LoadModelsArgs): Promise<{ ok: true; models: ModelInfo[] } | { ok: false; reason: string }> {
  const all: ModelInfo[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url: string = `${MODELS_URL}?limit=1000${after === null ? "" : `&after_id=${encodeURIComponent(after)}`}`;
    const body = await fetchText({
      fetch: args.fetch,
      sleep: args.sleep,
      url,
      headers: { "x-api-key": args.apiKey, "anthropic-version": MODELS_VERSION, accept: "application/json" },
      timeoutMs: args.timeoutMs ?? MODELS_TIMEOUT_MS,
    });
    if (!body.ok) return body;
    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      return { ok: false, reason: "not JSON" };
    }
    const parsed = parsePage(json);
    if (parsed === null) return { ok: false, reason: "not a model list" };
    all.push(...parsed.models);
    if (!parsed.hasMore) return { ok: true, models: all };
    after = parsed.lastId;
  }
  return { ok: true, models: all };
}

/**
 * The model list to use this session. A copy still in date is returned
 * without a request; otherwise it is fetched and saved, and when that fails
 * the last good copy answers, however old, with the reason as a note.
 */
export async function loadModels(args: LoadModelsArgs): Promise<ModelsResult> {
  const now = (args.now ?? Date.now)();
  const ttl = args.ttlMs ?? MODELS_TTL_MS;
  let saved: Saved | null = null;
  try {
    saved = savedOf(await args.store.get(MODELS_KEY));
  } catch {
    saved = null;
  }
  const cached = saved === null ? null : reviveList(saved.models);

  if (cached !== null && saved !== null && now - saved.at >= 0 && now - saved.at < ttl)
    return { models: cached, source: "cache", notes: [] };

  const stale = (reason: string | null): ModelsResult => ({
    models: cached,
    source: cached === null ? "none" : "stale",
    notes: reason === null ? [] : [`models: ${reason}`],
  });

  if (saved?.failedAt !== undefined && now - saved.failedAt >= 0 && now - saved.failedAt < MODELS_FAIL_BACKOFF_MS)
    return stale(null);

  const failed = async (reason: string) => {
    try {
      await args.store.set(MODELS_KEY, { at: saved?.at ?? 0, failedAt: now, models: saved?.models ?? null });
    } catch {
      // A store that will not take it costs a request next session, nothing else.
    }
    return stale(reason);
  };

  const got = await fetchAll(args);
  if (!got.ok) return failed(got.reason);
  if (got.models.length === 0) return failed("the list was empty");
  try {
    await args.store.set(MODELS_KEY, { at: now, models: got.models });
  } catch {
    // As above.
  }
  return { models: got.models, source: "fresh", notes: [] };
}

export type Adoption = {
  /** The model each tier runs on, where it differs from `current`. */
  models: Partial<Record<Tier, string>>;
  /** The window of each tier's model, as the API reports it. */
  windows: Partial<Record<Tier, number>>;
  /** The efforts each tier's model accepts, where the API said. */
  efforts: Partial<Record<Tier, Effort[]>>;
  notes: string[];
};

/**
 * What the list means for the ladder. `current` is the model each tier runs
 * on now; `priced` says whether the router can price a model id.
 *
 * A tier moves to a newer active model of its line only when that model is
 * priced: a model with no price would run with no cost line, and the
 * downgrade and upgrade checks would price it at the old model's rates.
 * Otherwise the tier stays, and the note says what is out.
 */
export function adoptModels(
  list: readonly ModelInfo[],
  current: Record<Tier, string>,
  priced: (id: string) => boolean,
): Adoption {
  const out: Adoption = { models: {}, windows: {}, efforts: {}, notes: [] };
  const byId = new Map(list.map((m) => [m.id.toLowerCase(), m]));
  for (const tier of TIERS) {
    const have = byId.get(current[tier].toLowerCase());
    // Not in the list (a key without access, a model the API does not know):
    // there is nothing to measure "newer" against, and nothing is changed.
    if (have === undefined) {
      out.notes.push(`${tier}: ${current[tier]} is not in the model list`);
      continue;
    }
    const newer = list
      .filter((m) => m.line === tier && m.lifecycle === "active" && m.createdAt > have.createdAt)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const pick = newer.find((m) => priced(m.id));
    // A model newer than the one taken (or than the one run) that cannot be priced yet.
    const waiting = newer.find((m) => !priced(m.id) && m.createdAt > (pick?.createdAt ?? have.createdAt));
    let chosen = have;
    if (pick !== undefined) {
      chosen = pick;
      out.models[tier] = pick.id;
      out.notes.push(`${tier}: ${current[tier]} → ${pick.id}`);
    }
    if (waiting !== undefined)
      out.notes.push(`${tier}: ${waiting.id} is out but has no price yet; staying on ${pick?.id ?? current[tier]}`);
    if (have.lifecycle !== "active") {
      const when = have.retiresAt === null ? "" : ` (retires ${new Date(have.retiresAt).toISOString().slice(0, 10)})`;
      out.notes.push(`${tier}: ${have.id} is ${have.lifecycle}${when}`);
    }
    if (chosen.maxInputTokens !== null) out.windows[tier] = chosen.maxInputTokens;
    if (chosen.efforts !== null) out.efforts[tier] = chosen.efforts;
  }
  return out;
}

/** One line for `/jev`: where the list came from, and what it changed. */
export function modelsLine(result: ModelsResult | null, adoption: Adoption | null, state: "loading" | "no-key" | "off" | "ready"): string {
  if (state === "off") return "off (JEV_ROUTER_MODEL_SYNC=0)";
  if (state === "no-key")
    return "not synced: needs ANTHROPIC_API_KEY (the list is an API call; a Pro or Max login has no key). catalog.json covers the models.";
  if (state === "loading" || result === null) return "loading (the built-in tables answer until it is in)";
  const how =
    result.source === "fresh"
      ? "fetched"
      : result.source === "cache"
        ? "saved list"
        : result.source === "stale"
          ? "saved list, the fetch failed"
          : "none, the built-in tables answer";
  const notes = [...result.notes.map((n) => n.replace(/^models: /, "")), ...(adoption?.notes ?? [])];
  return notes.length > 0 ? `${how} · ${notes.join("; ")}` : how;
}
