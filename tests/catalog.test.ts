/**
 * Tests for the catalog: what it accepts, what it drops, how it is fetched
 * and kept, and that the file in the repo says what the built-in tables say.
 */

import assert from "assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CATALOG_KEY,
  CATALOG_SCHEMA,
  CATALOG_URL_DEFAULT,
  DEFAULT_TTL_MS,
  FAIL_BACKOFF_MS,
  catalogOnOf,
  catalogTtlOf,
  catalogUrlOf,
  excludedLinesOf,
  catalogLine,
  loadCatalog,
  overlayOf,
  parseCatalog,
  priceForPrompt,
  priceJumps,
  type Catalog,
  type CatalogStore,
} from "../hooks/catalog.ts";
import { MODEL_OF, TIERS } from "../hooks/policy.ts";
import { PRICE, WINDOW_TOKENS } from "../hooks/pricing.ts";

const P = { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 };

const file = () => ({
  schema: 1,
  updated: "2026-10-20",
  models: { "claude-x-1": { line: "haiku", maxInputTokens: 1_000_000, price: P } },
  plans: { pro: { excludeLines: ["fable"] }, max: { excludeLines: [] } },
  deciders: { jev: { latest: "jev-1.14.0" } },
});

function parsed(raw: unknown): Catalog {
  const r = parseCatalog(raw);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.catalog;
}

describe("parseCatalog", () => {
  it("reads a well-formed file", () => {
    const c = parsed(file());
    assert.strictEqual(c.models["claude-x-1"]?.line, "haiku");
    assert.deepStrictEqual(c.plans.pro?.excludeLines, ["fable"]);
    assert.strictEqual(c.deciders.jev?.latest, "jev-1.14.0");
  });

  it("refuses what is not a catalog, and a newer format", () => {
    for (const raw of [null, [], "x", 3, {}, { schema: 0 }, { schema: 1.5 }, { schema: "1" }])
      assert.strictEqual(parseCatalog(raw).ok, false);
    const newer = parseCatalog({ ...file(), schema: CATALOG_SCHEMA + 1 });
    assert.strictEqual(newer.ok, false);
  });

  it("drops a bad model on its own and keeps the rest", () => {
    const f = file() as any;
    f.models["claude-bad"] = { line: "haiku", price: { ...P, input: -1 } };
    f.models["claude-huge"] = { line: "haiku", price: { ...P, output: 1e9 } };
    f.models["claude-nan"] = { line: "haiku", price: { ...P, read: "0.1" } };
    f.models["claude-window"] = { line: "haiku", maxInputTokens: 5 };
    f.models["claude-line"] = { line: "Haiku!" };
    f.models["bad id with spaces"] = { line: "haiku" };
    const r = parseCatalog(f);
    assert.ok(r.ok);
    assert.deepStrictEqual(Object.keys(r.catalog.models), ["claude-x-1"]);
    assert.strictEqual(r.dropped.length, 6);
  });

  it("takes price tiers only above a base price, ascending", () => {
    const tier = (n: number) => ({ abovePromptTokens: n, ...P, input: 2 });
    const ok = parsed({ ...file(), models: { m: { line: "haiku", price: P, priceTiers: [tier(100_000), tier(200_000)] } } });
    assert.strictEqual(ok.models.m?.priceTiers?.length, 2);
    for (const bad of [
      { line: "haiku", priceTiers: [tier(100_000)] },
      { line: "haiku", price: P, priceTiers: [tier(200_000), tier(100_000)] },
      { line: "haiku", price: P, priceTiers: [tier(100_000), tier(100_000)] },
      { line: "haiku", price: P, priceTiers: [{ abovePromptTokens: 0, ...P }] },
      { line: "haiku", price: P, priceTiers: [{ abovePromptTokens: 5 }] },
      { line: "haiku", price: P, priceTiers: Array.from({ length: 5 }, (_, i) => tier(1000 * (i + 1))) },
    ]) {
      const r = parseCatalog({ ...file(), models: { m: bad } });
      assert.ok(r.ok);
      assert.deepStrictEqual(r.catalog.models, {});
    }
  });

  it("drops a bad plan or decider, and carries no host or key", () => {
    const f = file() as any;
    f.plans["Bad Plan"] = { excludeLines: [] };
    f.plans.broken = { excludeLines: "fable" };
    f.deciders.evil = { latest: "https://evil.example/steal" };
    f.deciders.slashy = { latest: "//evil.example" };
    f.deciders.pplx = { latest: "pplx-decider-v1.2", flash: "typesafe/jev-1.14" };
    const r = parseCatalog(f);
    assert.ok(r.ok);
    assert.deepStrictEqual(Object.keys(r.catalog.plans).sort(), ["max", "pro"]);
    assert.deepStrictEqual(Object.keys(r.catalog.deciders).sort(), ["jev", "pplx"]);
    assert.ok(r.dropped.includes("decider evil") && r.dropped.includes("decider slashy"), "a URL is not a model id");
  });

  it("ignores keys it does not know", () => {
    const r = parseCatalog({ ...file(), note: "hi", future: { a: 1 } });
    assert.ok(r.ok);
  });

  it("is not tripped by __proto__ keys", () => {
    const r = parseCatalog(JSON.parse('{"schema":1,"models":{"__proto__":{"line":"haiku"}},"plans":{},"deciders":{}}'));
    assert.ok(r.ok);
    assert.strictEqual(({} as any).line, undefined);
  });
});

