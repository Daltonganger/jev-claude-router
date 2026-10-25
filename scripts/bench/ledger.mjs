/**
 * Turns the ledger's verdicts into a test set: every turn you labelled with
 * `/jev right` or `/jev wrong <tier>`, as cases for `bench:run`. It reads
 * locally and writes locally; nothing is sent anywhere. The prompts are your
 * work: keep the output out of the repo (cases*.jsonl is in .gitignore).
 *
 *   node --experimental-strip-types scripts/bench/ledger.mjs [--store ~/.claude/plugins/store] [--dir ~/.claude/projects] [--out cases-ledger.jsonl] [--all] [--exclude cases.jsonl]
 *
 * The ledger keeps the first 200 characters of a prompt; the whole prompt (up
 * to the 600 `bench:extract` keeps) is found again in the session's transcript
 * under --dir, and the 200 are used when it is not there any more.
 *
 * `--all` writes the unlabelled turns too, with `tier: null`, to label with
 * scripts/bench/label.mjs. Each line: {"id", "prompt", "tier", "jev", "decider", "at"}.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { typedPrompt } from "./extract.mjs";

const TIERS = ["haiku", "sonnet", "opus", "fable"];

/** Every ledger record in a store file's JSON (top level, or one level down). */
export function ledgerEntries(json) {
  const out = [];
  const visit = (obj) => {
    for (const [key, value] of Object.entries(obj ?? {})) {
      if (key.startsWith("ledger:") && Array.isArray(value)) out.push(...value.filter((e) => e && typeof e.id === "string"));
    }
  };
  visit(json);
  if (out.length === 0) for (const value of Object.values(json ?? {})) if (value && typeof value === "object" && !Array.isArray(value)) visit(value);
  return out;
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

/** The whole typed prompt that starts with `head`, from the session's transcript lines. */
export function wholePrompt(head, lines) {
  const want = norm(head);
  for (const line of lines) {
    const text = typedPrompt(line);
    if (text !== null && norm(text).startsWith(want)) return text;
  }
  return null;
}

function* files(dir, test) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p, test);
    else if (test(name)) yield p;
  }
}

async function linesOf(file) {
  const out = [];
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) out.push(line);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const known = ["store", "dir", "out", "all", "exclude"];
  const stray = process.argv.slice(2).find((a) => a.startsWith("--") && !known.includes(a.slice(2)));
  if (stray !== undefined) {
    console.error(`unknown option ${stray}. This script takes: ${known.map((o) => `--${o}`).join(" ")}`);
    process.exit(2);
  }
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const store = arg("store", join(homedir(), ".claude", "plugins", "store"));
  const dir = arg("dir", join(homedir(), ".claude", "projects"));
  const out = arg("out", "cases-ledger.jsonl");
  const all = process.argv.includes("--all");
  const seen = new Set();
  for (const f of arg("exclude", "").split(",").map((s) => s.trim()).filter(Boolean))
    for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) seen.add(norm(JSON.parse(l).prompt));

  const storeFiles = statSync(store, { throwIfNoEntry: false })?.isDirectory()
    ? [...files(store, (n) => n.startsWith("jev-claude-router") && n.endsWith(".json"))]
    : [store];
  const entries = [];
  for (const f of storeFiles) {
    try {
      entries.push(...ledgerEntries(JSON.parse(readFileSync(f, "utf8"))));
    } catch (error) {
      console.error(`skipped ${f}: ${error.message}`);
    }
  }
  const wanted = entries.filter((e) => e.jev && (all || TIERS.includes(e.label))).sort((a, b) => a.at - b.at);

  // Transcripts by session id, read once each.
  const transcripts = new Map();
  for (const f of files(dir, (n) => n.endsWith(".jsonl"))) transcripts.set(basename(f, ".jsonl"), f);
  const cache = new Map();
  let whole = 0;
  const rows = [];
  for (const e of wanted) {
    let prompt = e.prompt;
    const file = e.session ? transcripts.get(e.session) : undefined;
    if (file) {
      if (!cache.has(file)) cache.set(file, await linesOf(file));
      const found = wholePrompt(e.prompt, cache.get(file));
      if (found) {
        prompt = found;
        whole++;
      }
    }
    if (seen.has(norm(prompt))) continue;
    seen.add(norm(prompt));
    rows.push({ id: rows.length + 1, prompt, tier: TIERS.includes(e.label) ? e.label : null, jev: e.jev, decider: e.decider ?? "Jev", at: new Date(e.at).toISOString() });
  }
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  const labelled = rows.filter((r) => r.tier).length;
  console.log(
    `${rows.length} turns written to ${out} (${labelled} labelled, ${whole} with the whole prompt from the transcript). ` +
      (labelled ? `Run them: npm run bench:run -- --cases ${out} --models …` : "Label turns with /jev right or /jev wrong <tier>, or pass --all and label the file."),
  );
}
