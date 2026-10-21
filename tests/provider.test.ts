/**
 * Tests for provider resolution: which backend (TypeSafe direct or Vercel
 * Gateway) should be used, based on available keys and user overrides.
 */

import assert from "assert";
import { describe, it } from "node:test";

import {
  confidenceSourceOf,
  labelOf,
  layaBaseOf,
  providerOf,
  providersOf,
  typesafeBaseOf,
  type ProviderEnv,
} from "../hooks/provider.ts";

describe("providerOf", () => {
  it("prefers TypeSafe direct when TYPESAFE_API_KEY is set", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "typesafe",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      apiKey: "ts-key",
    });
  });

  it("falls back to gateway when only AI_GATEWAY_API_KEY is set", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "gateway",
      endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
      model: "typesafe-ai/jev",
      apiKey: "gw-key",
    });
  });

  it("returns error when no keys are set", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
    });
  });

  it("respects JEV_ROUTER_PROVIDER=typesafe override", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: "typesafe",
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "typesafe",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      apiKey: "ts-key",
    });
  });

  it("respects JEV_ROUTER_PROVIDER=gateway override", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: "gateway",
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "gateway",
      endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
      model: "typesafe-ai/jev",
      apiKey: "gw-key",
    });
  });

  it("errors when forced provider=typesafe but key is missing", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: "typesafe",
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: "JEV_ROUTER_PROVIDER=typesafe but TYPESAFE_API_KEY is not set",
    });
  });

  it("errors when forced provider=gateway but key is missing", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: "gateway",
      TYPESAFE_BASE_URL: undefined,
    });

    assert.deepStrictEqual(provider, {
      ok: false,
      reason: "JEV_ROUTER_PROVIDER=gateway but AI_GATEWAY_API_KEY is not set",
    });
  });

  it("applies TYPESAFE_BASE_URL override when custom bases are allowed", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: "https://api.example.com",
      JEV_ROUTER_ALLOW_CUSTOM_BASE: "1",
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "typesafe",
      endpoint: "https://api.example.com/v1/systemone",
      model: "jev-latest",
      apiKey: "ts-key",
    });
  });

  it("refuses a foreign TYPESAFE_BASE_URL without an allow", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: undefined,
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: "https://api.example.com",
    });

    assert.equal(provider.ok, false);
  });

  it("ignores TYPESAFE_BASE_URL when provider is gateway", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: undefined,
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: undefined,
      TYPESAFE_BASE_URL: "https://api.example.com",
    });

    assert.deepStrictEqual(provider, {
      ok: true,
      name: "gateway",
      endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
      model: "typesafe-ai/jev",
      apiKey: "gw-key",
    });
  });

  it("ignores unrecognised JEV_ROUTER_PROVIDER value and uses defaults", () => {
    const provider = providerOf({
      TYPESAFE_API_KEY: "ts-key",
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_PROVIDER: "unknown",
      TYPESAFE_BASE_URL: undefined,
    });

    // Falls back to default precedence (TypeSafe wins)
    assert.deepStrictEqual(provider, {
      ok: true,
      name: "typesafe",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      apiKey: "ts-key",
    });
  });
});

describe("TYPESAFE_BASE_URL allowlist", () => {
  it("default and typesafe.ai hosts are allowed", () => {
    assert.equal(typesafeBaseOf(undefined, undefined).ok, true);
    assert.equal(
      typesafeBaseOf("https://api.typesafe.ai", undefined).ok,
      true,
    );
    assert.equal(
      typesafeBaseOf("https://staging.typesafe.ai", undefined).ok,
      true,
    );
  });

  it("foreign hosts need an explicit allow", () => {
    const blocked = typesafeBaseOf("https://evil.example", undefined);
    assert.equal(blocked.ok, false);
    const allowed = typesafeBaseOf("https://evil.example", "1");
    assert.equal(allowed.ok, true);
  });

  it("http is refused", () => {
    assert.equal(typesafeBaseOf("http://api.typesafe.ai", "1").ok, false);
  });
});

