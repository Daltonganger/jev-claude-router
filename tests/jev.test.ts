import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  askJev,
  askJevChain,
  askJevRace,
  DEFAULT_PREFER_MS,
  DEFAULT_STAGGER_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  preferOf,
  requestBodyOf,
  staggerOf,
  timeoutOf,
  type HttpInitLike,
  type HttpResponseLike,
} from "../hooks/jev.ts";
import { labelOf, withLabel } from "../hooks/label.ts";
import { TIERS } from "../hooks/policy.ts";
import type { ProviderOk, ProviderResult } from "../hooks/provider.ts";

const never = () => new Promise<never>(() => {});
const immediately = async () => undefined;

const answered = (body: unknown): HttpResponseLike => ({
  ok: true,
  status: 200,
  text: JSON.stringify(body),
});

const gatewayProvider: ProviderResult = {
  ok: true,
  name: "gateway",
  endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
  model: "typesafe-ai/jev",
  apiKey: "gw-key",
};

const typeafeProvider: ProviderResult = {
  ok: true,
  name: "typesafe",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  apiKey: "ts-key",
};

const noKeyProvider: ProviderResult = {
  ok: false,
  reason: "no decision model set up: none of JEV_ROUTER_PROVIDER, VLLM_SR_API_KEY, TYPESAFE_API_KEY, LAYA_BASE_URL or AI_GATEWAY_API_KEY is set",
};

const base = {
  sleep: never,
  provider: gatewayProvider,
  state: "plan the migration",
  offered: TIERS,
};

describe("jev", () => {
  test("the request names Jev and asks both questions at once", () => {
    const body = requestBodyOf("rename a variable", TIERS);
    assert.equal(body.state, "rename a variable");
    assert.deepEqual(Object.keys(body.questions), ["tier", "effort"]);
    assert.equal(body.questions.tier.type, "choice");
    assert.equal(body.questions.effort.type, "score");
  });

  test("only the offered tiers reach Jev", () => {
    const body = requestBodyOf("x", ["haiku", "opus"]);
    assert.deepEqual(Object.keys(body.questions.tier.criteria), [
      "haiku",
      "opus",
    ]);
  });

  test("the gateway is never asked for a noul, which it refuses", () => {
    const types = Object.values(requestBodyOf("x", TIERS).questions).map(
      (q) => q.type,
    );
    for (const t of types)
      assert.ok(["choice", "score", "boolean"].includes(t));
  });

  test("a good answer comes back as the answers object", async () => {
    const answers = { tier: { type: "choice", choice: "opus" } };
    const got = await askJev({
      ...base,
      fetch: async () => answered({ model: "jev-1.13.0", answers }),
    });
    assert.equal(got.ok, true);
    assert.deepEqual(got.ok && got.answers, answers);
  });

  test("it posts to the gateway with the key as a bearer token", async () => {
    let seen: { url?: string; init?: HttpInitLike } = {};
    await askJev({
      ...base,
      fetch: async (url, init) => {
        seen = { url, init };
        return answered({ answers: {} });
      },
    });
    assert.equal(seen.url, "https://ai-gateway.vercel.sh/v1/evaluate");
    assert.equal(seen.init?.method, "POST");
    assert.equal(seen.init?.headers?.authorization, "Bearer gw-key");
  });

  test("no key means no request at all", async () => {
    let called = false;
    const got = await askJev({
      ...base,
      provider: noKeyProvider,
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
    });
    assert.equal(got.ok, false);
    assert.equal(called, false);
    assert.match(
      got.ok === false ? got.reason : "",
      /no decision model set up: none of JEV_ROUTER_PROVIDER, VLLM_SR_API_KEY, TYPESAFE_API_KEY, LAYA_BASE_URL or AI_GATEWAY_API_KEY is set/,
    );
  });


  test("a timeout aborts the in-flight fetch", async () => {
    let signal: AbortSignal | undefined;
    const got = await askJev({
      ...base,
      fetch: async (_url, init) => {
        signal = init?.signal;
        return never();
      },
      sleep: immediately,
      timeoutMs: 1,
    });
    assert.equal(got.ok, false);
    assert.equal(signal?.aborted, true);
  });

  test("the caller's signal cancels the in-flight fetch and comes back as ceded", async () => {
    let signal: AbortSignal | undefined;
    const controller = new AbortController();
    const got = await askJev({
      ...base,
      fetch: async (_url, init) => {
        signal = init?.signal;
        setTimeout(() => controller.abort(), 0);
        return never();
      },
      sleep: never,
      signal: controller.signal,
    });
    assert.equal(got.ok, false);
    assert.equal(signal?.aborted, true, "the fetch's own signal follows the caller's");
    assert.match(got.ok === false ? got.reason : "", /ceded/);
  });

  test("an already-aborted signal is not worth a request at all", async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const got = await askJev({
      ...base,
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
      signal: controller.signal,
    });
    assert.equal(called, false);
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /ceded/);
  });

  test("a slow gateway loses the race and the turn is left alone", async () => {
    const got = await askJev({
      ...base,
      fetch: never,
      sleep: immediately,
      timeoutMs: 1,
    });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.reason : "", /timed out/);
  });

  test("a failure is named, so the session can say why it went unrouted", async () => {
    const reasonOf = (r: Awaited<ReturnType<typeof askJev>>) =>
      r.ok === false ? r.reason : "UNEXPECTEDLY OK";

    const refused = await askJev({
      ...base,
      fetch: async () => ({
        ok: false,
        status: 403,
        text: JSON.stringify({
          error: { type: "customer_verification_required" },
        }),
      }),
    });
    assert.match(
      reasonOf(refused),
      /gateway said HTTP 403 \(customer_verification_required\)/,
    );

    const tsRefused = await askJev({
      ...base,
      provider: typeafeProvider,
      fetch: async () => ({
        ok: false,
        status: 401,
        text: JSON.stringify({ error: { type: "auth" } }),
      }),
    });
    assert.match(reasonOf(tsRefused), /typesafe said HTTP 401 \(auth\)/);

    const threw = await askJev({
      ...base,
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.match(reasonOf(threw), /socket hang up/);

    const garbage = await askJev({
      ...base,
      fetch: async () => ({ ok: true, status: 200, text: "not json" }),
    });
    assert.match(reasonOf(garbage), /not JSON/);

    const empty = await askJev({
      ...base,
      fetch: async () => answered({ model: "jev" }),
    });
    assert.match(reasonOf(empty), /no answers/);
  });

  test("an empty prompt is not worth a round trip", async () => {
    let called = false;
    await askJev({
      ...base,
      state: "   ",
      fetch: async () => {
        called = true;
        return answered({ answers: {} });
      },
    });
    assert.equal(called, false);
  });

  test("a call is timed, so the status report can show how slow Jev was", async () => {
    let t = 1000;
    const got = await askJev({
      ...base,
      now: () => t,
      fetch: async () => {
        t += 640;
        return answered({
          answers: { tier: { type: "choice", choice: "opus" } },
        });
      },
    });
    assert.equal(got.ms, 640);
  });
});

