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
 *   laya:<model>               in --models: your own Laya server instead of OpenRouter, e.g. laya:multilingual.
 *                               The address is LAYA_BASE_URL (or --laya-url), the key LAYA_API_KEY (none if the
 *                               server asks for none). Its confidence is read from x_jev_confidence.
 *   --laya-catalog              list the models your Laya server offers (GET <laya>/v1/models) and exit
 *   --tiers haiku,sonnet,opus   the tiers the model may choose from (default all four). Use the tiers the
 *                               router really offers you: on Pro with fable off, leave fable out, or the
 *                               model is asked to pick a tier you would never get.
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
import { decisionOf, isContinuation, isEngineNudge, parseOverride } from "../../hooks/policy.ts";
import { confidenceSourceOf, layaBaseOf } from "../../hooks/provider.ts";
import { agreement, report, summarize, table, TIERS } from "./metrics.mjs";

const TIMEOUT_MS = 20_000;

/** `laya:multilingual` is a model on your Laya server; anything else is an OpenRouter model id. */
export function specOf(spec) {
  const m = /^laya:(.+)$/.exec(spec);
  return m ? { route: "laya", model: m[1] } : { route: "openrouter", model: spec };
}

/** One question to one model. Resolves to a row; never throws. */
export async function ask({ base, api, key, model, prompt, offered = TIERS, route = "openrouter", fetchImpl = fetch }) {
  const laya = route === "laya";
  const path = laya ? "/v1/systemone" : api === "systemone" ? "/api/v1/systemone" : "/api/alpha/decisions";
  const body = { ...requestBodyOf(stateOf(prompt), offered), model };
  const started = performance.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        // A Laya server on your own network may ask for no key.
        headers: { ...(key === "" ? {} : { authorization: `Bearer ${key}` }), "content-type": "application/json" },
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
      const source = confidenceSourceOf(route, model);
      const router = decisionOf(json.answers, offered, source);
      const common = decisionOf(json.answers, offered, "probabilities");
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
        // Whether the Jev-scale number was where it was expected, for a Laya server.
        ...(laya
          ? {
              xjev: {
                tier: typeof json.answers?.tier?.x_jev_confidence === "number",
                effort: typeof json.answers?.effort?.x_jev_confidence === "number",
              },
            }
          : {}),
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
export async function run({ cases, models, base, api, key, layaBase, layaKey = "", concurrency = 4, confidence = "probabilities", offered = TIERS, fetchImpl }) {
  const rows = {};
  for (const spec of models) {
    const { route, model } = specOf(spec);
    rows[spec] = await pool(cases, concurrency, async (c) => {
      const r =
        route === "laya"
          ? await ask({ base: layaBase, api, key: layaKey, model, prompt: c.prompt, offered, route, fetchImpl })
          : await ask({ base, api, key, model, prompt: c.prompt, offered, fetchImpl });
      return { id: c.id, label: c.tier, ...r, confidence: confidence === "router" ? r.confidence : r.confidenceP };
    });
  }
  const summaries = Object.fromEntries(Object.entries(rows).map(([m, r]) => [m, summarize(r)]));
  return { rows, summaries, agreement: agreement(rows) };
}

/**
 * Whether the router would ask the model about this prompt at all. A bare
 * go-ahead continues the last route, an engine nudge does too, and a tier
 * named in the prompt is taken as given; none of those reach the decision
 * model, so they are not part of what is being compared.
 */
export function routerAsks(prompt) {
  return !isContinuation(prompt) && !isEngineNudge(prompt) && parseOverride(prompt) === null;
}

/** The models your Laya server lists, as lines. */
export async function layaCatalog({ base, key = "", fetchImpl = fetch }) {
  const res = await fetchImpl(`${base}/v1/models`, { headers: key === "" ? {} : { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`laya models: HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? json.models ?? []).map((m) => (typeof m === "string" ? m : m.id ?? m.name ?? JSON.stringify(m)));
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
  const layaUrl = layaBaseOf(arg("laya-url", process.env.LAYA_BASE_URL));
  const layaKey = (process.env.LAYA_API_KEY ?? "").trim();
  if (process.argv.includes("--laya-catalog")) {
    if (!layaUrl.ok) throw new Error(layaUrl.reason);
    for (const id of await layaCatalog({ base: layaUrl.base, key: layaKey })) console.log(id);
    process.exit(0);
  }
  const key = process.env.OPENROUTER_API_KEY;
  const casesFile = arg("cases");
  const wanted = arg("models", "typesafe/jev-1.14").split(",").map((m) => m.trim()).filter(Boolean);
  const needsOpenRouter = wanted.some((m) => specOf(m).route === "openrouter");
  if (!casesFile || (needsOpenRouter && !key)) {
    console.error("usage: OPENROUTER_API_KEY=… run.mjs --cases cases.jsonl --models a/b,c/d,laya:multilingual   (or --catalog)");
    process.exit(2);
  }
  if (wanted.some((m) => specOf(m).route === "laya") && !layaUrl.ok) {
    console.error(layaUrl.reason.replace("JEV_ROUTER_PROVIDER=laya but ", ""));
    process.exit(2);
  }
  const all = readFileSync(casesFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const labelled = all.filter((c) => TIERS.includes(c.tier));
  const cases = labelled.filter((c) => routerAsks(c.prompt)).slice(0, Number(arg("limit", "100000")));
  if (cases.length < labelled.length) console.log(`${labelled.length - cases.length} labelled prompts left out: the router does not ask the model about them (a bare go-ahead, an engine nudge, or a tier named in the prompt).`);
  if (cases.length === 0) {
    console.error("no labelled cases: run scripts/bench/label.mjs first");
    process.exit(2);
  }
  const offered = arg("tiers", TIERS.join(",")).split(/[,\s]+/).filter((t) => TIERS.includes(t));
  if (offered.length === 0) {
    console.error(`--tiers names none of ${TIERS.join(", ")}`);
    process.exit(2);
  }
  const outside = cases.filter((c) => !offered.includes(c.tier)).length;
  if (outside > 0) console.log(`${outside} labelled prompts carry a tier that is not offered (${TIERS.filter((t) => !offered.includes(t)).join(", ")}); no model can match them.`);
  const models = wanted;
  const mode = arg("confidence", "probabilities");
  const result = await run({ cases, models, base, api: arg("api", "decisions"), key, layaBase: layaUrl.ok ? layaUrl.base : undefined, layaKey, concurrency: Number(arg("concurrency", "4")), confidence: mode, offered });
  console.log(`${cases.length} labelled prompts, ${models.length} models offered ${offered.join(", ")}, confidence read from ${mode === "router" ? "what the router reads" : "the probabilities"}\n`);
  console.log(table(result.summaries));
  for (const [model, rows] of Object.entries(result.rows)) {
    const answered = rows.filter((r) => r.xjev);
    if (answered.length > 0)
      console.log(`\n${model}: x_jev_confidence was on the tier answer in ${answered.filter((r) => r.xjev.tier).length} of ${answered.length} answers, on the effort answer in ${answered.filter((r) => r.xjev.effort).length}.`);
    const counts = {};
    for (const r of rows) if (r.error) counts[r.error] = (counts[r.error] ?? 0) + 1;
    if (Object.keys(counts).length > 0)
      console.log(`\n${model} failed: ${Object.entries(counts).map(([e, n]) => `${e} ×${n}`).join(", ")}`);
  }
  console.log(`\n${report(result.rows, result.summaries)}`);
  console.log("\nAgreement on the tier:");
  for (const [pair, share] of Object.entries(result.agreement)) console.log(`  ${pair.replace("|", "  vs  ")}  ${share === null ? "–" : `${Math.round(share * 100)}%`}`);
  const out = arg("out", "bench-results.json");
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`\nRows and summaries written to ${out}`);
}