describe("audit regressions (2026-09-28)", () => {
  it("a whitespace-only TypeSafe key does not beat a real gateway key, and a key is trimmed", () => {
    const p = providerOf({ TYPESAFE_API_KEY: "  ", AI_GATEWAY_API_KEY: "gw-key\n", JEV_ROUTER_PROVIDER: undefined, TYPESAFE_BASE_URL: undefined });
    assert.ok(p.ok);
    if (p.ok) {
      assert.strictEqual(p.name, "gateway");
      assert.strictEqual(p.apiKey, "gw-key");
    }
  });
  it("a base that already ends in the endpoint's path is not doubled", () => {
    for (const raw of ["https://api.typesafe.ai/v1/systemone", "https://api.typesafe.ai/v1", "https://api.typesafe.ai/v1/systemone/"]) {
      const b = typesafeBaseOf(raw, undefined);
      assert.deepStrictEqual(b, { ok: true, base: "https://api.typesafe.ai" }, raw);
    }
    assert.deepStrictEqual(typesafeBaseOf("https://proxy.typesafe.ai/jev", undefined), { ok: true, base: "https://proxy.typesafe.ai/jev" });
  });
});

describe("JEV_ROUTER_PROVIDER's other names (2026-09-29)", () => {
  it("vercel means the gateway, direct means TypeSafe", () => {
    const env = { TYPESAFE_API_KEY: "ts", AI_GATEWAY_API_KEY: "gw", TYPESAFE_BASE_URL: undefined };
    const v = providerOf({ ...env, JEV_ROUTER_PROVIDER: "vercel" });
    assert.ok(v.ok && v.name === "gateway");
    const d = providerOf({ ...env, JEV_ROUTER_PROVIDER: "direct" });
    assert.ok(d.ok && d.name === "typesafe");
  });
});

describe("keys and model ids a header or the route line cannot carry (2026-09-29)", () => {
  it("a key with a line break inside is refused, naming the variable, not the key", () => {
    for (const key of ["ts_live_abc\ndef", "ts_live_abc\rdef", "ts live", "ts_live_\u0000x"]) {
      const p = providerOf({ TYPESAFE_API_KEY: key } as never);
      assert.equal(p.ok, false);
      if (!p.ok) {
        assert.match(p.reason, /TYPESAFE_API_KEY/);
        assert.ok(!p.reason.includes("ts_live"));
      }
    }
    const g = providerOf({ AI_GATEWAY_API_KEY: "gw\nkey" } as never);
    assert.equal(g.ok, false);
  });
  it("a key only padded with whitespace is still the key", () => {
    const p = providerOf({ TYPESAFE_API_KEY: "  ts_live_abc\n" } as never);
    assert.ok(p.ok && p.apiKey === "ts_live_abc");
  });
  it("a pinned Jev model that is not a model id is refused", () => {
    const p = providerOf({ TYPESAFE_API_KEY: "k", JEV_ROUTER_JEV_MODEL: "jev\n# heading" } as never);
    assert.equal(p.ok, false);
    const q = providerOf({ TYPESAFE_API_KEY: "k", JEV_ROUTER_JEV_MODEL: "jev-2026-09" } as never);
    assert.ok(q.ok && q.model === "jev-2026-09");
  });
  it("a long run of slashes in the base is quick", () => {
    const t = performance.now();
    typesafeBaseOf(`https://api.typesafe.ai/${"/".repeat(100_000)}x${"/".repeat(100_000)}`, undefined);
    assert.ok(performance.now() - t < 200);
  });
});