describe("label", () => {
  const decision = {
    tier: "opus" as const,
    model: "claude-opus-5-5",
    effort: "high" as const,
    confidence: 0.9,
  };

  test("a confident pick reads as tier and effort", () => {
    assert.equal(labelOf(decision, true), "jev: opus, high effort");
  });

  test("an unconfident pick is marked", () => {
    assert.equal(
      labelOf({ ...decision, confidence: 0.2 }, true),
      "jev: opus, high effort, only 20% sure",
    );
  });

  test("routing off says so, and before the first turn nothing is added", () => {
    assert.equal(labelOf(decision, false), "jev off");
    assert.equal(labelOf(null, true), null);
  });

  test("the label joins the engine’s own modes without duplicating", () => {
    assert.deepEqual(withLabel(["plan mode"], "jev off"), [
      "plan mode",
      "jev off",
    ]);
    assert.deepEqual(withLabel(["jev off"], "jev off"), ["jev off"]);
    assert.deepEqual(
      withLabel(["plan mode", "jev → opus·high"], "jev: haiku, low effort"),
      ["plan mode", "jev: haiku, low effort"],
      "an old-style label is cleared too",
    );
    assert.deepEqual(withLabel(["plan mode", "jev → opus·high"], null), [
      "plan mode",
    ]);
  });
});

