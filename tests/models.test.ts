/**
 * Tests for the model list: what it accepts, how it is fetched and kept, and
 * what the ladder takes from it.
 */

import assert from "assert";
import { describe, it } from "node:test";

import {
  adoptModels,
  loadModels,
  MODELS_FAIL_BACKOFF_MS,
  MODELS_KEY,
  MODELS_TTL_MS,
  MODELS_URL,
  modelsLine,
  parsePage,
  type ModelInfo,
  type ModelsStore,
} from "../hooks/models.ts";
import { MODEL_OF, type Tier } from "../hooks/policy.ts";

const yes = { supported: true };
const no = { supported: false };
const effortAll = { supported: true, low: yes, medium: yes, high: yes, max: yes, xhigh: yes };

const entry = (id: string, line: string | null, created: string, over: Record<string, unknown> = {}) => ({
  type: "model",
  id,
  display_name: id,
  created_at: created,
  deprecated_at: null,
  retires_at: null,
  lifecycle: "active",
  line,
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: { effort: effortAll },
  ...over,
});

const page = (data: unknown[], extra: Record<string, unknown> = {}) => ({
  data,
  first_id: null,
  has_more: false,
  last_id: null,
  ...extra,
});

describe("parsePage", () => {
  it("reads the fields the router uses", () => {
    const r = parsePage(page([entry("claude-opus-5-5", "opus", "2026-09-21T00:00:00Z")]));
    assert.ok(r);
    assert.deepStrictEqual(r.models[0], {
      id: "claude-opus-5-5",
      displayName: "claude-opus-5-5",
      line: "opus",
      lifecycle: "active",
      createdAt: Date.parse("2026-09-21T00:00:00Z"),
      retiresAt: null,
      maxInputTokens: 1_000_000,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("lists only the efforts a model accepts, and none for one that takes none", () => {
    const some = parsePage(
      page([entry("m", "haiku", "2026-01-01T00:00:00Z", { capabilities: { effort: { supported: true, low: yes, medium: yes, high: yes, max: yes, xhigh: null } } })]),
    );
    assert.deepStrictEqual(some?.models[0]?.efforts, ["low", "medium", "high", "max"]);
    for (const capabilities of [{ effort: { supported: false, low: no } }, {}, null, { effort: "x" }]) {
      const r = parsePage(page([entry("m", "haiku", "2026-01-01T00:00:00Z", { capabilities })]));
      assert.strictEqual(r?.models[0]?.efforts, null);
    }
  });

  it("reads a deprecated model's retirement, and an unknown lifecycle as active", () => {
    const r = parsePage(
      page([
        entry("a", "opus", "2026-01-01T00:00:00Z", { lifecycle: "deprecated", retires_at: "2027-01-01T00:00:00Z" }),
        entry("b", "opus", "2026-01-01T00:00:00Z", { lifecycle: "weird" }),
      ]),
    );
    assert.strictEqual(r?.models[0]?.lifecycle, "deprecated");
    assert.strictEqual(r?.models[0]?.retiresAt, Date.parse("2027-01-01T00:00:00Z"));
    assert.strictEqual(r?.models[1]?.lifecycle, "active");
  });

  it("drops an entry it cannot use, bounds what it keeps, and refuses a non-list", () => {
    const r = parsePage(
      page([
        entry("ok", "opus", "2026-01-01T00:00:00Z", { max_input_tokens: 5, line: "Bad Line", created_at: "never" }),
        { id: 7 },
        null,
        entry("bad id with spaces", "opus", "2026-01-01T00:00:00Z"),
      ]),
    );
    assert.ok(r);
    assert.strictEqual(r.dropped, 3);
    assert.strictEqual(r.models.length, 1);
    assert.strictEqual(r.models[0]?.maxInputTokens, null);
    assert.strictEqual(r.models[0]?.line, null);
    assert.strictEqual(r.models[0]?.createdAt, 0);
    for (const raw of [null, [], {}, { data: "x" }, "x"]) assert.strictEqual(parsePage(raw), null);
  });

  it("follows has_more only with a cursor", () => {
    assert.strictEqual(parsePage(page([], { has_more: true, last_id: "claude-x" }))?.hasMore, true);
    assert.strictEqual(parsePage(page([], { has_more: true, last_id: null }))?.hasMore, false);
  });
});

function rig(answers: (string | (() => Promise<{ ok: boolean; status: number; text: string }>))[]) {
  const data = new Map<string, unknown>();
  const store: ModelsStore = {
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, structuredClone(v)),
  };
  let clock = 5_000_000;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer scripted");
    return typeof next === "function" ? next() : { ok: true, status: 200, text: next };
  };
  const sleep = (_ms: number, o?: { signal?: AbortSignal }) =>
    new Promise<void>((_, rej) => o?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  return { data, store, calls, fetch, sleep, now: () => clock, advance: (ms: number) => void (clock += ms) };
}

const list = (...ids: [string, string][]) =>
  JSON.stringify(page(ids.map(([id, line]) => entry(id, line, "2026-09-01T00:00:00Z"))));

describe("loadModels", () => {
  it("asks api.anthropic.com with the key and the version, saves, then serves from the saved list", async () => {
    const r = rig([list(["claude-opus-5-5", "opus"])]);
    const first = await loadModels({ ...r, apiKey: "sk-test" });
    assert.strictEqual(first.source, "fresh");
    assert.strictEqual(first.models?.[0]?.id, "claude-opus-5-5");
    assert.strictEqual(r.calls[0]?.url, `${MODELS_URL}?limit=1000`);
    assert.strictEqual(r.calls[0]?.headers["x-api-key"], "sk-test");
    assert.strictEqual(r.calls[0]?.headers["anthropic-version"], "2023-06-01");
    assert.ok(!JSON.stringify([...r.data.values()]).includes("sk-test"), "the key is not saved");

    r.advance(MODELS_TTL_MS - 1);
    assert.strictEqual((await loadModels({ ...r, apiKey: "sk-test" })).source, "cache");
    assert.strictEqual(r.calls.length, 1);
  });

  it("reads every page", async () => {
    const r = rig([
      JSON.stringify(page([entry("a", "opus", "2026-01-01T00:00:00Z")], { has_more: true, last_id: "a" })),
      JSON.stringify(page([entry("b", "opus", "2026-01-02T00:00:00Z")])),
    ]);
    const res = await loadModels({ ...r, apiKey: "k" });
    assert.deepStrictEqual(res.models?.map((m) => m.id), ["a", "b"]);
    assert.strictEqual(r.calls[1]?.url, `${MODELS_URL}?limit=1000&after_id=a`);
  });

  it("keeps the last good list when the fetch fails, and backs off", async () => {
    const r = rig([list(["claude-opus-5-5", "opus"]), async () => ({ ok: false, status: 401, text: "" })]);
    await loadModels({ ...r, apiKey: "k" });
    r.advance(MODELS_TTL_MS);
    const down = await loadModels({ ...r, apiKey: "k" });
    assert.strictEqual(down.source, "stale");
    assert.strictEqual(down.models?.length, 1);
    assert.deepStrictEqual(down.notes, ["models: HTTP 401"]);
    r.advance(MODELS_FAIL_BACKOFF_MS - 1);
    const again = await loadModels({ ...r, apiKey: "k" });
    assert.strictEqual(again.source, "stale");
    assert.strictEqual(r.calls.length, 2);
    assert.deepStrictEqual(again.notes, []);
  });

  it("is none, not a throw, on a bad answer with nothing saved", async () => {
    for (const answer of [
      async () => {
        throw new Error("offline");
      },
      "<html>",
      "[]",
      JSON.stringify(page([])),
    ]) {
      const r = rig([answer]);
      const res = await loadModels({ ...r, apiKey: "k" });
      assert.strictEqual(res.models, null);
      assert.strictEqual(res.source, "none");
      assert.strictEqual(res.notes.length, 1);
      assert.ok(!res.notes[0]!.includes("offline"), "no error text is echoed");
    }
  });

  it("does not echo the key into a note", async () => {
    const r = rig([async () => { throw new Error("connect failed for sk-secret"); }]);
    const res = await loadModels({ ...r, apiKey: "sk-secret" });
    assert.ok(!JSON.stringify(res).includes("sk-secret"));
  });

  it("survives a corrupt saved list and a store that throws", async () => {
    const r = rig([list(["claude-opus-5-5", "opus"])]);
    r.data.set(MODELS_KEY, { at: "x", models: 5 });
    assert.strictEqual((await loadModels({ ...r, apiKey: "k" })).source, "fresh");
    const bad = rig([list(["claude-opus-5-5", "opus"])]);
    const store: ModelsStore = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
    };
    assert.strictEqual((await loadModels({ ...bad, store, apiKey: "k" })).source, "fresh");
  });
});

const info = (id: string, line: string, created: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  displayName: id,
  line,
  lifecycle: "active",
  createdAt: Date.parse(created),
  retiresAt: null,
  maxInputTokens: 1_000_000,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  ...over,
});

describe("adoptModels", () => {
  const current = { ...MODEL_OF } as Record<Tier, string>;
  const base = [
    info(current.haiku, "haiku", "2026-10-07T00:00:00Z"),
    info(current.sonnet, "sonnet", "2026-09-28T00:00:00Z"),
    info(current.opus, "opus", "2026-09-21T00:00:00Z"),
    info(current.fable, "fable", "2026-09-01T00:00:00Z"),
  ];
  const all = () => true;

  it("changes nothing when the ladder's models are the newest", () => {
    const a = adoptModels(base, current, all);
    assert.deepStrictEqual(a.models, {});
    assert.deepStrictEqual(a.notes, []);
    assert.strictEqual(a.windows.opus, 1_000_000);
    assert.deepStrictEqual(a.efforts.fable, ["low", "medium", "high", "xhigh", "max"]);
  });

  it("takes a newer active model of the line once it is priced", () => {
    const list = [...base, info("claude-opus-6", "opus", "2026-11-01T00:00:00Z", { maxInputTokens: 2_000_000 })];
    const a = adoptModels(list, current, (id) => id === "claude-opus-6" || id === current.opus);
    assert.deepStrictEqual(a.models, { opus: "claude-opus-6" });
    assert.strictEqual(a.windows.opus, 2_000_000, "the window of the model it will run");
    assert.deepStrictEqual(a.notes, [`opus: ${current.opus} → claude-opus-6`]);
  });

  it("stays, and says so, while the newer model has no price", () => {
    const list = [...base, info("claude-opus-6", "opus", "2026-11-01T00:00:00Z")];
    const a = adoptModels(list, current, (id) => id !== "claude-opus-6");
    assert.deepStrictEqual(a.models, {});
    assert.deepStrictEqual(a.notes, [`opus: claude-opus-6 is out but has no price yet; staying on ${current.opus}`]);
  });

  it("takes the newest priced one when the newest is not", () => {
    const list = [
      ...base,
      info("claude-opus-6", "opus", "2026-12-01T00:00:00Z"),
      info("claude-opus-5-8", "opus", "2026-11-01T00:00:00Z"),
    ];
    const a = adoptModels(list, current, (id) => id !== "claude-opus-6");
    assert.deepStrictEqual(a.models, { opus: "claude-opus-5-8" });
    assert.deepStrictEqual(a.notes, [
      `opus: ${current.opus} → claude-opus-5-8`,
      "opus: claude-opus-6 is out but has no price yet; staying on claude-opus-5-8",
    ]);
  });

  it("ignores older, deprecated and other-line models", () => {
    const list = [
      ...base,
      info("claude-opus-4-5", "opus", "2025-11-01T00:00:00Z"),
      info("claude-opus-7", "opus", "2027-01-01T00:00:00Z", { lifecycle: "deprecated" }),
      info("claude-mythos-9", "mythos", "2027-01-01T00:00:00Z"),
      info("claude-x-1", "opus", "2027-01-01T00:00:00Z", { lifecycle: "retired" }),
    ];
    assert.deepStrictEqual(adoptModels(list, current, all).models, {});
  });

  it("says when the model it runs is deprecated, with the date", () => {
    const list = base.map((m) =>
      m.id === current.sonnet ? { ...m, lifecycle: "deprecated" as const, retiresAt: Date.parse("2027-03-01T00:00:00Z") } : m,
    );
    const a = adoptModels(list, current, all);
    assert.deepStrictEqual(a.notes, [`sonnet: ${current.sonnet} is deprecated (retires 2027-03-01)`]);
  });

  it("changes nothing for a tier whose model is not in the list", () => {
    const list = [...base.slice(1), info("claude-haiku-9", "haiku", "2027-01-01T00:00:00Z")];
    const a = adoptModels(list, current, all);
    assert.deepStrictEqual(a.models, {}, "an unknown starting point is not a reason to move");
    assert.strictEqual(a.windows.haiku, undefined);
    assert.deepStrictEqual(a.notes, [`haiku: ${current.haiku} is not in the model list`]);
  });

  it("carries the efforts a model accepts, and nothing for one that does not say", () => {
    const list = base.map((m) => (m.id === current.haiku ? { ...m, efforts: null } : { ...m, efforts: ["low", "high"] as ModelInfo["efforts"] }));
    const a = adoptModels(list, current, all);
    assert.strictEqual(a.efforts.haiku, undefined);
    assert.deepStrictEqual(a.efforts.opus, ["low", "high"]);
  });
});

describe("modelsLine", () => {
  it("says why nothing was asked, or what came back", () => {
    assert.match(modelsLine(null, null, "no-key"), /needs ANTHROPIC_API_KEY/);
    assert.match(modelsLine(null, null, "off"), /JEV_ROUTER_MODEL_SYNC=0/);
    assert.match(modelsLine(null, null, "loading"), /^loading/);
    assert.strictEqual(modelsLine({ models: [], source: "fresh", notes: [] }, null, "ready"), "fetched");
    assert.strictEqual(
      modelsLine({ models: [], source: "stale", notes: ["models: HTTP 401"] }, { models: {}, windows: {}, efforts: {}, notes: ["opus: a → b"] }, "ready"),
      "saved list, the fetch failed · HTTP 401; opus: a → b",
    );
  });
});
