/**
 * Labels each prompt with the tier it needs, by hand. Progress is saved after
 * every answer, so it can be stopped and resumed.
 *
 *   node --experimental-strip-types scripts/bench/label.mjs cases.jsonl
 *
 * Keys: 1 haiku  2 sonnet  3 opus  4 fable  s skip  u undo  q quit.
 * The tiers mean what the router tells the model (hooks/policy.ts, TIER_CRITERIA):
 *   haiku   trivial: a lookup, a rename, a yes or no
 *   sonnet  straightforward and minor: a small edit whose shape is obvious
 *   opus    plain implementation with some complexity
 *   fable   high complexity: planning, architecture, systematic debugging, research
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const file = process.argv[2];
if (!file) {
  console.error("usage: label.mjs cases.jsonl");
  process.exit(2);
}
const cases = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const save = () => writeFileSync(file, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
const KEYS = { 1: "haiku", 2: "sonnet", 3: "opus", 4: "fable" };
const rl = createInterface({ input: process.stdin, output: process.stdout });
const todo = () => cases.findIndex((c) => c.tier === null);
const history = [];
console.log(`${cases.filter((c) => c.tier).length}/${cases.length} labelled.  1 haiku  2 sonnet  3 opus  4 fable  s skip  u undo  q quit\n`);
for (;;) {
  const i = todo();
  if (i === -1) break;
  console.log(`--- ${i + 1}/${cases.length}\n${cases[i].prompt}\n`);
  const a = (await rl.question("tier> ")).trim().toLowerCase();
  if (a === "q") break;
  if (a === "u") {
    const last = history.pop();
    if (last !== undefined) cases[last].tier = null;
  } else if (a === "s") {
    cases[i].tier = "skip";
    history.push(i);
  } else if (KEYS[a]) {
    cases[i].tier = KEYS[a];
    history.push(i);
  }
  save();
}
rl.close();
save();
console.log(`${cases.filter((c) => ["haiku", "sonnet", "opus", "fable"].includes(c.tier)).length} labelled, ${cases.filter((c) => c.tier === "skip").length} skipped.`);