describe("only what the chosen provider uses is checked (2026-09-29)", () => {
  it("a stale key or pinned model for the other provider blocks nothing", () => {
    const g = providerOf({ JEV_ROUTER_PROVIDER: "gateway", AI_GATEWAY_API_KEY: "vck_abc123", TYPESAFE_API_KEY: "paste key here" } as never);
    assert.ok(g.ok && g.name === "gateway");
    const t = providerOf({ TYPESAFE_API_KEY: "ts_live_abc", AI_GATEWAY_API_KEY: "has space" } as never);
    assert.ok(t.ok && t.name === "typesafe");
    const gm = providerOf({ AI_GATEWAY_API_KEY: "vck_abc123", JEV_ROUTER_JEV_MODEL: "jev-1.13.0+build.5" } as never);
    assert.ok(gm.ok);
    const tm = providerOf({ TYPESAFE_API_KEY: "ts_live_abc", JEV_ROUTER_JEV_MODEL: "jev-1.13.0+build.5" } as never);
    assert.ok(tm.ok && tm.model === "jev-1.13.0+build.5");
  });
});

const env = (over: Partial<ProviderEnv> = {}): ProviderEnv => ({
  TYPESAFE_API_KEY: undefined,
  AI_GATEWAY_API_KEY: undefined,
  JEV_ROUTER_PROVIDER: undefined,
  TYPESAFE_BASE_URL: undefined,
  ...over,
});

describe("Laya on your own server", () => {
  it("is the route when only LAYA_BASE_URL is set, and needs no key", () => {
    assert.deepStrictEqual(providerOf(env({ LAYA_BASE_URL: "https://nas.lan:8443" })), {
      ok: true,
      name: "laya",
      endpoint: "https://nas.lan:8443/v1/systemone",
      model: "laya",
      apiKey: "",
    });
  });

  it("sends LAYA_API_KEY to that server and to nowhere else", () => {
    const p = providerOf(env({ LAYA_BASE_URL: "https://nas.lan", LAYA_API_KEY: " laya-key \n" }));
    assert.ok(p.ok);
    assert.strictEqual(p.apiKey, "laya-key");
    assert.strictEqual(p.endpoint, "https://nas.lan/v1/systemone");
  });

  it("keeps a path in front of it, and does not double the endpoint's own", () => {
    for (const base of ["https://nas.lan/laya", "https://nas.lan/laya/", "https://nas.lan/laya/v1", "https://nas.lan/laya/v1/systemone"])
      assert.deepStrictEqual(layaBaseOf(base), { ok: true, base: "https://nas.lan/laya" }, base);
  });

  it("must be https and must not carry a login", () => {
    for (const [bad, reason] of [
      ["http://nas.lan", /must use https/],
      ["https://user:pw@nas.lan", /must not carry a login/],
      ["nas.lan", /not a valid URL/],
    ] as const) {
      const r = layaBaseOf(bad);
      assert.ok(!r.ok);
      assert.match(r.reason, reason);
    }
  });

  it("named without a URL is an error that names the variable", () => {
    const p = providerOf(env({ JEV_ROUTER_PROVIDER: "laya" }));
    assert.deepStrictEqual(p, { ok: false, reason: "JEV_ROUTER_PROVIDER=laya but LAYA_BASE_URL is not set" });
  });

  it("refuses a key a header cannot carry, without echoing it", () => {
    const p = providerOf(env({ LAYA_BASE_URL: "https://nas.lan", LAYA_API_KEY: "has space" }));
    assert.ok(!p.ok);
    assert.match(p.reason, /LAYA_API_KEY/);
    assert.ok(!p.reason.includes("has space"));
  });

  it("takes its model from JEV_ROUTER_JEV_MODEL when pinned", () => {
    const p = providerOf(env({ LAYA_BASE_URL: "https://nas.lan", JEV_ROUTER_JEV_MODEL: "laya-0.4" }));
    assert.ok(p.ok);
    assert.strictEqual(p.model, "laya-0.4");
  });

  it("comes after a TypeSafe key and before the gateway's when nothing is named", () => {
    const laya = { LAYA_BASE_URL: "https://nas.lan" };
    assert.strictEqual(providerOf(env({ ...laya, TYPESAFE_API_KEY: "ts" })).ok && (providerOf(env({ ...laya, TYPESAFE_API_KEY: "ts" })) as { name: string }).name, "typesafe");
    assert.strictEqual((providerOf(env({ ...laya, AI_GATEWAY_API_KEY: "gw" })) as { name: string }).name, "laya");
  });
});

