/**
 * Asks each decision model the question the router asks, on every labelled
 * prompt, and reports how well each does: how often it picks the tier you
 * labelled, how often too low or too high, how its confidence stands against
 * how often it is right, how many answers clear the router's confidence bar,
 * and what it costs and how long it takes.
 *
 *   OPENROUTER_API_KEY=… node --experimental-strip-types scripts/bench/run.mjs \
 *     --cases cases.jsonl --models typesafe/jev-1.14,perplexity/pplx-decider-v1.2
 *   node --experimental-strip-types scripts/bench/run.mjs --catalog     # the decision models on offer; needs no key
 *
 * Options:
 *   --api decisions|systemone   OpenRouter's Decisions API (default) or its System One endpoint (Jev only)
 *   --confidence probabilities|router   which number the table reads (default probabilities: the same
 *                                       measure for every model; `router` is what the plugin would read)
 *   --concurrency 4  --limit N  --out results.json  --base https://openrouter.ai
 *
 * The prompts are sent to OpenRouter and on to each model's provider: use
 * prompts you are willing to send. Labels come from scripts/bench/label.mjs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { requestBodyOf, stateOf } from "../../hooks/jev.ts";
import { decisionOf } from "../../hooks/policy.ts";
import { confidenceSourceOf, labelOf } from "../../hooks/provider.ts";
import { agreement, summarize, table, TIERS } from "./metrics.mjs";

const TIMEOUT_MS = 20_000;

/** One question to one model. Resolves to a row; never throws. */
export async function ask({ base, api, key, model, prompt, fetchImpl = fetch }) {
  const path = api === "systemone" ? "/api/v1/systemone" : "/api/alpha/decisions";
  const body = { ...requestBodyOf(stateOf(prompt), TIERS), model };
  const started = performance.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const ms = performance.now() - started;
      if (!res.ok) return { pick: null, ms, error: `HTTP ${res.status}` };
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { pick: null, ms, error: "not JSON" };
      }
      // The router's own reading of the answer, and the one every model is measured by.
      const source = confidenceSourceOf("openrouter", model);
      const router = decisionOf(json.answers, TIERS, source);
      const common = decisionOf(json.answers, TIERS, "probabilities");
      if (router === null || common === null) return { pick: null, ms, error: "no usable tier" };
      const cost = typeof json.usage?.cost === "number" ? json.usage.cost : undefined;
      return {
        pick: router.tier,
        confidence: router.confidence,
        confidenceP: common.confidence,
        effort: router.effort,
        ms,
        ...(cost !== undefined ? { cost } : {}),
        ...(typeof json.model === "string" ? { resolved: json.model } : {}),
      };
    } catch (e) {
      if (attempt === 1 || controller.signal.aborted) return { pick: null, ms: performance.now() - started, error: controller.signal.aborted ? "timed out" : "request failed" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { pick: null, ms: performance.now() - started, error: "request failed" };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, size) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Runs every model over every case. Returns { rows: { model: row[] }, summaries, agreement }. */
export async function run({ cases, models, base, api, key, concurrency = 4, confidence = "probabilities", fetchImpl }) {
  const rows = {};
  for (const model of models) {
    rows[model] = await pool(cases, concurrency, async (c) => {
      const r = await ask({ base, api, key, model, prompt: c.prompt, fetchImpl });
      return { id: c.id, label: c.tier, ...r, confidence: confidence === "router" ? r.confidence : r.confidenceP };
    });
  }
  const summaries = Object.fromEntries(Object.entries(rows).map(([m, r]) => [m, summarize(r)]));
  return { rows, summaries, agreement: agreement(rows) };
}

/** The decision models OpenRouter lists, as lines. */
export async function catalog({ base, fetchImpl = fetch }) {
  const res = await fetchImpl(`${base}/api/v1/models?output_modalities=decisions`);
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length,
    price: m.pricing?.prompt,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const base = arg("base", "https://openrouter.ai").replace(/\/$/, "");
  if (process.argv.includes("--catalog")) {
    for (const m of await catalog({ base })) console.log(`${m.id.padEnd(44)} context ${String(m.context ?? "?").padEnd(8)} $/token in ${m.price ?? "?"}`);
    process.exit(0);
  }
  const key = process.env.OPENROUTER_API_KEY;
  const casesFile = arg("cases");
  if (!key || !casesFile) {
    console.error("usage: OPENROUTER_API_KEY=… run.mjs --cases cases.jsonl --models a/b,c/d   (or --catalog)");
    process.exit(2);
  }
  const all = readFileSync(casesFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const cases = all.filter((c) => TIERS.includes(c.tier)).slice(0, Number(arg("limit", "100000")));
  if (cases.length === 0) {
    console.error("no labelled cases: run scripts/bench/label.mjs first");
    process.exit(2);
  }
  const models = arg("models", "typesafe/jev-1.14").split(",").map((m) => m.trim()).filter(Boolean);
  const mode = arg("confidence", "probabilities");
  const result = await run({ cases, models, base, api: arg("api", "decisions"), key, concurrency: Number(arg("concurrency", "4")), confidence: mode });
  console.log(`${cases.length} labelled prompts, ${models.length} models, confidence read from ${mode === "router" ? "what the router reads" : "the probabilities"}\n`);
  console.log(table(result.summaries));
  console.log("\nAgreement on the tier:");
  for (const [pair, share] of Object.entries(result.agreement)) console.log(`  ${pair.replace("|", "  vs  ")}  ${share === null ? "–" : `${Math.round(share * 100)}%`}`);
  const out = arg("out", "bench-results.json");
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nRows and summaries written to ${out}`);
}
