/**
 * The ledger: one small record per routed turn, kept in the plugin's store so
 * the router can say how it has done over days, not only this session, and so
 * the person's own verdicts (`/jev right`, `/jev wrong opus`) collect into a
 * labelled set from real sessions for `npm run bench:ledger`.
 *
 * Records sit in one store key per day (`ledger:2026-10-25`), so a turn writes
 * only today's. The store holds at most 4 MiB for everything the plugin keeps,
 * session snapshots included, so the ledger is bounded: LEDGER_DAYS days and
 * LEDGER_MAX records in all, the prompt cut at LEDGER_PROMPT characters (the
 * export finds the whole prompt again in the session's transcript).
 *
 * Nothing here touches the engine: the store is passed in, so this runs under
 * plain `node` in tests.
 */

import type { Usage } from "./status.ts";
import { MODEL_OF, TIERS, type Decision, type Effort, type Tier } from "./policy.ts";
import { usageCost, type Ttl } from "./pricing.ts";

export const LEDGER_PREFIX = "ledger:";
export const LEDGER_DAYS = 30;
export const LEDGER_MAX = 1500;
export const LEDGER_PER_DAY = 400;
export const LEDGER_PROMPT = 200;

export type LedgerEntry = {
  /** The turn's id; a step's usage finds its record by it. */
  id: string;
  /** The session, so the export can find the whole prompt in its transcript. */
  session?: string;
  /** When the turn started, ms since the epoch. */
  at: number;
  prompt: string;
  /** What started the turn, when not a typed prompt (see Attempt.kind). */
  kind?: "notify" | "agent" | "continue" | "nudge";
  /** The tier the decision model named, when one was asked this turn. */
  jev?: Tier;
  /** Its confidence in that tier. */
  confidence?: number;
  /** Who answered: Jev, Laya, or another decision model's id. */
  decider?: string;
  /** How long the decision took, ms. */
  ms: number;
  /** What ran. */
  tier?: Tier;
  model?: string;
  effort?: Effort;
  /** Held on the running tier instead of the one named (doubt, price, window). */
  held?: true;
  /** The tier was named in the prompt itself. */
  forced?: true;
  /** Ran on an earlier turn's decision without asking (a go-ahead, a nudge). */
  continued?: true;
  /** Why the turn was not routed, when it was not. */
  skipped?: string;
  /** Dollars at list price, and the tokens, summed over the turn's steps. */
  cost?: number;
  tokens?: { in: number; out: number; read: number; write: number };
  /** The person's verdict: the tier the turn should have run on. */
  label?: Tier;
};

export type Store = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<unknown>;
  delete?: (key: string) => Promise<unknown>;
  keys?: () => Promise<string[]>;
};

/** `ledger:YYYY-MM-DD` for a time, in UTC so a day is the same day on every machine. */
export function dayKey(at: number): string {
  return `${LEDGER_PREFIX}${new Date(at).toISOString().slice(0, 10)}`;
}

/** The ledger flag: on unless `0`, `false`, `off` or `no`. */
export function ledgerOn(raw: string | undefined): boolean {
  return !["0", "false", "off", "no"].includes((raw ?? "").trim().toLowerCase());
}

/** The decision's own pick: the tier named, which a held turn did not run on. */
function pickOf(d: Decision): Tier {
  return d.held ?? d.tier;
}

