/**
 * Where a confidence bar would help for each model in the results you have. Pools the rows
 * of every file you name, per model, and prints for a range of bars how many answers reach
 * it and how often those are right, then the lowest bar at which the model's confident
 * answers are clearly better than its answers overall, if there is one.
 *
 *   node --experimental-strip-types scripts/bench/bars.mjs wording-a.json wording-b.json
 *
 * It asks nothing and costs nothing. Models are pooled by name, so a model run on two sets
 * is read over both. A model run with other wording is a different name (`model [wider]`).
 * The router reads the confidence the way the benchmark does for a model that is not Jev
 * (from the probabilities), so run the benchmark without `--confidence router`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { barTable, suggestBar, summarize } from "./metrics.mjs";

/** The rows of several results files, pooled by model name. */
export function pool(files) {
  const rows = {};
  for (const data of files) for (const [model, r] of Object.entries(data.rows ?? {})) (rows[model] ??= []).push(...r);
  return rows;
}

const pct = (x) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);

export function barsReport(rows) {
  const out = [];
  for (const [model, r] of Object.entries(rows)) {
    const s = summarize(r);
    out.push(`${model}: ${s.answered} answers, ${pct(s.accuracy)} right overall`);
    out.push("  bar    answers reaching it    right among them    better than the rest (p)");
    for (const b of barTable(r)) out.push(`  ${pct(b.bar).padEnd(6)} ${`${b.n} (${pct(b.share)})`.padEnd(22)} ${pct(b.accuracy).padEnd(19)} ${b.p === null ? "–" : b.p < 0.001 ? "<0.001" : b.p.toFixed(3)}`);
    const pick = suggestBar(r);
    out.push(
      pick === null
        ? `  No bar helps: no bar separates its right answers from its wrong ones (p < 0.01). A bar on this model changes how often the router switches, not how right it is.`
        : `  Suggested bar ${pct(pick.bar)}: ${pct(pick.share)} of answers reach it, ${pct(pick.accuracy)} of those are right, against ${pct(pick.overall)} overall (p = ${pick.p < 0.001 ? "<0.001" : pick.p.toFixed(3)}). Ten bars were looked at: confirm on prompts that were not used to choose it.`,
    );
    out.push("");
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error("usage: bars.mjs results.json [more.json …]");
    process.exit(2);
  }
  console.log(barsReport(pool(names.map((n) => JSON.parse(readFileSync(n, "utf8"))))));
}
