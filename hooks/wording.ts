/**
 * Other wording for the tier question, per decision model. The router asks
 * every model with TIER_CRITERIA unless one is given its own: some models read
 * the tiers differently, and `scripts/bench` measures wording per model
 * (`--criteria`). A wording that tested better on one model can then be used
 * by the router for that model alone.
 *
 * A wording is named. `sonnet-wider` ships with the plugin; the catalog can add
 * others (`wordings`) and assign them (`deciderWordings`), and
 * `JEV_ROUTER_WORDING` assigns them yourself: `microsoft-decision-1=sonnet-wider`.
 * A key is a full model id, the id after its `/`, or a route name, as for the
 * bars. A bar measured with one wording does not hold for another: set the
 * bar for that model with it (`JEV_ROUTER_DECIDER_BARS`).
 */

import { TIERS, type Tier } from "./policy.ts";

export type Wording = {
  /** The description of some tiers, in place of TIER_CRITERIA's. */
  criteria?: Partial<Record<Tier, string>>;
  /** The sentence the tier question opens with. */
  instructions?: string;
};

/**
 * `scripts/bench/criteria/sonnet-wider.json`, which a test keeps equal: on set C
 * it gave Microsoft Decision-1 a confidence that separates right from wrong at
 * 0.85 (73% right above it, 42% below; docs/WERKDOCUMENT.md). It does not make
 * the model more accurate, and on Jev it has no reliable effect.
 */
export const BUILTIN_WORDINGS: Record<string, Wording> = {
  "sonnet-wider": {
    criteria: {
      haiku:
        "Trivial, with no change to code: a lookup, a quick question with a short factual answer, a rename, a yes or no, restating something already on screen.",
      sonnet:
        "A contained change to existing code where the request already says what to do: adding a check or a parameter, changing a value or a message, a small function or test, a fix with an obvious cause, an explanation of a file or a few lines.",
      opus:
        "Real implementation or debugging that needs some design: a feature across several files, a refactor, a bug whose cause has to be found, writing a meaningful amount of new code.",
    },
  },
};

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY = /^[\w.:@/-]{1,100}$/;
const MAX_TEXT = 600;

/** A wording from untrusted JSON (the catalog), or null when it is not one. */
export function wordingOf(raw: unknown): Wording | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Wording = {};
  if (r.criteria !== undefined) {
    if (typeof r.criteria !== "object" || r.criteria === null || Array.isArray(r.criteria)) return null;
    const criteria: Partial<Record<Tier, string>> = {};
    for (const [tier, text] of Object.entries(r.criteria)) {
      if (!(TIERS as readonly string[]).includes(tier) || typeof text !== "string") return null;
      const t = text.replace(/\s+/g, " ").trim();
      if (t === "" || t.length > MAX_TEXT) return null;
      criteria[tier as Tier] = t;
    }
    out.criteria = criteria;
  }
  if (r.instructions !== undefined) {
    if (typeof r.instructions !== "string") return null;
    const t = r.instructions.replace(/\s+/g, " ").trim();
    if (t === "" || t.length > MAX_TEXT) return null;
    out.instructions = t;
  }
  return out.criteria === undefined && out.instructions === undefined ? null : out;
}

/** `key=name,key=name` → {key: name}, lowercased keys; a pair that does not parse is left out. */
export function assignmentsOf(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const pair of (raw ?? "").split(/[,;\s]+/)) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim().toLowerCase();
    const name = pair.slice(at + 1).trim().toLowerCase();
    if (KEY.test(key) && NAME.test(name)) out[key] = name;
  }
  return out;
}

/**
 * The wording a route's model is asked with, and its name, or null for the
 * router's own. Looked up by full model id, the id after its `/`, then the
 * route name; a name no wording has is ignored (and reported by `unknownNames`).
 */
export function wordingFor(
  assigned: Readonly<Record<string, string>>,
  available: Readonly<Record<string, Wording>>,
  route: string,
  model: string,
): { name: string; wording: Wording } | null {
  const id = model.toLowerCase();
  for (const key of [id, id.slice(id.lastIndexOf("/") + 1), route.toLowerCase()]) {
    if (key === "" || !Object.hasOwn(assigned, key)) continue;
    const name = assigned[key]!;
    return Object.hasOwn(available, name) ? { name, wording: available[name]! } : null;
  }
  return null;
}

/** Names assigned that no wording has, for `/jev` to say. */
export function unknownNames(assigned: Readonly<Record<string, string>>, available: Readonly<Record<string, Wording>>): string[] {
  return [...new Set(Object.values(assigned).filter((n) => !Object.hasOwn(available, n)))];
}
