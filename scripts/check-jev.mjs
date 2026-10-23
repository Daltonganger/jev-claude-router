/**
 * Checks whether every provider in JEV_ROUTER_PROVIDER (or the one the keys choose) will serve requests.
 *
 *   npm run check-jev
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { providersOf } from "../hooks/provider.ts";

// The keys live in ~/.claude/settings.json's `env` (README, step 2); the
// shell's environment is the fallback, so a missing file is not a crash.
let settings = {};
try {
  settings = JSON.parse(readFileSync(`${homedir()}/.claude/settings.json`, "utf8"));
} catch (error) {
  console.error(`note: could not read ~/.claude/settings.json (${error.code ?? error.message}); using the shell's environment`);
}

const env = { ...process.env, ...(settings?.env ?? {}) };
const NAMES = [
  "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "JEV_ROUTER_PROVIDER", "TYPESAFE_BASE_URL",
  "JEV_ROUTER_ALLOW_CUSTOM_BASE", "JEV_ROUTER_JEV_MODEL", "JEV_ROUTER_API", "OPENROUTER_API_KEY",
  "COMMANDCODE_API_KEY", "OPENCODE_API_KEY", "LAYA_BASE_URL", "LAYA_API_KEY", "LAYA_MODEL",
  "VLLM_SR_API_KEY", "VLLM_SR_MODEL",
];
const all = providersOf(Object.fromEntries(NAMES.map((n) => [n, env[n]])));

if (!all.ok) {
  console.error(all.reason);
  process.exit(1);
}

let failed = false;
for (const provider of all.providers) {
  if (!(await check(provider))) failed = true;
}
process.exit(failed ? 1 : 0);

async function check(provider) {
  console.log(`\nprovider       ${provider.name}`);
  const fingerprint = createHash("sha256").update(provider.apiKey).digest("hex").slice(0, 12);
  if (provider.apiKey !== "")
    console.log(`key            ${provider.apiKey.length} chars, sha256[:12]=${fingerprint}`);
  console.log(`model          ${provider.model}`);
  console.log(`endpoint       ${provider.endpoint}`);

  const auth = provider.apiKey === "" ? {} : { authorization: `Bearer ${provider.apiKey}` };

  if (provider.name === "gateway") {
    const credits = await fetch("https://ai-gateway.vercel.sh/v1/credits", { headers: auth });
    const balance = credits.ok ? await credits.json() : null;
    if (!credits.ok) {
      console.log(`credits        HTTP ${credits.status} — the key itself is not being accepted`);
      return false;
    }
    console.log(`credits        balance ${balance.balance}, used ${balance.total_used}`);
  }

  const body = {
    state: "health check from jev-claude-router",
    model: provider.model,
    questions: {
      tier: {
        type: "choice",
        instructions: "Which model tier should answer a trivial rename?",
        criteria: {
          haiku: "Trivial.",
          sonnet: "Straightforward.",
          opus: "Complex.",
          fable: "Hard reasoning.",
        },
      },
    },
  };

  let res;
  try {
    res = await fetch(provider.endpoint, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.log(`evaluate       failed: ${String(error?.cause?.code ?? error?.message ?? error).replaceAll(provider.apiKey || "\0", "[redacted]")}`);
    return false;
  }
  const text = await res.text();
  const redacted = provider.apiKey === "" ? text : text.replaceAll(provider.apiKey, "[redacted]");

  if (!res.ok) {
    console.log(`evaluate       HTTP ${res.status}`);
    console.log(redacted.slice(0, 500));
    return false;
  }

  console.log(`evaluate       ok`);
  try {
    const parsed = JSON.parse(text);
    const tier = parsed.answers?.tier;
    console.log(`choice         ${tier?.choice ?? "(none)"}`);
    console.log(`probabilities  ${tier?.probabilities ? JSON.stringify(tier.probabilities) : "absent"}`);
    console.log(`confidence     ${tier?.confidence ?? "absent"}${tier?.x_jev_confidence !== undefined ? `, x_jev_confidence ${tier.x_jev_confidence}` : ""}`);
    console.log(`answers        ${JSON.stringify(parsed.answers ?? parsed).slice(0, 300)}`);
  } catch {
    console.log(redacted.slice(0, 200));
  }
  return true;
}
