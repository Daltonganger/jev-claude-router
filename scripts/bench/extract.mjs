/**
 * Pulls the prompts you typed out of Claude Code's transcripts into a file to
 * label. It reads locally and writes locally; nothing is sent anywhere. The
 * prompts are your work: keep the output out of the repo (it is in .gitignore).
 *
 *   node --experimental-strip-types scripts/bench/extract.mjs [--dir ~/.claude/projects] [--n 80] [--seed 1] [--out cases.jsonl]
 *
 * Writes one line per prompt: {"id", "prompt", "tier": null}. Label them with
 * scripts/bench/label.mjs.
 */
import { createReadStream, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MIN_CHARS = 8;
const MAX_CHARS = 600;

/** The text of a transcript line if a person typed it, else null. */
export function typedPrompt(line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || d.type !== "user" || d.isSidechain === true || d.isMeta === true) return null;
  const c = d.message?.content;
  let text = null;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c) && c.length > 0 && c.every((b) => b?.type === "text")) text = c.map((b) => b.text).join("\n");
  if (text === null) return null;
  text = text.trim();
  // What the engine and hooks put in the user's turn, not what a person typed.
  if (text.length < MIN_CHARS || /^</.test(text) || /^\[Request interrupted/.test(text) || /^Caveat:/.test(text)) return null;
  if (/^\/[\w:-]+(\s|$)/.test(text) || /^\[\[/.test(text)) return null;
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}

/** A deterministic shuffle, so a seed gives the same sample. */
export function seeded(items, seed) {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function* jsonlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* jsonlFiles(p);
    else if (name.endsWith(".jsonl")) yield p;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const dir = arg("dir", join(homedir(), ".claude", "projects"));
  const n = Number(arg("n", "80"));
  const seed = Number(arg("seed", "1"));
  const out = arg("out", "cases.jsonl");
  const seen = new Set();
  const prompts = [];
  for (const file of jsonlFiles(dir)) {
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      const text = typedPrompt(line);
      if (text === null || seen.has(text)) continue;
      seen.add(text);
      prompts.push(text);
    }
  }
  const picked = seeded(prompts, seed).slice(0, n);
  writeFileSync(out, picked.map((prompt, i) => JSON.stringify({ id: i + 1, prompt, tier: null })).join("\n") + "\n");
  console.log(`${picked.length} of ${prompts.length} prompts written to ${out}. Label them: node --experimental-strip-types scripts/bench/label.mjs ${out}`);
}