describe("OpenRouter, Command Code and OpenCode", () => {
  it("OpenRouter: a fixed address, Jev 1.14, its own key", () => {
    assert.deepStrictEqual(providerOf(env({ JEV_ROUTER_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-key" })), {
      ok: true,
      name: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/systemone",
      model: "typesafe/jev-1.14",
      apiKey: "or-key",
    });
  });

  it("Command Code: the provider API, Jev 1.14.0 pinned", () => {
    assert.deepStrictEqual(providerOf(env({ JEV_ROUTER_PROVIDER: "command-code", COMMANDCODE_API_KEY: "cc" })), {
      ok: true,
      name: "commandcode",
      endpoint: "https://api.commandcode.ai/provider/v1/systemone",
      model: "typesafe/jev-1.14.0",
      apiKey: "cc",
    });
  });

  it("OpenCode needs its model id given: the router does not know it", () => {
    const missing = providerOf(env({ JEV_ROUTER_PROVIDER: "opencode", OPENCODE_API_KEY: "oc" }));
    assert.ok(!missing.ok);
    assert.match(missing.reason, /needs JEV_ROUTER_JEV_MODEL/);
    const given = providerOf(env({ JEV_ROUTER_PROVIDER: "opencode", OPENCODE_API_KEY: "oc", JEV_ROUTER_JEV_MODEL: "jev-1.13" }));
    assert.ok(given.ok);
    assert.strictEqual(given.endpoint, "https://opencode.ai/inference/systemone/v1/systemone");
  });

  it("a named route without its key is an error naming the variable", () => {
    for (const [name, key] of [["openrouter", "OPENROUTER_API_KEY"], ["commandcode", "COMMANDCODE_API_KEY"], ["opencode", "OPENCODE_API_KEY"]] as const) {
      const p = providerOf(env({ JEV_ROUTER_PROVIDER: name }));
      assert.ok(!p.ok);
      assert.match(p.reason, new RegExp(key));
    }
  });

  it("is never chosen by its key alone: that key is used for other things", () => {
    for (const key of ["OPENROUTER_API_KEY", "COMMANDCODE_API_KEY", "OPENCODE_API_KEY"] as const) {
      const p = providerOf(env({ [key]: "some-key" }));
      assert.deepStrictEqual(p, { ok: false, reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY" });
    }
  });

  it("TYPESAFE_BASE_URL does not move any other route", () => {
    const p = providerOf(env({ JEV_ROUTER_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", TYPESAFE_BASE_URL: "https://evil.example", JEV_ROUTER_ALLOW_CUSTOM_BASE: "1" }));
    assert.ok(p.ok);
    assert.strictEqual(p.endpoint, "https://openrouter.ai/api/v1/systemone");
  });
});

describe("a list of providers", () => {
  const all = { LAYA_BASE_URL: "https://nas.lan", OPENROUTER_API_KEY: "or", TYPESAFE_API_KEY: "ts" };

  it("is tried in the order it is named", () => {
    const r = providersOf(env({ ...all, JEV_ROUTER_PROVIDER: "laya, openrouter;typesafe" }));
    assert.ok(r.ok);
    assert.deepStrictEqual(r.providers.map((p) => p.name), ["laya", "openrouter", "typesafe"]);
  });

  it("names each once, ignores a name it does not know, and one that is none falls back to the keys", () => {
    const r = providersOf(env({ ...all, JEV_ROUTER_PROVIDER: "laya,laya,bogus" }));
    assert.ok(r.ok);
    assert.deepStrictEqual(r.providers.map((p) => p.name), ["laya"]);
    const auto = providersOf(env({ ...all, JEV_ROUTER_PROVIDER: "bogus" }));
    assert.ok(auto.ok);
    assert.deepStrictEqual(auto.providers.map((p) => p.name), ["typesafe"]);
  });

  it("fails loudly when one of them cannot be built", () => {
    const r = providersOf(env({ LAYA_BASE_URL: "https://nas.lan", JEV_ROUTER_PROVIDER: "laya,openrouter" }));
    assert.ok(!r.ok);
    assert.match(r.reason, /OPENROUTER_API_KEY/);
  });

  it("is a single provider when one is named, as before", () => {
    const r = providersOf(env({ TYPESAFE_API_KEY: "ts", JEV_ROUTER_PROVIDER: "direct" }));
    assert.ok(r.ok);
    assert.strictEqual(r.providers.length, 1);
  });
});

describe("what a route says about its confidence", () => {
  it("Laya is named on the route line and read for x_jev_confidence; the rest are Jev", () => {
    assert.strictEqual(labelOf("laya"), "Laya");
    assert.strictEqual(confidenceSourceOf("laya"), "x_jev");
    for (const name of ["typesafe", "gateway", "openrouter", "commandcode", "opencode"] as const) {
      assert.strictEqual(labelOf(name), "Jev");
      assert.strictEqual(confidenceSourceOf(name), "jev");
    }
  });
});

describe("OpenRouter's Decisions API, and other decision models", () => {
  const base = { JEV_ROUTER_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or" };

  it("JEV_ROUTER_API=decisions moves only the openrouter route to /api/alpha/decisions", () => {
    const p = providerOf(env({ ...base, JEV_ROUTER_API: " Decisions " }));
    assert.deepStrictEqual(p, {
      ok: true,
      name: "openrouter",
      endpoint: "https://openrouter.ai/api/alpha/decisions",
      model: "typesafe/jev-1.14",
      apiKey: "or",
      api: "decisions",
    });
    const other = providerOf(env({ LAYA_BASE_URL: "https://nas.lan", JEV_ROUTER_API: "decisions" }));
    assert.ok(other.ok);
    assert.strictEqual(other.endpoint, "https://nas.lan/v1/systemone");
    assert.strictEqual("api" in other, false);
  });

  it("anything else stays System One", () => {
    for (const api of [undefined, "", "systemone", "bogus"]) {
      const p = providerOf(env({ ...base, JEV_ROUTER_API: api }));
      assert.ok(p.ok);
      assert.strictEqual(p.endpoint, "https://openrouter.ai/api/v1/systemone");
    }
  });

  it("the model can be any decision model in the catalog", () => {
    const p = providerOf(env({ ...base, JEV_ROUTER_API: "decisions", JEV_ROUTER_JEV_MODEL: "perplexity/pplx-decider-v1.2" }));
    assert.ok(p.ok);
    assert.strictEqual(p.model, "perplexity/pplx-decider-v1.2");
  });

  it("a model that is not Jev is named by its id and read for its probabilities", () => {
    assert.strictEqual(labelOf("openrouter", "perplexity/pplx-decider-v1.2"), "pplx-decider-v1.2");
    assert.strictEqual(confidenceSourceOf("openrouter", "perplexity/pplx-decider-v1.2"), "probabilities");
    assert.strictEqual(labelOf("openrouter", "microsoft/decision-1"), "decision-1");
    assert.strictEqual(labelOf("openrouter", "typesafe/jev-1.14"), "Jev");
    assert.strictEqual(confidenceSourceOf("openrouter", "typesafe/jev-1.14-20261014"), "jev");
    assert.strictEqual(confidenceSourceOf("commandcode", "typesafe/jev-1.14.0"), "jev");
    assert.strictEqual(labelOf("typesafe", "anything"), "Jev");
    assert.strictEqual(confidenceSourceOf("gateway", "typesafe-ai/jev"), "jev");
    assert.strictEqual(labelOf("openrouter"), "Jev", "no model named: it is the default, Jev");
  });
});