describe("priceForPrompt", () => {
  const tier = { abovePromptTokens: 100_000, price: { ...P, input: 2, output: 10 } };
  const model = { line: "haiku", price: P, priceTiers: [tier] };

  it("uses the base price up to the threshold and the tier above it", () => {
    assert.strictEqual(priceForPrompt(model, 100_000)?.input, 1);
    assert.strictEqual(priceForPrompt(model, 100_001)?.input, 2);
  });

  it("is null with no base price", () => {
    assert.strictEqual(priceForPrompt({ line: "haiku" }, 10), null);
  });
});

describe("priceJumps", () => {
  it("names a model whose price moved past the factor, either way, or to or from zero", () => {
    const base = parsed(file());
    const moved = (patch: Partial<typeof P>) =>
      parsed({ ...file(), models: { "claude-x-1": { line: "haiku", price: { ...P, ...patch } } } });
    assert.deepStrictEqual(priceJumps(base, moved({ output: 5.5 })), []);
    assert.deepStrictEqual(priceJumps(base, moved({ output: 50 })), ["claude-x-1"]);
    assert.deepStrictEqual(priceJumps(base, moved({ input: 0.1 })), ["claude-x-1"]);
    assert.deepStrictEqual(priceJumps(base, moved({ read: 0 })), ["claude-x-1"]);
  });
});

describe("excludedLinesOf", () => {
  it("is the plan's lines, case-insensitive, and none for an unknown plan or no catalog", () => {
    const c = parsed(file());
    assert.deepStrictEqual(excludedLinesOf(c, "Pro"), ["fable"]);
    assert.deepStrictEqual(excludedLinesOf(c, "max"), []);
    assert.deepStrictEqual(excludedLinesOf(c, "team"), []);
    assert.deepStrictEqual(excludedLinesOf(c, undefined), []);
    assert.deepStrictEqual(excludedLinesOf(null, "pro"), []);
  });
});

describe("settings", () => {
  it("is on unless told off", () => {
    assert.strictEqual(catalogOnOf(undefined), true);
    assert.strictEqual(catalogOnOf(""), true);
    for (const off of ["0", "false", "No", " off ", "none"]) assert.strictEqual(catalogOnOf(off), false);
  });

  it("takes only https from GitHub's raw host unless custom is allowed", () => {
    assert.deepStrictEqual(catalogUrlOf(undefined, undefined), { ok: true, url: CATALOG_URL_DEFAULT });
    const mine = "https://raw.githubusercontent.com/me/fork/main/catalog.json";
    assert.deepStrictEqual(catalogUrlOf(mine, undefined), { ok: true, url: mine });
    for (const bad of [
      "http://raw.githubusercontent.com/a/b/main/catalog.json",
      "https://example.com/catalog.json",
      "https://user:pw@raw.githubusercontent.com/a/b/c.json",
      "not a url",
    ])
      assert.strictEqual(catalogUrlOf(bad, undefined).ok, false, bad);
    assert.strictEqual(catalogUrlOf("https://example.com/catalog.json", "1").ok, true);
    assert.strictEqual(catalogUrlOf("http://example.com/catalog.json", "1").ok, false);
  });

  it("reads the cache lifetime in hours, with a floor, a cap and a default", () => {
    assert.strictEqual(catalogTtlOf(undefined), DEFAULT_TTL_MS);
    assert.strictEqual(catalogTtlOf("abc"), DEFAULT_TTL_MS);
    assert.strictEqual(catalogTtlOf("0"), DEFAULT_TTL_MS);
    assert.strictEqual(catalogTtlOf("2"), 2 * 3_600_000);
    assert.strictEqual(catalogTtlOf("99999"), 24 * 30 * 3_600_000);
  });
});

