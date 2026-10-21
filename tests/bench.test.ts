/**
 * Tests for the benchmark tools in scripts/bench: the numbers they report,
 * the prompts they pull from transcripts, and a run against a local stand-in
 * for OpenRouter's Decisions API.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

// @ts-expect-error plain JavaScript modules
import { agreement, percentile, summarize, table } from "../scripts/bench/metrics.mjs";
// @ts-expect-error plain JavaScript modules
import { seeded, typedPrompt } from "../scripts/bench/extract.mjs";
// @ts-expect-error plain JavaScript modules
import { ask, catalog, run } from "../scripts/bench/run.mjs";

const row = (label: string, pick: string | null, confidence = 0.9, ms = 100, cost = 0.00001) => ({ label, pick, confidence, ms, cost });

describe("metrics", () => {
  test("percentile is nearest rank, and null for nothing", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
    assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
    assert.equal(percentile([5, Number.NaN, 7], 0.5), 5);
  });

  test("exact, within one, too low and too high are counted on the answered cases", () => {
    const s = summarize([
      row("opus", "opus"),
      row("opus", "sonnet"), // too low, within one
      row("haiku", "fable"), // too high, far
      row("sonnet", "sonnet"),
      row("fable", null), // an error: not answered
    ]);
    assert.equal(s.cases, 5);
    assert.equal(s.answered, 4);
    assert.equal(s.accuracy, 0.5);
    assert.equal(s.withinOne, 0.75);
    assert.equal(s.under, 0.25);
    assert.equal(s.over, 0.25);
  });

  test("a case without a usable label is not scored", () => {
    const s = summarize([row("skip", "opus"), row("opus", "opus")]);
    assert.equal(s.answered, 1);
  });

  test("calibration: a model that says 90% and is right half the time is off by 0.4", () => {
    const rows = [row("opus", "opus", 0.9), row("opus", "haiku", 0.9), row("opus", "opus", 0.9), row("opus", "haiku", 0.9)];
    const s = summarize(rows);
    assert.ok(Math.abs((s.ece ?? 0) - 0.4) < 1e-9);
    const bin = s.bins.find((b: { n: number }) => b.n > 0);
    assert.equal(bin.accuracy, 0.5);
    assert.ok(Math.abs(bin.said - 0.9) < 1e-9);
  });

  test("a model that is exactly as sure as it is right has no calibration error", () => {
    const rows = [...Array(9)].map(() => row("opus", "opus", 0.9)).concat([row("opus", "haiku", 0.9)]);
    assert.ok(Math.abs(summarize(rows).ece ?? 1) < 1e-9);
  });

  test("the bar: how many answers clear it, and how often those are right", () => {
    const s = summarize([row("opus", "opus", 0.95), row("opus", "haiku", 0.8), row("opus", "opus", 0.5), row("opus", "opus", 0.2)]);
    assert.equal(s.bars[0.75].share, 0.5);
    assert.equal(s.bars[0.75].accuracy, 0.5);
    assert.equal(s.bars[0.9].share, 0.25);
    assert.equal(s.bars[0.9].accuracy, 1);
    assert.equal(s.bars[0.6].share, 0.5);
  });

  test("latency and cost per thousand decisions", () => {
    const s = summarize([row("opus", "opus", 0.9, 100, 0.00002), row("opus", "opus", 0.9, 300, 0.00004)]);
    assert.equal(s.meanMs, 200);
    assert.equal(s.p50Ms, 100);
    assert.equal(s.p95Ms, 300);
    assert.ok(Math.abs((s.costPer1k ?? 0) - 0.03) < 1e-9);
  });

  test("no answers at all gives nulls, not NaN", () => {
    const s = summarize([row("opus", null, 0, Number.NaN, Number.NaN)]);
    assert.equal(s.accuracy, null);
    assert.equal(s.ece, null);
    assert.equal(s.costPer1k, null);
    assert.equal(s.bars[0.75].share, null);
  });

  test("agreement is on the cases both answered", () => {
    const a = [row("x", "opus"), row("x", "haiku"), row("x", null)];
    const b = [row("x", "opus"), row("x", "sonnet"), row("x", "fable")];
    assert.deepEqual(agreement({ a, b }), { "a|b": 0.5 });
  });

  test("the table has a row per model", () => {
    const t = table({ m1: summarize([row("opus", "opus")]), m2: summarize([row("opus", "haiku")]) });
    assert.equal(t.split("\n").length, 4);
    assert.match(t, /\| m1 \| 1\/1 \| 100% /);
  });
});

describe("extract", () => {
  const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });

  test("takes what a person typed", () => {
    assert.equal(typedPrompt(user("rename foo to bar in utils.ts")), "rename foo to bar in utils.ts");
    assert.equal(typedPrompt(user([{ type: "text", text: "  two blocks " }, { type: "text", text: "of text" }])), "two blocks \nof text");
  });

  test("leaves out tool results, subagent and meta turns, commands and engine text", () => {
    for (const line of [
      user([{ type: "tool_result", content: "x" }]),
      user("something a subagent was told", { isSidechain: true }),
      user("a meta turn that is long enough", { isMeta: true }),
      user("<system-reminder>something</system-reminder>"),
      user("[Request interrupted by user]"),
      user("/jev tiers off fable"),
      user("short"),
      JSON.stringify({ type: "assistant", message: { content: "a reply that is long enough" } }),
      "not json",
    ])
      assert.equal(typedPrompt(line), null, line.slice(0, 40));
  });

  test("a long prompt is cut", () => {
    const t = typedPrompt(user("x".repeat(2000)));
    assert.equal(t?.length, 601);
  });

  test("a seed gives the same shuffle, and a different seed another", () => {
    const items = [...Array(20).keys()];
    assert.deepEqual(seeded(items, 3), seeded(items, 3));
    assert.notDeepEqual(seeded(items, 3), seeded(items, 4));
    assert.deepEqual([...seeded(items, 3)].sort((a, b) => a - b), items);
  });
});

/** A stand-in for OpenRouter's Decisions API: the tier follows a keyword in the state. */
function standIn() {
  const seen: { path: string; auth: string | undefined; model: string; questions: string[] }[] = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url?.startsWith("/api/v1/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "typesafe/jev-1.14", name: "Jev 1.14", context_length: 8000, pricing: { prompt: "0.000000042" } }] }));
        return;
      }
      const body = JSON.parse(b);
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, model: body.model, questions: Object.keys(body.questions) });
      const state: string = body.state;
      if (body.model === "bad/model") {
        res.statusCode = 500;
        res.end("{}");
        return;
      }
      const tier = /rename|typo/.test(state) ? "haiku" : /small edit/.test(state) ? "sonnet" : /plan/.test(state) ? "fable" : "opus";
      // The model called "unsure" splits its mass; the others are sure.
      const p = body.model === "unsure/model" ? 0.5 : 0.97;
      const probabilities = Object.fromEntries(["haiku", "sonnet", "opus", "fable"].map((t) => [t, t === tier ? p : (1 - p) / 3]));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "gen-dec-1",
          model: `${body.model}-20261014`,
          answers: {
            tier: { type: "choice", choice: tier, probabilities, confidence: 0.123 },
            effort: { type: "score", score: 2, probabilities: [0.1, 0.2, 0.4, 0.2, 0.1] },
          },
          usage: { cost: 0.00002 },
        }),
      );
    });
  });
  return new Promise<{ base: string; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    }),
  );
}