describe("timeout", () => {
  test("an unset, empty or nonsense budget falls back to the default", () => {
    assert.equal(timeoutOf(undefined), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf(""), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("soon"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("0"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("-5"), DEFAULT_TIMEOUT_MS);
  });

  test("a budget from the environment is used", () => {
    assert.equal(timeoutOf("2500"), 2500);
  });

  test("the default clears the slowest live call measured (839ms)", () => {
    assert.ok(DEFAULT_TIMEOUT_MS > 839);
  });

  test("a budget near the hook's 10s limit is held under it", () => {
    assert.equal(timeoutOf("9500"), MAX_TIMEOUT_MS);
    assert.equal(timeoutOf("60000"), MAX_TIMEOUT_MS);
    assert.ok(MAX_TIMEOUT_MS < 10_000);
  });
});

describe("shortError", () => {
  test("an engine fetch error comes down to a few words", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    assert.equal(
      shortError("jev-claude-router: $.http.fetch(https://127.0.0.1:9/v1/systemone) failed: ECONNREFUSED: ECONNREFUSED: Unable to connect. Is the computer able to access the url?"),
      "ECONNREFUSED: Unable to connect",
    );
    assert.ok(shortError("x".repeat(200)).length <= 60);
  });
});

describe("audit regressions (2026-09-28)", () => {
  const d = { tier: "opus" as const, model: "claude-opus-5-5", effort: "medium" as const, confidence: 0 };
  test("a named tier or a failed Jev call is not shown as 0% sure", () => {
    assert.equal(labelOf({ ...d, forced: true }, true), "jev: opus, medium effort");
    assert.equal(labelOf({ ...d, jevFailed: "timed out after 1500ms" }, true), "jev: opus, medium effort");
    assert.equal(labelOf(d, true), "jev: opus, medium effort, only 0% sure", "a real 0 from Jev still is");
  });
  test("a timeout below 100ms is taken for a mistake, not a budget", () => {
    assert.equal(timeoutOf("1.5"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("99"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("100"), 100);
  });
  test("the provider's error type in a failure reason is short and plain", async () => {
    const provider: ProviderResult = { ok: true, name: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", apiKey: "k" };
    const result = await askJev({
      ...base,
      provider,
      fetch: async () => ({ ok: false, status: 400, headers: {}, text: JSON.stringify({ error: { type: "bad_request\n> ⚠️ " + "x".repeat(200) } }) }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.doesNotMatch(result.reason, /\n|⚠️/);
      assert.ok(result.reason.length < 80, result.reason);
    }
  });
});

describe("shortError flattens newlines (2026-09-29)", () => {
  test("an engine error over two lines comes back as one", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    assert.doesNotMatch(shortError("plugin: $.http.fetch(https://x) failed: getaddrinfo ENOTFOUND\n# boom"), /\n/);
  });
});

describe("audit regressions (2026-09-29)", () => {
  const d = { tier: "fable" as const, model: "claude-fable-5-1", effort: "high" as const, confidence: 0.4 };
  test("the label shows no doubt for a held turn or a continued one", () => {
    assert.equal(labelOf({ ...d, held: "haiku" }, true), "jev: fable, high effort");
    assert.equal(labelOf({ ...d, confidence: 0 }, true, "continue"), "jev: fable, high effort");
    assert.equal(labelOf(d, true), "jev: fable, high effort, only 40% sure");
  });
  test("a cut never leaves half an emoji", async () => {
    const { stateOf, MAX_STATE_CHARS } = await import("../hooks/jev.ts");
    const text = `${"a".repeat(MAX_STATE_CHARS - 1)}😀 and more`;
    assert.doesNotMatch(stateOf(text), /[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  test("the timeout's timer is ended once the answer is in", async () => {
    let ended = false;
    const sleep = (_ms: number, o?: { signal?: AbortSignal }) =>
      new Promise<void>((_, reject) => o?.signal?.addEventListener("abort", () => ((ended = true), reject(new Error("aborted")))));
    const got = await askJev({ ...base, sleep, fetch: async () => answered({ answers: { tier: { type: "choice", choice: "opus", confidence: 0.9 } } }) });
    assert.equal(got.ok, true);
    assert.equal(ended, true);
  });
  test("a fetch that throws at once is a failure, not a rejection", async () => {
    const got = await askJev({ ...base, fetch: () => { throw new Error("bad init"); } });
    assert.equal(got.ok, false);
  });
  test("a timeout in hex is refused", () => {
    assert.equal(timeoutOf("0x1F40"), DEFAULT_TIMEOUT_MS);
  });
});

describe("round-3 audit (2026-09-29)", () => {
  test("the question names who wrote the text", () => {
    assert.match(requestBodyOf("x", TIERS).questions.tier.instructions, /A developer typed/);
    assert.match(requestBodyOf("x", TIERS, "task").questions.tier.instructions, /subagent/);
    assert.match(requestBodyOf("x", TIERS, "notification").questions.tier.instructions, /works through the result/);
  });
  test("a timeout is a plain number, as every setting takes: 1e3 is refused, 1000. is not", () => {
    assert.equal(timeoutOf("1e3"), DEFAULT_TIMEOUT_MS);
    assert.equal(timeoutOf("1000."), 1000);
  });
});

describe("round-4 audit (2026-09-29)", () => {
  test("a fetch that rejects with something that is not an Error is still a named failure", async () => {
    for (const thrown of [Object.create(null), Object.assign(new Error("x"), { message: 42 })]) {
      const got = await askJev({ ...base, fetch: async () => { throw thrown; } });
      assert.equal(got.ok, false);
      if (!got.ok) assert.match(got.reason, /^request failed: /);
    }
  });
});

describe("the footer's doubt follows the continued flag (2026-09-29)", () => {
  test("a notification Jev was asked about shows its doubt; one that continued does not", () => {
    const d = { tier: "opus" as const, model: "claude-opus-5-5", effort: "high" as const, confidence: 0.3 };
    assert.equal(labelOf(d, true, "notify"), "jev: opus, high effort, only 30% sure");
    assert.equal(labelOf(d, true, "notify", true), "jev: opus, high effort");
  });
});

describe("shortError never quotes a key (2026-09-29)", () => {
  test("a header error's Bearer value is redacted", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    const out = shortError('Headers.append: "Bearer ts_live_9f8e7d6c5b4a" is an invalid header value');
    assert.ok(!out.includes("ts_live"), out);
    assert.match(out, /Bearer …/);
  });
});

describe("shortError keeps advice about a bearer token (2026-09-29)", () => {
  test("only a key-like value is redacted", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    assert.equal(shortError("HTTP 401: Missing bearer token. Set AI_GATEWAY_API_KEY"), "HTTP 401: Missing bearer token");
  });
});

describe("shortError redacts a credential after Bearer, not the words about one (2026-09-29)", () => {
  test("short, quoted, separated and mixed-case keys go; words stay", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    for (const key of ["abcdefghijKLMNOPqrst", '"ts_live_9f8e7d6c"', "'ts_live_x'", "auth-9f8a7b6c5d4e3f", "sk-live-abc123XYZ"]) {
      const out = shortError(`Headers.append: Bearer ${key} is invalid`);
      assert.ok(!out.includes(key.replace(/["']/g, "")), out);
    }
    for (const text of [
      "request failed: Bearer required",
      "Expected scheme Bearer but got Basic",
      "Bearer token-based auth failed",
      "expected Bearer auth/OAuth",
    ])
      assert.equal(shortError(text), text);
    const { withoutBearer } = await import("../hooks/jev.ts");
    assert.equal(withoutBearer("Invalid Bearer token."), "Invalid Bearer token.");
    assert.equal(withoutBearer("bearer sk-live-abc123XYZ"), "bearer …");
    const t = performance.now();
    withoutBearer(`Bearer A${"a".repeat(200_000)}`);
    assert.ok(performance.now() - t < 200);
  });
  test("the key itself is taken out of a failed request's reason wherever it appears", async () => {
    const { askJev } = await import("../hooks/jev.ts");
    const r = await askJev({
      fetch: async () => {
        throw new Error("401 Invalid bearer token tsk_live_9f8a7b6c5d4e for this account");
      },
      sleep: () => new Promise(() => {}),
      provider: { ok: true, name: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev", apiKey: "tsk_live_9f8a7b6c5d4e" },
      state: "x",
      offered: ["haiku", "opus"],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(!r.reason.includes("tsk_live"), r.reason);
  });
});

describe("the configured key is removed however short or plain (2026-09-29)", () => {
  test("a short all-letter key quoted after Bearer", async () => {
    const { askJev } = await import("../hooks/jev.ts");
    const r = await askJev({
      fetch: async () => {
        throw new Error("Headers.append: Bearer gw-key is invalid");
      },
      sleep: () => new Promise(() => {}),
      provider: { ok: true, name: "gateway", endpoint: "https://ai-gateway.vercel.sh/v1/evaluate", model: "typesafe-ai/jev", apiKey: "gw-key" },
      state: "x",
      offered: ["haiku", "opus"],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(!r.reason.includes("gw-key"), r.reason);
  });
});

describe("withoutBearer and its callers, edge cases (2026-09-29)", () => {
  test("a long run of trailing punctuation is linear", async () => {
    const { withoutBearer } = await import("../hooks/jev.ts");
    const t = performance.now();
    withoutBearer(`Bearer ${".".repeat(200_000)}`);
    assert.ok(performance.now() - t < 200);
  });
  test("a control character between Bearer and a token does not hide it, and the cut does not split it", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    assert.doesNotMatch(shortError("Bearer\u0007sk-ant-api03-abcdefghijklmnop0123 rejected"), /sk-ant/);
  });
});

describe("shortError: a NEL between Bearer and a token does not hide it (2026-09-29)", () => {
  test("U+0085", async () => {
    const { shortError } = await import("../hooks/jev.ts");
    assert.doesNotMatch(shortError("proxy rejected Authorization: Bearer\u0085sk_live_ABC123secret"), /sk_live/);
    assert.doesNotMatch(shortError('proxy rejected Authorization: Bearer\u0085"sk_live_ABC123secret"'), /sk_live/);
  });
});

describe("a Laya server and a chain of providers", () => {
  const laya: ProviderOk = { ok: true, name: "laya", endpoint: "https://nas.lan/v1/systemone", model: "laya", apiKey: "" };
  const openrouter: ProviderOk = {
    ok: true,
    name: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.14",
    apiKey: "or-key",
  };
  const answer = answered({ answers: { tier: { type: "choice", choice: "opus" } } });
  const down: HttpResponseLike = { ok: false, status: 503, text: "" };

  test("a server that asks for no key gets no authorization header", async () => {
    let headers: Record<string, string> | undefined;
    const r = await askJev({
      ...base,
      provider: laya,
      fetch: async (_u: string, init?: HttpInitLike) => {
        headers = init?.headers;
        return answer;
      },
    });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(headers ?? {}), ["content-type"]);
    assert.equal(r.via, "laya");
  });

  test("a key is sent as a bearer token to the route it belongs to", async () => {
    const seen: [string, string | undefined][] = [];
    await askJev({
      ...base,
      provider: openrouter,
      fetch: async (url: string, init?: HttpInitLike) => {
        seen.push([url, init?.headers?.authorization]);
        return answer;
      },
    });
    assert.deepEqual(seen, [["https://openrouter.ai/api/v1/systemone", "Bearer or-key"]]);
  });

  test("the chain asks the next provider when one fails at once, and says who answered", async () => {
    const urls: string[] = [];
    const r = await askJevChain({
      ...base,
      providers: [laya, openrouter],
      fetch: async (url: string) => {
        urls.push(url);
        return url.includes("nas.lan") ? down : answer;
      },
    });
    assert.ok(r.ok);
    assert.equal(r.via, "openrouter");
    assert.deepEqual(urls, ["https://nas.lan/v1/systemone", "https://openrouter.ai/api/v1/systemone"]);
  });

  test("the first to answer ends the chain", async () => {
    let calls = 0;
    const r = await askJevChain({
      ...base,
      providers: [laya, openrouter],
      fetch: async () => {
        calls++;
        return answer;
      },
    });
    assert.ok(r.ok);
    assert.equal(r.via, "laya");
    assert.equal(calls, 1);
  });

  test("they share one budget: the next gets what is left", async () => {
    let t = 1000;
    const budgets: number[] = [];
    const r = await askJevChain({
      ...base,
      timeoutMs: 1500,
      now: () => t,
      providers: [laya, openrouter],
      sleep: async (ms: number) => {
        budgets.push(ms);
        return never();
      },
      fetch: async (url: string) => {
        t += 400;
        return url.includes("nas.lan") ? down : answer;
      },
    });
    assert.ok(r.ok);
    assert.deepEqual(budgets, [1500, 1100]);
    assert.equal(r.ms, 800);
  });

  test("a provider that times out has spent the budget, and the turn goes unrouted", async () => {
    let calls = 0;
    const r = await askJevChain({
      ...base,
      timeoutMs: 200,
      providers: [laya, openrouter],
      sleep: immediately,
      fetch: async () => {
        calls++;
        return never();
      },
    });
    assert.ok(!r.ok);
    assert.equal(calls, 1);
    assert.match(r.reason, /^laya: timed out after 200ms$/);
  });

  test("one provider's failure reads as it always did; several say who said what", async () => {
    const one = await askJevChain({ ...base, providers: [laya], fetch: async () => down });
    assert.ok(!one.ok);
    assert.equal(one.reason, "laya said HTTP 503");
    const two = await askJevChain({ ...base, providers: [laya, openrouter], fetch: async () => down });
    assert.ok(!two.ok);
    assert.equal(two.reason, "laya said HTTP 503; then openrouter said HTTP 503");
  });

  test("a turn ceded to a newer copy stops the chain", async () => {
    const abort = new AbortController();
    let calls = 0;
    const r = await askJevChain({
      ...base,
      signal: abort.signal,
      providers: [laya, openrouter],
      fetch: async () => {
        calls++;
        abort.abort();
        return never();
      },
    });
    assert.ok(!r.ok);
    assert.equal(r.reason, "ceded");
    assert.equal(calls, 1);
  });
});

describe("askJevRace: every provider at once, the first named preferred", () => {
  const laya: ProviderOk = { ok: true, name: "laya", endpoint: "https://nas.lan/v1/systemone", model: "laya", apiKey: "" };
  const openrouter: ProviderOk = {
    ok: true,
    name: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.14",
    apiKey: "or-key",
  };
  const answer = answered({ answers: { tier: { type: "choice", choice: "opus" } } });
  const down: HttpResponseLike = { ok: false, status: 503, text: "" };
  const base = { state: "refactor the parser", offered: TIERS, timeoutMs: 1500 };

  /** A promise to settle by hand. */
  function later<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  /** Timers that fire only when told: the budget (1500) never, the grace on `graceFires`. */
  function clock() {
    const grace = later<undefined>();
    const sleeps: number[] = [];
    return {
      sleeps,
      fireGrace: () => grace.resolve(undefined),
      sleep: (ms: number, options?: { signal?: AbortSignal }) => {
        sleeps.push(ms);
        if (ms === 1500) return never();
        return new Promise<undefined>((res, rej) => {
          options?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
          void grace.promise.then(res);
        });
      },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("both are asked at once", async () => {
    const urls: string[] = [];
    const r = await askJevRace({ ...base, sleep: clock().sleep, providers: [laya, openrouter], fetch: async (url: string) => (urls.push(url), answer) });
    assert.ok(r.ok);
    assert.equal(r.via, "laya");
    assert.deepEqual(urls.sort(), ["https://nas.lan/v1/systemone", "https://openrouter.ai/api/v1/systemone"]);
  });

  test("a later answer waits for the first named, which wins inside the grace", async () => {
    const first = later<HttpResponseLike>();
    const c = clock();
    const result = askJevRace({
      ...base,
      sleep: c.sleep,
      providers: [laya, openrouter],
      fetch: async (url: string) => (url.includes("nas.lan") ? first.promise : answer),
    });
    await tick();
    assert.ok(c.sleeps.includes(DEFAULT_PREFER_MS), "the grace started once OpenRouter answered");
    first.resolve(answer);
    const r = await result;
    assert.ok(r.ok);
    assert.equal(r.via, "laya");
  });

  test("past the grace the later answer is taken", async () => {
    const c = clock();
    const result = askJevRace({
      ...base,
      sleep: c.sleep,
      providers: [laya, openrouter],
      fetch: async (url: string) => (url.includes("nas.lan") ? never() : answer),
    });
    await tick();
    c.fireGrace();
    const r = await result;
    assert.ok(r.ok);
    assert.equal(r.via, "openrouter");
  });

  test("a slow first provider no longer leaves the turn unrouted", async () => {
    const r = await askJevRace({
      ...base,
      timeoutMs: 200,
      preferMs: 0,
      // The budget runs out a moment later; the grace is none.
      sleep: (ms: number) => (ms === 0 ? Promise.resolve(undefined) : new Promise<undefined>((r) => setTimeout(() => r(undefined), 20))),
      providers: [laya, openrouter],
      fetch: async (url: string) => (url.includes("nas.lan") ? never() : answer),
    });
    assert.ok(r.ok);
    assert.equal(r.via, "openrouter");
  });

  test("an earlier provider that fails at once does not hold the later answer", async () => {
    const c = clock();
    const r = await askJevRace({ ...base, sleep: c.sleep, providers: [laya, openrouter], fetch: async (url: string) => (url.includes("nas.lan") ? down : answer) });
    assert.ok(r.ok);
    assert.equal(r.via, "openrouter");
    assert.ok(!c.sleeps.includes(DEFAULT_PREFER_MS), "no grace: nothing earlier is still asking");
  });

  test("all failing says who said what", async () => {
    const r = await askJevRace({ ...base, sleep: clock().sleep, providers: [laya, openrouter], fetch: async () => down });
    assert.ok(!r.ok);
    assert.equal(r.reason, "laya said HTTP 503; openrouter said HTTP 503");
  });

  test("a turn ceded to a newer copy stops the race", async () => {
    const abort = new AbortController();
    const result = askJevRace({ ...base, signal: abort.signal, sleep: clock().sleep, providers: [laya, openrouter], fetch: async () => never() });
    abort.abort();
    const r = await result;
    assert.ok(!r.ok);
    assert.equal(r.reason, "ceded");
  });

  test("one provider asks as the chain does", async () => {
    const r = await askJevRace({ ...base, sleep: clock().sleep, providers: [laya], fetch: async () => down });
    assert.ok(!r.ok);
    assert.equal(r.reason, "laya said HTTP 503");
  });

  test("the grace from the environment", () => {
    assert.equal(preferOf(undefined), DEFAULT_PREFER_MS);
    assert.equal(preferOf("0"), 0);
    assert.equal(preferOf("150"), 150);
    assert.equal(preferOf("soon"), DEFAULT_PREFER_MS);
    assert.equal(preferOf("99999"), MAX_TIMEOUT_MS);
  });
});

describe("askJevRace: a staggered reserve, and every provider's part (2026-10-25)", () => {
  const vllm: ProviderOk = { ok: true, name: "vllm", endpoint: "https://decision.vllm-sr.ai/v1/systemone", model: "vllm-sr/d3-turbo", apiKey: "k1" };
  const openrouter: ProviderOk = { ok: true, name: "openrouter", endpoint: "https://openrouter.ai/api/v1/systemone", model: "typesafe/jev-1.14", apiKey: "k2" };
  const laya: ProviderOk = { ok: true, name: "laya", endpoint: "https://nas.lan/v1/systemone", model: "laya", apiKey: "" };
  const answer = answered({ answers: { tier: { type: "choice", choice: "opus" } } });
  const down: HttpResponseLike = { ok: false, status: 503, text: "" };
  const base = { state: "refactor the parser", offered: TIERS, timeoutMs: 1500 };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function later<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  /** Waits that end only when told, by length; the budget's never ends. Aborted ones reject. */
  function timers() {
    const waiting: { ms: number; resolve: () => void }[] = [];
    return {
      lengths: () => waiting.map((w) => w.ms),
      fire: (ms: number) => {
        for (const w of waiting.filter((w) => w.ms === ms)) w.resolve();
      },
      sleep: (ms: number, options?: { signal?: AbortSignal }) => {
        if (ms === 1500 || options?.signal === undefined) return never();
        return new Promise<undefined>((res, rej) => {
          options.signal!.addEventListener("abort", () => rej(new Error("aborted")));
          waiting.push({ ms, resolve: () => res(undefined) });
        });
      },
    };
  }
  const hosts = (urls: string[]) => urls.map((u) => new URL(u).host);

  test("a first provider that answers in time is the only one asked", async () => {
    const t = timers();
    const urls: string[] = [];
    const first = later<HttpResponseLike>();
    const result = askJevRace({ ...base, staggerMs: 400, sleep: t.sleep, providers: [vllm, openrouter], fetch: async (url: string) => (urls.push(url), first.promise) });
    await tick();
    assert.deepEqual(hosts(urls), ["decision.vllm-sr.ai"], "the reserve waits");
    first.resolve(answer);
    const r = await result;
    assert.ok(r.ok);
    assert.equal(r.via, "vllm");
    t.fire(400);
    await tick();
    assert.deepEqual(hosts(urls), ["decision.vllm-sr.ai"], "and is never asked once an answer is taken");
    assert.deepEqual(r.tries?.map((x) => [x.name, x.outcome]), [["vllm", "won"], ["openrouter", "not asked"]]);
  });

  test("past the stagger the reserve is asked too, and its answer taken after the grace", async () => {
    const t = timers();
    const urls: string[] = [];
    const result = askJevRace({
      ...base,
      staggerMs: 400,
      sleep: t.sleep,
      providers: [vllm, openrouter],
      fetch: async (url: string) => (urls.push(url), url.includes("vllm") ? never() : answer),
    });
    await tick();
    t.fire(400);
    await tick();
    assert.deepEqual(hosts(urls), ["decision.vllm-sr.ai", "openrouter.ai"]);
    t.fire(DEFAULT_PREFER_MS);
    const r = await result;
    assert.ok(r.ok);
    assert.equal(r.via, "openrouter");
    assert.deepEqual(r.tries?.map((x) => [x.name, x.outcome]), [["vllm", "pending"], ["openrouter", "won"]]);
    assert.equal(r.tries?.[0]?.start, 0);
    assert.equal(r.tries?.[0]?.ms, undefined, "still asking: no time of its own yet");
  });

  test("a first provider that fails asks the reserve at once, without waiting out the stagger", async () => {
    const t = timers();
    const urls: string[] = [];
    const r = await askJevRace({ ...base, staggerMs: 400, sleep: t.sleep, providers: [vllm, openrouter], fetch: async (url: string) => (urls.push(url), url.includes("vllm") ? down : answer) });
    assert.ok(r.ok);
    assert.equal(r.via, "openrouter");
    assert.deepEqual(r.tries?.map((x) => [x.name, x.outcome]), [["vllm", "failed"], ["openrouter", "won"]]);
  });

  test("a third provider waits twice the stagger, and is asked when both before it fail", async () => {
    const t = timers();
    const urls: string[] = [];
    const result = askJevRace({
      ...base,
      staggerMs: 300,
      sleep: t.sleep,
      providers: [vllm, openrouter, laya],
      fetch: async (url: string) => (urls.push(url), url.includes("nas.lan") ? answer : down),
    });
    const r = await result;
    assert.deepEqual(t.lengths().sort(), [300, 600]);
    assert.ok(r.ok);
    assert.equal(r.via, "laya");
    assert.deepEqual(r.tries?.map((x) => x.outcome), ["failed", "failed", "won"]);
  });

  test("all at once keeps every part, the loser's answer included", async () => {
    const t = timers();
    const first = later<HttpResponseLike>();
    const result = askJevRace({ ...base, sleep: t.sleep, providers: [vllm, openrouter], fetch: async (url: string) => (url.includes("vllm") ? first.promise : answer) });
    await tick();
    first.resolve(answer);
    const r = await result;
    assert.ok(r.ok);
    assert.deepEqual(r.tries?.map((x) => [x.name, x.outcome, x.start]), [["vllm", "won", 0], ["openrouter", "answered", 0]]);
    assert.ok(r.tries?.every((x) => typeof x.ms === "number"));
  });

  test("all failing keeps each one's part", async () => {
    const r = await askJevRace({ ...base, staggerMs: 100, sleep: timers().sleep, providers: [vllm, openrouter], fetch: async () => down });
    assert.ok(!r.ok);
    assert.equal(r.reason, "vllm said HTTP 503; openrouter said HTTP 503");
    assert.deepEqual(r.tries?.map((x) => x.outcome), ["failed", "failed"]);
  });

  test("the chain keeps each one's part too; one provider has none", async () => {
    const r = await askJevChain({ ...base, sleep: timers().sleep, providers: [vllm, openrouter], fetch: async (url: string) => (url.includes("vllm") ? down : answer) });
    assert.ok(r.ok);
    assert.deepEqual(r.tries?.map((x) => [x.name, x.outcome]), [["vllm", "failed"], ["openrouter", "won"]]);
    const one = await askJevChain({ ...base, sleep: timers().sleep, providers: [vllm], fetch: async () => answer });
    assert.equal(one.tries, undefined);
  });

  test("the stagger from the environment", () => {
    assert.equal(staggerOf(undefined), DEFAULT_STAGGER_MS);
    assert.equal(DEFAULT_STAGGER_MS, 0, "all at once unless set");
    assert.equal(staggerOf("400"), 400);
    assert.equal(staggerOf("later"), DEFAULT_STAGGER_MS);
    assert.equal(staggerOf("99999"), MAX_TIMEOUT_MS);
  });
});