/** A store in memory, and a fetch that answers from a script. */
function rig(answers: (() => Promise<{ ok: boolean; status: number; text: string }>)[]) {
  const data = new Map<string, unknown>();
  const store: CatalogStore = {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, structuredClone(v)),
  };
  let clock = 1_000_000;
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const next = answers.shift();
    if (!next) throw new Error("no answer scripted");
    return next();
  };
  // A sleep that never ends unless aborted: only a real timeout test settles it.
  const sleep = (_ms: number, o?: { signal?: AbortSignal }) =>
    new Promise<void>((_, rej) => o?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  return {
    data,
    store,
    calls,
    fetch,
    sleep,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
  };
}

const ok = (body: unknown) => async () => ({ ok: true, status: 200, text: typeof body === "string" ? body : JSON.stringify(body) });
const URL_ = CATALOG_URL_DEFAULT;

describe("loadCatalog", () => {
  it("fetches, saves, and then serves from the cache without a request", async () => {
    const r = rig([ok(file())]);
    const first = await loadCatalog({ ...r, url: URL_ });
    assert.strictEqual(first.source, "fresh");
    assert.ok(first.catalog?.models["claude-x-1"]);
    assert.ok(r.data.has(CATALOG_KEY));

    r.advance(DEFAULT_TTL_MS - 1);
    const second = await loadCatalog({ ...r, url: URL_ });
    assert.strictEqual(second.source, "cache");
    assert.strictEqual(r.calls.length, 1);
  });

  it("fetches again once the copy is out of date, and notes dropped entries and price jumps", async () => {
    const changed = file() as any;
    changed.models["claude-x-1"].price = { ...P, output: 500 };
    changed.models.junk = { line: "!!" };
    const r = rig([ok(file()), ok(changed)]);
    await loadCatalog({ ...r, url: URL_ });
    r.advance(DEFAULT_TTL_MS);
    const second = await loadCatalog({ ...r, url: URL_ });
    assert.strictEqual(second.source, "fresh");
    assert.strictEqual(second.catalog?.models["claude-x-1"]?.price?.output, 500, "the new copy is the one used");
    assert.ok(second.notes.some((n) => n.includes("ignored model junk")));
    assert.ok(second.notes.some((n) => n.includes("claude-x-1")));
  });

  it("keeps the last good copy when the fetch fails, and backs off after a failure", async () => {
    const r = rig([ok(file()), async () => ({ ok: false, status: 503, text: "" })]);
    await loadCatalog({ ...r, url: URL_ });
    r.advance(DEFAULT_TTL_MS);
    const down = await loadCatalog({ ...r, url: URL_ });
    assert.strictEqual(down.source, "stale");
    assert.ok(down.catalog?.models["claude-x-1"]);
    assert.deepStrictEqual(down.notes, ["catalog: HTTP 503"]);

    r.advance(FAIL_BACKOFF_MS - 1);
    const again = await loadCatalog({ ...r, url: URL_ });
    assert.strictEqual(again.source, "stale");
    assert.strictEqual(r.calls.length, 2, "no new request inside the back-off");
    assert.deepStrictEqual(again.notes, []);

    // The backed-off failure must not make the old copy look fresh.
    r.advance(FAIL_BACKOFF_MS);
    const retry = await loadCatalog({ ...r, url: URL_ });
    assert.strictEqual(r.calls.length, 3);
    assert.strictEqual(retry.source, "stale");
  });

  it("is none, not a throw, when there is nothing saved and the fetch fails", async () => {
    for (const answer of [
      async () => {
        throw new Error("offline");
      },
      ok("<html>"),
      ok({ schema: 99 }),
      ok([]),
    ]) {
      const r = rig([answer]);
      const res = await loadCatalog({ ...r, url: URL_ });
      assert.strictEqual(res.catalog, null);
      assert.strictEqual(res.source, "none");
      assert.strictEqual(res.notes.length, 1);
    }
  });

  it("does not let a bad file replace a good copy", async () => {
    const r = rig([ok(file()), ok({ schema: 1, models: "nope" }), ok("{")]);
    await loadCatalog({ ...r, url: URL_ });
    r.advance(DEFAULT_TTL_MS);
    // schema 1 with unusable sections still parses: nothing but the entries is lost.
    const emptied = await loadCatalog({ ...r, url: URL_ });
    assert.strictEqual(emptied.source, "fresh");
    assert.deepStrictEqual(emptied.catalog?.models, {});

    r.advance(DEFAULT_TTL_MS);
    const garbled = await loadCatalog({ ...r, url: URL_ });
    assert.strictEqual(garbled.source, "stale");
    assert.deepStrictEqual(Object.keys(garbled.catalog?.models ?? {}), []);
  });

  it("gives up on a slow server at the timeout", async () => {
    const r = rig([() => new Promise(() => {})]);
    const sleep = async (ms: number, o?: { signal?: AbortSignal }) => {
      assert.strictEqual(ms, 50);
      void o;
    };
    const res = await loadCatalog({ ...r, sleep, url: URL_, timeoutMs: 50 });
    assert.strictEqual(res.source, "none");
    assert.deepStrictEqual(res.notes, ["catalog: timed out after 50ms"]);
  });

  it("ignores a saved copy from another url, and a corrupt one in the store", async () => {
    const r = rig([ok(file()), ok(file())]);
    await loadCatalog({ ...r, url: URL_ });
    const other = "https://raw.githubusercontent.com/me/fork/main/catalog.json";
    const res = await loadCatalog({ ...r, url: other });
    assert.strictEqual(res.source, "fresh");
    assert.strictEqual(r.calls[1], other);

    r.data.set(CATALOG_KEY, { at: "x", url: 4 });
    r.advance(1);
    const corrupt = rig([ok(file())]);
    corrupt.data.set(CATALOG_KEY, "junk");
    assert.strictEqual((await loadCatalog({ ...corrupt, url: URL_ })).source, "fresh");
  });

  it("survives a store that throws", async () => {
    const r = rig([ok(file())]);
    const store: CatalogStore = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
    };
    const res = await loadCatalog({ ...r, store, url: URL_ });
    assert.strictEqual(res.source, "fresh");
  });
});

