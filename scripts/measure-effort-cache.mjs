/**
 * Whether changing effort between requests costs the prompt cache, measured
 * on the real API for one model. It spends a few cents.
 *
 *   ANTHROPIC_API_KEY=… npm run measure-effort-cache                       # claude-haiku-5-5
 *   ANTHROPIC_API_KEY=… npm run measure-effort-cache -- claude-sonnet-5-5  # another model
 *   npm run measure-effort-cache -- --dry-run                              # print the requests, send nothing
 *
 * Four requests share one long first message (with a cache breakpoint on it):
 *
 *   1  effort low, top level               writes the cache
 *   2  effort low again                    control: must read it
 *   3  effort high, top level              the change Anthropic's docs say restarts the cache
 *   4  effort high, in a system message    per-message effort (beta); top level stays low
 *
 * Step 4 against step 1's cache is the question for a model that has per-message
 * effort: does it keep the cache? Step 3 is the same question for a model that
 * has only the top-level value. Run it on each model the router sends effort to.
 * What Claude Code itself sends is a separate matter: compare a turn's
 * `(NN% cached)` in `/jev` across an effort change on that model.
 */

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const model = args.find((a) => !a.startsWith("--")) ?? "claude-haiku-5-5";
const BETA = "mid-conversation-output-config-2026-07-01";

// A prefix well past every model's minimum cacheable length, unique per run so
// an earlier run's cache cannot answer for this one.
const nonce = Math.random().toString(36).slice(2);
const filler = Array.from(
  { length: 160 },
  (_, i) => `Paragraph ${i + 1}. The migration plan keeps each step small, reversible and checked against the row counts before the next one starts.`,
).join("\n");
const first = {
  role: "user",
  content: [{ type: "text", text: `Run ${nonce}.\n${filler}\n\nReply with one word.`, cache_control: { type: "ephemeral" } }],
};
const assistant = { role: "assistant", content: "Understood." };

const request = (effort, messages, extra = {}) => ({
  model,
  max_tokens: 32,
  output_config: { effort },
  messages,
  ...extra,
});

const steps = [
  { name: "1 effort low (writes the cache)", body: request("low", [first, assistant, { role: "user", content: "Go." }]) },
  { name: "2 effort low again (control)", body: request("low", [first, assistant, { role: "user", content: "Go again." }]) },
  { name: "3 top-level effort high", body: request("high", [first, assistant, { role: "user", content: "Go." }]) },
  {
    name: "4 per-message effort high (beta)",
    beta: true,
    body: request("low", [first, assistant, { role: "system", content: [], output_config: { effort: "high" } }, { role: "user", content: "Go." }]),
  },
];

if (dry) {
  for (const s of steps) {
    const shown = JSON.stringify(s.body, (k, v) => (k === "text" ? `${String(v).slice(0, 40)}… (${String(v).length} chars)` : v), 2);
    console.log(`# ${s.name}${s.beta ? `  [anthropic-beta: ${BETA}]` : ""}\n${shown}\n`);
  }
  process.exit(0);
}

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("Set ANTHROPIC_API_KEY (or use --dry-run to see the requests).");
  process.exit(2);
}

const results = [];
for (const s of steps) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(s.beta ? { "anthropic-beta": BETA } : {}),
    },
    body: JSON.stringify(s.body),
  });
  const text = await res.text();
  if (!res.ok) {
    // The status and the API's own error type; never the request, which holds the key's header.
    let type = "";
    try {
      type = JSON.parse(text)?.error?.message ?? "";
    } catch {}
    results.push({ name: s.name, error: `HTTP ${res.status} ${String(type).slice(0, 160)}` });
    continue;
  }
  const u = JSON.parse(text).usage ?? {};
  results.push({ name: s.name, read: u.cache_read_input_tokens ?? 0, wrote: u.cache_creation_input_tokens ?? 0, fresh: u.input_tokens ?? 0 });
  // The cache is readable only once the first response has begun.
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(`Model ${model}\n`);
console.log("step".padEnd(38), "read".padStart(8), "written".padStart(8), "uncached".padStart(9));
for (const r of results) {
  if (r.error) console.log(r.name.padEnd(38), r.error);
  else console.log(r.name.padEnd(38), String(r.read).padStart(8), String(r.wrote).padStart(8), String(r.fresh).padStart(9));
}

const base = results[0];
const prefix = base && !base.error ? base.wrote : 0;
const verdict = (r) => {
  if (!r || r.error || prefix === 0) return "no result";
  if (r.read >= 0.9 * prefix) return "keeps the cache";
  if (r.wrote >= 0.9 * prefix && r.read < 0.1 * prefix) return "restarts the cache (the whole prefix is written again)";
  return "partly keeps it";
};
console.log("");
if (prefix === 0) console.log("Step 1 wrote nothing to the cache, so there is nothing to compare: the prompt may be under this model's minimum.");
else {
  console.log(`Control (same effort):        ${verdict(results[1])}`);
  console.log(`Top-level effort changed:     ${verdict(results[2])}`);
  console.log(`Per-message effort changed:   ${verdict(results[3])}`);
}