/** A turn's record from its decision (or why it had none), before any usage. */
export function entryOf(
  attempt: { prompt: string; ms: number; kind?: LedgerEntry["kind"]; continued?: true; decision?: Decision; skipped?: string },
  id: string,
  at: number,
  session?: string,
): LedgerEntry {
  const entry: LedgerEntry = { id, at, prompt: attempt.prompt.slice(0, LEDGER_PROMPT), ms: Math.round(attempt.ms) };
  if (session) entry.session = session;
  if (attempt.kind) entry.kind = attempt.kind;
  if (attempt.continued) entry.continued = true;
  const d = attempt.decision;
  if (d) {
    entry.tier = d.tier;
    entry.model = d.model;
    entry.effort = d.effort;
    if (d.held) entry.held = true;
    if (d.forced) entry.forced = true;
    // Jev was asked unless the tier was named or the turn rode an earlier decision.
    if (!d.forced && !attempt.continued) {
      entry.jev = pickOf(d);
      entry.confidence = Math.round(d.confidence * 1000) / 1000;
      entry.decider = d.decider ?? "Jev";
    }
  } else if (attempt.skipped !== undefined) {
    entry.skipped = attempt.skipped.slice(0, 120);
  }
  return entry;
}

/** The record with the turn's usage folded in (the attempt's running totals). */
export function withUsage(entry: LedgerEntry, usage: Usage | undefined, cost: number | undefined): LedgerEntry {
  const out = { ...entry };
  if (usage) {
    out.tokens = {
      in: usage.input_tokens,
      out: usage.output_tokens,
      read: usage.cache_read_input_tokens,
      write: usage.cache_creation_input_tokens,
    };
    // What answered, as the API said: a fallback model, or the same one.
    out.model = usage.model;
  }
  if (cost === undefined) delete out.cost;
  else out.cost = Math.round(cost * 1e6) / 1e6;
  return out;
}

function listOf(raw: unknown): LedgerEntry[] {
  return Array.isArray(raw)
    ? raw.filter((e): e is LedgerEntry => typeof e === "object" && e !== null && typeof e.id === "string" && typeof e.at === "number")
    : [];
}

/** Writes `entry` into its day, replacing the record with its id. */
export async function put(store: Store, entry: LedgerEntry, key: string = dayKey(entry.at)): Promise<void> {
  const list = listOf(await store.get(key));
  const at = list.findIndex((e) => e.id === entry.id);
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  await store.set(key, list.slice(-LEDGER_PER_DAY));
}

/** Updates the record `id` in its day (or yesterday's, for a turn that crossed midnight). False when none was found. */
export async function update(store: Store, id: string, now: number, change: (e: LedgerEntry) => LedgerEntry): Promise<boolean> {
  for (const key of [dayKey(now), dayKey(now - 86_400_000)]) {
    const list = listOf(await store.get(key));
    const at = list.findIndex((e) => e.id === id);
    if (at < 0) continue;
    list[at] = change(list[at]!);
    await store.set(key, list);
    return true;
  }
  return false;
}

/** The ledger's day keys, oldest first. */
async function dayKeys(store: Store, now: number): Promise<string[]> {
  if (store.keys) return (await store.keys()).filter((k) => k.startsWith(LEDGER_PREFIX)).sort();
  // Without a key list: the days the ledger can hold.
  const keys: string[] = [];
  for (let d = LEDGER_DAYS - 1; d >= 0; d--) keys.push(dayKey(now - d * 86_400_000));
  return keys;
}