const cases = [
  { id: 1, prompt: "rename foo to bar", tier: "haiku" },
  { id: 2, prompt: "a small edit to the handler", tier: "sonnet" },
  { id: 3, prompt: "implement the export endpoint", tier: "opus" },
  { id: 4, prompt: "plan the migration", tier: "fable" },
  { id: 5, prompt: "fix the typo", tier: "sonnet" },
];

describe("run, against a stand-in for the Decisions API", () => {
  test("asks the router's own questions of each model and scores them", async () => {
    const s = await standIn();
    try {
      const r = await run({ cases, models: ["typesafe/jev-1.14", "unsure/model", "bad/model"], base: s.base, api: "decisions", key: "k" });
      // The same two questions the router asks, to the Decisions endpoint, with the key.
      assert.ok(s.seen.length >= 10);
      assert.ok(s.seen.every((x) => x.path === "/api/alpha/decisions" && x.auth === "Bearer k" && x.questions.join() === "tier,effort"));
      // Jev here gets 4 of 5 (the typo case is labelled sonnet, answered haiku).
      assert.equal(r.summaries["typesafe/jev-1.14"].accuracy, 0.8);
      assert.equal(r.summaries["typesafe/jev-1.14"].under, 0.2);
      // The unsure model picks the same tiers but says so: its confidence is lower, read from the probabilities.
      assert.equal(r.summaries["unsure/model"].accuracy, 0.8);
      assert.ok(r.rows["unsure/model"][0].confidence < r.rows["typesafe/jev-1.14"][0].confidence);
      assert.equal(r.summaries["unsure/model"].bars[0.75].share, 0);
      // A model that errors is counted, not scored.
      assert.equal(r.summaries["bad/model"].errors, 5);
      assert.equal(r.summaries["bad/model"].answered, 0);
      assert.equal(r.agreement["typesafe/jev-1.14|unsure/model"], 1);
      // Cost comes from the response, latency is measured.
      assert.ok(Math.abs(r.summaries["typesafe/jev-1.14"].costPer1k - 0.02) < 1e-9);
      assert.ok(r.summaries["typesafe/jev-1.14"].meanMs >= 0);
    } finally {
      s.close();
    }
  });

  test("the table reads the probabilities for every model by default, the router's reading on request", async () => {
    const s = await standIn();
    try {
      const common = await run({ cases: cases.slice(0, 1), models: ["typesafe/jev-1.14"], base: s.base, api: "decisions", key: "k" });
      const router = await run({ cases: cases.slice(0, 1), models: ["typesafe/jev-1.14"], base: s.base, api: "decisions", key: "k", confidence: "router" });
      // From the probabilities: (4·0.97 − 1)/3. As the router reads Jev: the `confidence` field, 0.123.
      assert.ok(Math.abs(common.rows["typesafe/jev-1.14"][0].confidence - (4 * 0.97 - 1) / 3) < 1e-9);
      assert.equal(router.rows["typesafe/jev-1.14"][0].confidence, 0.123);
    } finally {
      s.close();
    }
  });

  test("System One mode uses that endpoint", async () => {
    const s = await standIn();
    try {
      await ask({ base: s.base, api: "systemone", key: "k", model: "typesafe/jev-1.14", prompt: "rename foo" });
      assert.equal(s.seen[0]?.path, "/api/v1/systemone");
    } finally {
      s.close();
    }
  });

  test("a request that fails or answers nonsense is an error row, never a throw", async () => {
    const boom = async () => {
      throw new Error("offline");
    };
    const r = await ask({ base: "http://x", api: "decisions", key: "k", model: "m", prompt: "p", fetchImpl: boom as unknown as typeof fetch });
    assert.equal(r.pick, null);
    assert.equal(r.error, "request failed");
    const nonsense = async () => new Response("{\"answers\":{}}", { status: 200 });
    const n = await ask({ base: "http://x", api: "decisions", key: "k", model: "m", prompt: "p", fetchImpl: nonsense as unknown as typeof fetch });
    assert.equal(n.error, "no usable tier");
  });

  test("the command line says why a model failed", async () => {
    const s = await standIn();
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const casesFile = join(dir, "cases.jsonl");
      writeFileSync(casesFile, cases.slice(0, 2).map((c) => JSON.stringify(c)).join("\n") + "\n");
      const script = new URL("../scripts/bench/run.mjs", import.meta.url).pathname;
      const { execFile } = await import("node:child_process");
      const stdout = await new Promise<string>((resolve, reject) =>
        execFile(process.execPath, ["--experimental-strip-types", script, "--cases", casesFile, "--models", "bad/model", "--base", s.base, "--out", join(dir, "o.json")], { env: { ...process.env, OPENROUTER_API_KEY: "k" } }, (err, so) => (err ? reject(err) : resolve(so))),
      );
      assert.match(stdout, /bad\/model failed: HTTP 500 ×2/);
    } finally {
      s.close();
    }
  });

  test("the catalog lists the decision models", async () => {
    const s = await standIn();
    try {
      const list = await catalog({ base: s.base });
      assert.deepEqual(list, [{ id: "typesafe/jev-1.14", name: "Jev 1.14", context: 8000, price: "0.000000042" }]);
    } finally {
      s.close();
    }
  });

  test("the command line prints the table and writes the rows", async () => {
    const s = await standIn();
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const casesFile = join(dir, "cases.jsonl");
      writeFileSync(casesFile, cases.map((c) => JSON.stringify(c)).join("\n") + "\n" + JSON.stringify({ id: 9, prompt: "unlabelled", tier: null }) + "\n");
      const script = new URL("../scripts/bench/run.mjs", import.meta.url).pathname;
      const out = join(dir, "out.json");
      const stdout = await new Promise<string>((resolve, reject) => {
        import("node:child_process").then(({ execFile }) =>
          execFile(process.execPath, ["--experimental-strip-types", script, "--cases", casesFile, "--models", "typesafe/jev-1.14", "--base", s.base, "--out", out], { env: { ...process.env, OPENROUTER_API_KEY: "k" } }, (err, so) => (err ? reject(err) : resolve(so))),
        );
      });
      assert.match(stdout, /5 labelled prompts, 1 models/);
      assert.match(stdout, /\| typesafe\/jev-1\.14 \| 5\/5 \| 80% /);
      assert.doesNotMatch(stdout, /failed:/);
      assert.equal(JSON.parse(readFileSync(out, "utf8")).summaries["typesafe/jev-1.14"].answered, 5);
    } finally {
      s.close();
    }
  });
});

