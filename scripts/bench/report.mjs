/**
 * Reads bench-results.json again and prints the table, your label counts, the
 * always-one-tier baselines, a confusion matrix per model and the sign test
 * against the first model. It asks nothing and costs nothing.
 *
 *   node --experimental-strip-types scripts/bench/report.mjs bench-results.json
 */
import { readFileSync } from "node:fs";

import { agreement, report, summarize, table } from "./metrics.mjs";

const file = process.argv[2] ?? "bench-results.json";
const { rows } = JSON.parse(readFileSync(file, "utf8"));
const summaries = Object.fromEntries(Object.entries(rows).map(([m, r]) => [m, summarize(r)]));
console.log(table(summaries));
console.log(`\n${report(rows, summaries)}`);
console.log("\nAgreement on the tier:");
for (const [pair, share] of Object.entries(agreement(rows))) console.log(`  ${pair.replace("|", "  vs  ")}  ${share === null ? "–" : `${Math.round(share * 100)}%`}`);