/** Every record since `since` (ms), oldest first. */
export async function readSince(store: Store, since: number, now: number): Promise<LedgerEntry[]> {
  const first = dayKey(since);
  const out: LedgerEntry[] = [];
  for (const key of await dayKeys(store, now)) {
    if (key < first) continue;
    for (const e of listOf(await store.get(key))) if (e.at >= since) out.push(e);
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Labels the latest turn the decision model was asked about. `tier` is the
 * person's verdict; `"right"` agrees with the tier it named. Null when no such
 * turn is in the last two days.
 */
export async function label(store: Store, verdict: Tier | "right", now: number): Promise<LedgerEntry | null> {
  for (const key of [dayKey(now), dayKey(now - 86_400_000)]) {
    const list = listOf(await store.get(key));
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (e.jev === undefined) continue;
      const tier = verdict === "right" ? e.jev : verdict;
      list[i] = { ...e, label: tier };
      await store.set(key, list);
      return list[i]!;
    }
  }
  return null;
}

/** Drops days past LEDGER_DAYS, then the oldest days until at most LEDGER_MAX records remain. Returns how many days went. */
export async function prune(store: Store, now: number): Promise<number> {
  if (!store.delete) return 0;
  const cutoff = dayKey(now - LEDGER_DAYS * 86_400_000);
  const keys = await dayKeys(store, now);
  let dropped = 0;
  const counts: [string, number][] = [];
  for (const key of keys) {
    if (key < cutoff) {
      await store.delete(key);
      dropped++;
      continue;
    }
    counts.push([key, listOf(await store.get(key)).length]);
  }
  let total = counts.reduce((n, [, c]) => n + c, 0);
  // Today is never dropped for the cap.
  while (total > LEDGER_MAX && counts.length > 1) {
    const [key, c] = counts.shift()!;
    await store.delete(key);
    total -= c;
    dropped++;
  }
  return dropped;
}

// ------------------------------------------------------------------ stats

const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export type LedgerStats = {
  turns: number;
  /** Turns the decision model was asked about and answered. */
  asked: number;
  unrouted: number;
  reasons: [string, number][];
  ran: Partial<Record<Tier, number>>;
  deciders: [string, number][];
  held: number;
  medianMs: number | null;
  spent: number;
  /** Turns with tokens, and what they would have cost on one tier throughout. */
  priced: number;
  always: Partial<Record<Tier, number>>;
  labelled: number;
  agree: number;
  tooLow: number;
  tooHigh: number;
  byDecider: [string, { labelled: number; agree: number }][];
};

/** A failure reason without its numbers, so alike ones group. */
function reasonKey(text: string): string {
  return text.replace(/ after \d+ms/g, "").slice(0, 60);
}

export function statsOf(entries: readonly LedgerEntry[], ttl: Ttl = "1h"): LedgerStats {
  const ran: Partial<Record<Tier, number>> = {};
  const deciders = new Map<string, number>();
  const reasons = new Map<string, number>();
  const byDecider = new Map<string, { labelled: number; agree: number }>();
  const always: Partial<Record<Tier, number>> = {};
  let asked = 0, unrouted = 0, held = 0, spent = 0, priced = 0, labelled = 0, agree = 0, tooLow = 0, tooHigh = 0;
  const ms: number[] = [];
  for (const e of entries) {
    if (e.tier) ran[e.tier] = (ran[e.tier] ?? 0) + 1;
    if (e.held) held++;
    if (e.skipped !== undefined) {
      unrouted++;
      const k = reasonKey(e.skipped);
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
    if (e.jev) {
      asked++;
      ms.push(e.ms);
      const who = e.decider ?? "Jev";
      deciders.set(who, (deciders.get(who) ?? 0) + 1);
    }
    if (typeof e.cost === "number") spent += e.cost;
    if (e.tokens) {
      const usage = {
        input_tokens: e.tokens.in,
        output_tokens: e.tokens.out,
        cache_read_input_tokens: e.tokens.read,
        cache_creation_input_tokens: e.tokens.write,
      };
      const costs = TIERS.map((t) => [t, usageCost(MODEL_OF[t], usage, ttl)] as const);
      if (costs.every(([, c]) => c !== null)) {
        priced++;
        for (const [t, c] of costs) always[t] = (always[t] ?? 0) + (c as number);
      }
    }
    if (e.label && e.jev) {
      labelled++;
      const who = e.decider ?? "Jev";
      const row = byDecider.get(who) ?? { labelled: 0, agree: 0 };
      row.labelled++;
      if (e.label === e.jev) {
        agree++;
        row.agree++;
      } else if (RANK[e.jev] < RANK[e.label]) tooLow++;
      else tooHigh++;
      byDecider.set(who, row);
    }
  }
  return {
    turns: entries.length,
    asked,
    unrouted,
    reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3),
    ran,
    deciders: [...deciders].sort((a, b) => b[1] - a[1]),
    held,
    medianMs: median(ms),
    spent,
    priced,
    always,
    labelled,
    agree,
    tooLow,
    tooHigh,
    byDecider: [...byDecider].sort((a, b) => b[1].labelled - a[1].labelled),
  };
}

/** `24h`, `7d`, `30d` → ms and a name; null for anything else. */
export function windowOf(raw: string): { ms: number; name: string } | null {
  const m = /^(\d{1,3})\s*(h|d)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  const days = m[2] === "d" ? n : n / 24;
  if (days > LEDGER_DAYS) return null;
  return { ms: n * (m[2] === "h" ? 3_600_000 : 86_400_000), name: m[2] === "h" ? `${n} hours` : `${n} days` };
}

const pct = (n: number, of: number) => (of === 0 ? "—" : `${Math.round((100 * n) / of)}%`);
const money = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

/** The reply to `/jev stats`. */
export function statsReport(s: LedgerStats, window: string): string {
  const lines = ["", `  Last ${window}:`];
  if (s.turns === 0) {
    lines.push("  No routed turns in this window yet.");
    return lines.join("\n");
  }
  const ran = TIERS.filter((t) => s.ran[t]).map((t) => `${t} ${s.ran[t]} (${pct(s.ran[t]!, s.turns)})`).join(" · ");
  lines.push(`  turns     ${s.turns}${ran ? ` — ${ran}` : ""}`);
  lines.push(
    `  decided   ${s.asked} by ${s.deciders.map(([who, n]) => `${who} ${n}`).join(", ") || "nobody"}` +
      (s.medianMs !== null ? `, median ${Math.round(s.medianMs)}ms` : "") +
      (s.held ? ` · ${s.held} held on the running tier` : ""),
  );
  if (s.unrouted)
    lines.push(`  unrouted  ${s.unrouted} (${pct(s.unrouted, s.turns)})${s.reasons.length ? `: ${s.reasons.map(([r, n]) => `${r} ×${n}`).join("; ")}` : ""}`);
  if (s.priced) {
    const vs = (["sonnet", "opus"] as const).filter((t) => s.always[t]).map((t) => `always ${t} ${money(s.always[t]!)}`).join(", ");
    lines.push(`  spent     ${money(s.spent)} at list price${vs ? `; the same tokens on ${vs}` : ""}`);
  } else if (s.spent) {
    lines.push(`  spent     ${money(s.spent)} at list price`);
  }
  if (s.labelled) {
    lines.push(
      `  verdicts  ${s.labelled} labelled: ${pct(s.agree, s.labelled)} right, ${s.tooLow} too low, ${s.tooHigh} too high` +
        (s.byDecider.length > 1 ? ` (${s.byDecider.map(([who, r]) => `${who} ${pct(r.agree, r.labelled)} of ${r.labelled}`).join(", ")})` : ""),
    );
  } else {
    lines.push("  verdicts  none yet: /jev right or /jev wrong <tier> after a turn labels it");
  }
  lines.push("", "  The \"always\" figures price this window's tokens on one tier; the cache a switch costs is not in them.");
  return lines.join("\n");
}

/** The reply to `/jev right` and `/jev wrong <tier>`. */
export function labelReply(entry: LedgerEntry | null, verdict: Tier | "right"): string {
  if (entry === null) return "No routed turn in the last two days to label: the ledger keeps turns Jev was asked about.";
  const said = `${entry.decider ?? "Jev"} said ${entry.jev}`;
  const prompt = entry.prompt.length > 60 ? `${entry.prompt.slice(0, 59)}…` : entry.prompt;
  return verdict === "right"
    ? `Labelled "${prompt}" ${entry.label}: ${said}, and you agree. npm run bench:ledger turns verdicts into a test set.`
    : `Labelled "${prompt}" ${entry.label}: ${said}. npm run bench:ledger turns verdicts into a test set.`;
}