describe("catalog.json in the repo", () => {
  const raw = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
  const catalog = parsed(raw);

  it("parses with nothing dropped", () => {
    const r = parseCatalog(raw);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.dropped, []);
  });

  it("says what the built-in tables say, so one cannot drift from the other", () => {
    for (const tier of TIERS) {
      const model = catalog.models[MODEL_OF[tier]];
      assert.ok(model, `${MODEL_OF[tier]} is in the catalog`);
      assert.strictEqual(model.line, tier);
      assert.strictEqual(model.maxInputTokens, WINDOW_TOKENS[tier]);
      const { tiers, ...flat } = PRICE[tier];
      assert.deepStrictEqual(model.price, flat);
      assert.deepStrictEqual(model.priceTiers ?? [], tiers ?? []);
    }
  });

  it("has a plan for each of pro, max and api", () => {
    assert.deepStrictEqual(Object.keys(catalog.plans).sort(), ["api", "max", "pro"]);
    assert.deepStrictEqual(catalog.plans.max?.excludeLines, []);
  });
});

describe("overlayOf", () => {
  const c = parsed({
    ...file(),
    models: {
      "claude-haiku-5-5": {
        line: "haiku",
        maxInputTokens: 500_000,
        price: P,
        priceTiers: [{ abovePromptTokens: 100_000, ...P, input: 9 }],
      },
      "Claude-Other-1": { line: "opus", price: P },
      "claude-nothing": { line: "opus" },
    },
  });

  it("maps priced models by lowercase id, and each tier's model to the tier", () => {
    const o = overlayOf(c);
    assert.deepStrictEqual([...o.models.keys()].sort(), ["claude-haiku-5-5", "claude-other-1"]);
    assert.strictEqual(o.models.get("claude-haiku-5-5")?.tiers?.[0]?.price.input, 9);
    assert.strictEqual(o.ladder.haiku?.tiers?.length, 1);
    assert.strictEqual(o.windows.haiku, 500_000);
    assert.strictEqual(o.ladder.opus, undefined, "opus's own model is not in this file");
  });
});

describe("catalogLine", () => {
  const c = parsed(file());
  it("says where the copy came from and how old the data is", () => {
    assert.strictEqual(catalogLine({ catalog: c, source: "fresh", notes: [] }, false), "fetched · data from 2026-10-20");
    assert.strictEqual(catalogLine({ catalog: c, source: "cache", notes: [] }, false), "saved copy · data from 2026-10-20");
    assert.strictEqual(
      catalogLine({ catalog: c, source: "stale", notes: ["catalog: HTTP 503"] }, false),
      "saved copy, the fetch failed · data from 2026-10-20 · HTTP 503",
    );
    assert.strictEqual(
      catalogLine({ catalog: null, source: "none", notes: ["catalog: timed out after 3000ms"] }, false),
      "none, the built-in tables answer · timed out after 3000ms",
    );
    assert.strictEqual(catalogLine(null, true), "loading (the built-in tables answer until it is in)");
    assert.strictEqual(catalogLine(null, false), "not loaded");
  });
});
