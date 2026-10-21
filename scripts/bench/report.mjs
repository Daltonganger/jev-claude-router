/**
 * Reads bench-results.json again and prints the table, your label counts, the
 * always-one-tier baselines, a confusion matrix per model and the sign test
 * against the first model. It asks nothing and costs nothing.
 *
 *   node --experimental-strip-types scripts/bench/report.mjs bench-results.json
 *
 * Given several files it puts their models side by side, so a model run later
 * (a Laya server, say) is compared with the ones run before without asking
 * them again. The files must come from the same labelled prompts: the same
 * cases, in the same order, run with the same --tiers and --confidence.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { agreement, report, summarize, table } from "./metrics.mjs";

/** The rows of several results files as one object, or an error naming the file that does not fit. */
export function merge(files) {
  const rows = {};
  let ids = null;
  for (const { name, data } of files) {
    for (const [model, r] of Object.entries(data.rows ?? {})) {
      const these = r.map((x) => x.id).join(",");
      if (ids === null) ids = these;
      else if (these !== ids) throw new Error(`${name}: ${model} was run on different prompts than the first file; run them on the same cases.`);
      let key = model;
      while (key in rows) key += "'";
      rows[key] = r;
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["bench-results.json"];
  let rows;
  try {
    rows = merge(names.map((name) => ({ name, data: JSON.parse(readFileSync(name, "utf8")) })));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const summaries = Object.fromEntries(Object.entries(rows).map(([m, r]) => [m, summarize(r)]));
  console.log(table(summaries));
  console.log(`\n${report(rows, summaries)}`);
  console.log("\nAgreement on the tier:");
  for (const [pair, share] of Object.entries(agreement(rows))) console.log(`  ${pair.replace("|", "  vs  ")}  ${share === null ? "–" : `${Math.round(share * 100)}%`}`);
}
