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
 *   --laya-concurrency 1        how many prompts at once go to your Laya server (default 1: a server on a NAS
 *                               that is asked four things at once answers each slower, and the table's
 *                               latency would be the queue's, not the model's)
 *   --laya-catalog              list the models your Laya server offers (GET <laya>/v1/models) and exit
 *   --criteria a.json,b.json    other wording for the tier descriptions, to try against the one the router
 *                               sends (the built-in wording is always run first, so the others are compared
 *                               with it). Each file: {"criteria": {"haiku": "...", "sonnet": "..."},
 *                               "instructions": "..."}, any part of it. Tune on one set of prompts and confirm
 *                               on another: wording picked on the set it is scored on is flattered by it.
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
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { requestBodyOf, stateOf } from "../../hooks/jev.ts";
import { decisionOf, isContinuation, isEngineNudge, parseOverride } from "../../hooks/policy.ts";
import { confidenceSourceOf, layaBaseOf } from "../../hooks/provider.ts";
import { agreement, report, summarize, table, TIERS } from "./metrics.mjs";

const TIMEOUT_MS = 20_000;

const MAX_WORDING = 800;

/**
 * Other wording for the tier question, from a file: `{ criteria, instructions }`.
 * Unknown tiers and anything that is not a short string are refused, so a typo is
 * an error and not a silent run on the built-in wording.
 */
export function wordingOf(raw, name = "wording") {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${name}: not an object`);
  const out = { name };
  const text = (v, what) => {
    if (typeof v !== "string" || v.trim() === "" || v.length > MAX_WORDING) throw new Error(`${name}: ${what} must be text of up to ${MAX_WORDING} characters`);
    return v.trim();
  };
  for (const key of Object.keys(raw)) if (key !== "criteria" && key !== "instructions") throw new Error(`${name}: unknown key ${JSON.stringify(key)} (use "criteria" and "instructions")`);
  if (raw.criteria !== undefined) {
    if (typeof raw.criteria !== "object" || raw.criteria === null || Array.isArray(raw.criteria)) throw new Error(`${name}: "criteria" must map tiers to text`);
    out.criteria = {};
    for (const [tier, v] of Object.entries(raw.criteria)) {
      if (!TIERS.includes(tier)) throw new Error(`${name}: ${JSON.stringify(tier)} is not a tier (${TIERS.join(", ")})`);
      out.criteria[tier] = text(v, `the description of ${tier}`);
    }
  }
  if (raw.instructions !== undefined) out.instructions = text(raw.instructions, "the instructions");
  if (out.criteria === undefined && out.instructions === undefined) throw new Error(`${name}: nothing to change`);
  return out;
}

/** `laya:multilingual` is a model on your Laya server; anything else is an OpenRouter model id. */
export function specOf(spec) {
  const m = /^laya:(.+)$/.exec(spec);
  return m ? { route: "laya", model: m[1] } : { route: "openrouter", model: spec };
}

/** One question to one model. Resolves to a row; never throws. */
export async function ask({ base, api, key, model, prompt, offered = TIERS, route = "openrouter", wording, fetchImpl = fetch }) {
  const laya = route === "laya";
  const path = laya ? "/v1/systemone" : api === "systemone" ? "/api/v1/systemone" : "/api/alpha/decisions";
  const body = { ...requestBodyOf(stateOf(prompt), offered, "prompt", wording), model };
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
export async function run({ cases, models, base, api, key, layaBase, layaKey = "", concurrency = 4, layaConcurrency = 1, confidence = "probabilities", offered = TIERS, wordings = [], fetchImpl }) {
  const rows = {};
  // The built-in wording first, then each other; a model asked with several is listed once per wording.
  const variants = [undefined, ...wordings];
  for (const spec of models) {
    const { route, model } = specOf(spec);
    for (const wording of variants) {
      const label = wording === undefined ? spec : `${spec} [${wording.name}]`;
      rows[label] = await pool(cases, route === "laya" ? layaConcurrency : concurrency, async (c) => {
        const r =
          route === "laya"
            ? await ask({ base: layaBase, api, key: layaKey, model, prompt: c.prompt, offered, route, wording, fetchImpl })
            : await ask({ base, api, key, model, prompt: c.prompt, offered, wording, fetchImpl });
        return { id: c.id, label: c.tier, ...r, confidence: confidence === "router" ? r.confidence : r.confidenceP };
      });
    }
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
  let wordings = [];
  try {
    wordings = arg("criteria", "").split(",").map((f) => f.trim()).filter(Boolean).map((f) => wordingOf(JSON.parse(readFileSync(f, "utf8")), basename(f).replace(/\.json$/, "")));
  } catch (e) {
    console.error(`--criteria: ${e.message}`);
    process.exit(2);
  }
  if (wordings.length > 0) console.log(`Wording: the router's own, then ${wordings.map((w) => w.name).join(", ")}. Choose on one set of prompts and confirm on another.\n`);
  const mode = arg("confidence", "probabilities");
  const result = await run({ cases, models, base, api: arg("api", "decisions"), key, layaBase: layaUrl.ok ? layaUrl.base : undefined, layaKey, concurrency: Number(arg("concurrency", "4")), layaConcurrency: Number(arg("laya-concurrency", "1")), confidence: mode, offered, wordings });
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
