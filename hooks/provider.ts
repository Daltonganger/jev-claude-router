/**
 * Provider resolution: which backends (a route to Jev, or Laya) should answer
 * the routing question, based on available keys and user overrides.
 *
 * Precedence:
 * 1. JEV_ROUTER_PROVIDER forces one, or a list tried in order
 *    (`laya,openrouter`): typesafe, gateway, openrouter, commandcode,
 *    opencode, laya. A named route whose key or URL is missing is an error.
 * 2. TypeSafe direct if TYPESAFE_API_KEY is set
 * 3. Laya if LAYA_BASE_URL is set
 * 4. Gateway if AI_GATEWAY_API_KEY is set
 * 5. Error if none is set
 *
 * OpenRouter, Command Code and OpenCode are never chosen by their key alone:
 * those keys are used for other things, and picking one would send every
 * prompt there. They are named in JEV_ROUTER_PROVIDER.
 *
 * TYPESAFE_BASE_URL overrides the TypeSafe endpoint base (defaults to
 * https://api.typesafe.ai). Only https://api.typesafe.ai and hosts under
 * *.typesafe.ai are accepted unless JEV_ROUTER_ALLOW_CUSTOM_BASE=1. The
 * other routes have fixed hosts, and each route has its own key, which goes
 * to that route's host and nowhere else. LAYA_BASE_URL is the exception: it
 * is the address of your own server, any https host, and LAYA_API_KEY goes
 * only there.
 *
 * JEV_ROUTER_JEV_MODEL pins the model on the routes that take one. The
 * default `jev-latest` is an alias that moves when TypeSafe ships a release,
 * and the confidences the sticky bar is tuned against can move with it;
 * TypeSafe's own advice is to pin (`jev-1.13.0` on api.typesafe.ai).
 */

export type RouteName = "typesafe" | "gateway" | "openrouter" | "commandcode" | "opencode" | "laya";

export type ProviderOk = {
  ok: true;
  name: RouteName;
  endpoint: string;
  model: string;
  /** Empty for a Laya server that asks for none. */
  apiKey: string;
};

export type ProviderResult =
  | ProviderOk
  | {
      ok: false;
      reason: string;
    };

export type ProviderEnv = {
  TYPESAFE_API_KEY: string | undefined;
  AI_GATEWAY_API_KEY: string | undefined;
  JEV_ROUTER_PROVIDER: string | undefined;
  TYPESAFE_BASE_URL: string | undefined;
  JEV_ROUTER_ALLOW_CUSTOM_BASE?: string | undefined;
  JEV_ROUTER_JEV_MODEL?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  COMMANDCODE_API_KEY?: string | undefined;
  OPENCODE_API_KEY?: string | undefined;
  LAYA_BASE_URL?: string | undefined;
  LAYA_API_KEY?: string | undefined;
};

const TYPESAFE_MODEL_DEFAULT = "jev-latest";

const TYPESAFE_BASE_DEFAULT = "https://api.typesafe.ai";
const GATEWAY_BASE = "https://ai-gateway.vercel.sh";

/** What the name of a route is on the route line, where it is not Jev. */
export function labelOf(name: RouteName): string {
  return name === "laya" ? "Laya" : "Jev";
}

/**
 * Which confidence a route's answer is read for. `jev`: the `confidence` it
 * sends is Jev's, or derived from the probabilities when it sends none.
 * `x_jev`: its own `confidence` means something else (Laya's is one minus the
 * normalised entropy), so `x_jev_confidence` is read, and the probabilities
 * when it is absent; `confidence` never.
 */
export function confidenceSourceOf(name: RouteName): "jev" | "x_jev" {
  return name === "laya" ? "x_jev" : "jev";
}

/**
 * Routes with a fixed address. The host is part of the code: the key for the
 * route can only go there. `model` is null where the id is not known and has
 * to be given in JEV_ROUTER_JEV_MODEL.
 */
const FIXED: Record<"openrouter" | "commandcode" | "opencode", { endpoint: string; model: string | null; keyEnv: keyof ProviderEnv }> = {
  // Jev 1.14 on OpenRouter: https://openrouter.ai/typesafe/jev-1.14
  openrouter: { endpoint: "https://openrouter.ai/api/v1/systemone", model: "typesafe/jev-1.14", keyEnv: "OPENROUTER_API_KEY" },
  // Provider API, GOAT plan and above: https://commandcode.ai/models/jev-1-14-0
  commandcode: { endpoint: "https://api.commandcode.ai/provider/v1/systemone", model: "typesafe/jev-1.14.0", keyEnv: "COMMANDCODE_API_KEY" },
  // OpenCode Console endpoint; its model id for Jev 1.14 is not confirmed.
  opencode: { endpoint: "https://opencode.ai/inference/systemone/v1/systemone", model: null, keyEnv: "OPENCODE_API_KEY" },
};

/**
 * Resolves a TypeSafe API base URL. Rejects non-https and unknown hosts
 * unless custom bases are explicitly allowed — otherwise a mistyped or
 * malicious settings value would send the Bearer key elsewhere.
 */
export function typesafeBaseOf(
  raw: string | undefined,
  allowCustom: string | undefined,
): { ok: true; base: string } | { ok: false; reason: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, base: TYPESAFE_BASE_DEFAULT };

  let url: URL;
  try {
    url = new URL(trimmed.replace(/\/$/, ""));
  } catch {
    return { ok: false, reason: "TYPESAFE_BASE_URL is not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "TYPESAFE_BASE_URL must use https" };
  }

  const host = url.hostname.toLowerCase();
  const allowed =
    host === "api.typesafe.ai" || host.endsWith(".typesafe.ai");
  const customOk = flagOn(allowCustom);
  if (!allowed && !customOk) {
    return {
      ok: false,
      reason:
        "TYPESAFE_BASE_URL host is not allowlisted; set " +
        "JEV_ROUTER_ALLOW_CUSTOM_BASE=1 to permit it",
    };
  }
  return { ok: true, base: baseWithoutEndpoint(url) };
}

/**
 * The endpoint's own path is added after the base; a base that already
 * carries it (copied from the docs' full URL) would otherwise double it.
 * Trailing slashes trimmed by hand: `\/+$` rescanned a long run of them
 * from every position.
 */
function baseWithoutEndpoint(url: URL): string {
  let end = url.pathname.length;
  while (end > 0 && url.pathname[end - 1] === "/") end--;
  const path = url.pathname.slice(0, end).replace(/\/v1(?:\/systemone)?$/, "");
  return `${url.origin}${path}`;
}

/**
 * Your own Laya server's base URL: https, no login in it, any host. The
 * address is the user's to name, and LAYA_API_KEY goes only there.
 */
export function layaBaseOf(
  raw: string | undefined,
): { ok: true; base: string } | { ok: false; reason: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "JEV_ROUTER_PROVIDER=laya but LAYA_BASE_URL is not set" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "LAYA_BASE_URL is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "LAYA_BASE_URL must use https" };
  if (url.username !== "" || url.password !== "")
    return { ok: false, reason: "LAYA_BASE_URL must not carry a login; use LAYA_API_KEY" };
  return { ok: true, base: baseWithoutEndpoint(url) };
}

function flagOn(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

function typesafeProvider(
  apiKey: string,
  env: ProviderEnv,
): ProviderResult {
  const base = typesafeBaseOf(
    env.TYPESAFE_BASE_URL,
    env.JEV_ROUTER_ALLOW_CUSTOM_BASE,
  );
  if (!base.ok) return base;
  const pinned = (env.JEV_ROUTER_JEV_MODEL ?? "").trim();
  return {
    ok: true,
    name: "typesafe",
    endpoint: `${base.base}/v1/systemone`,
    model: pinned || TYPESAFE_MODEL_DEFAULT,
    apiKey,
  };
}

function gatewayProvider(apiKey: string): ProviderResult {
  return {
    ok: true,
    name: "gateway",
    endpoint: `${GATEWAY_BASE}/v1/evaluate`,
    model: "typesafe-ai/jev",
    apiKey,
  };
}

const keyOf = (v: string | undefined) => (v ?? "").trim() || undefined;

/** The route `name` built from `env`, or why it cannot be. */
function build(name: RouteName, env: ProviderEnv): ProviderResult {
  const pinned = (env.JEV_ROUTER_JEV_MODEL ?? "").trim();
  switch (name) {
    case "typesafe": {
      const key = keyOf(env.TYPESAFE_API_KEY);
      return key ? typesafeProvider(key, env) : { ok: false, reason: "JEV_ROUTER_PROVIDER=typesafe but TYPESAFE_API_KEY is not set" };
    }
    case "gateway": {
      const key = keyOf(env.AI_GATEWAY_API_KEY);
      return key ? gatewayProvider(key) : { ok: false, reason: "JEV_ROUTER_PROVIDER=gateway but AI_GATEWAY_API_KEY is not set" };
    }
    case "laya": {
      const base = layaBaseOf(env.LAYA_BASE_URL);
      if (!base.ok) return base;
      return {
        ok: true,
        name: "laya",
        endpoint: `${base.base}/v1/systemone`,
        model: pinned || "laya",
        // A server on your own network may ask for no key.
        apiKey: keyOf(env.LAYA_API_KEY) ?? "",
      };
    }
    default: {
      const route = FIXED[name];
      const key = keyOf(env[route.keyEnv]);
      if (!key) return { ok: false, reason: `JEV_ROUTER_PROVIDER=${name} but ${String(route.keyEnv)} is not set` };
      const model = pinned || route.model;
      if (!model) return { ok: false, reason: `${name} needs JEV_ROUTER_JEV_MODEL: its model id for Jev is not known to the router` };
      return { ok: true, name, endpoint: route.endpoint, model, apiKey: key };
    }
  }
}

/** Names JEV_ROUTER_PROVIDER accepts, with the other spellings the gateway and TypeSafe go by. */
const NAMES: Record<string, RouteName> = {
  typesafe: "typesafe",
  direct: "typesafe",
  gateway: "gateway",
  vercel: "gateway",
  "ai-gateway": "gateway",
  ai_gateway: "gateway",
  openrouter: "openrouter",
  commandcode: "commandcode",
  "command-code": "commandcode",
  opencode: "opencode",
  laya: "laya",
};

/** The checks every built route goes through before it is used. */
function checked(p: ProviderResult, env: ProviderEnv): ProviderResult {
  if (!p.ok) return p;
  // Only what the chosen provider uses is checked: a stale key for the
  // other one, or a pinned model the gateway ignores, blocks nothing.
  // A key with a line break or other character inside it cannot go in a
  // header: the request would fail with an error quoting the header, key
  // and all, into the route line and the store. Refused up front instead.
  const keyName = {
    typesafe: "TYPESAFE_API_KEY",
    gateway: "AI_GATEWAY_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    commandcode: "COMMANDCODE_API_KEY",
    opencode: "OPENCODE_API_KEY",
    laya: "LAYA_API_KEY",
  }[p.name];
  const noKeyNeeded = p.name === "laya" && p.apiKey === "";
  if (!noKeyNeeded && !/^[\x21-\x7e]+$/.test(p.apiKey))
    return { ok: false, reason: `${keyName} has a line break, space or other character a key cannot have` };
  if (p.name !== "gateway" && !/^[\w.:/@+-]{1,100}$/.test(p.model))
    return { ok: false, reason: "JEV_ROUTER_JEV_MODEL is not a model id" };
  void env;
  return p;
}

/**
 * Every provider to try, in order: the ones JEV_ROUTER_PROVIDER names, or
 * the one the keys choose. Fails when a named one cannot be built.
 */
export function providersOf(raw: ProviderEnv): { ok: true; providers: ProviderOk[] } | { ok: false; reason: string } {
  const env = {
    ...raw,
    TYPESAFE_API_KEY: keyOf(raw.TYPESAFE_API_KEY),
    AI_GATEWAY_API_KEY: keyOf(raw.AI_GATEWAY_API_KEY),
  };
  const named = (env.JEV_ROUTER_PROVIDER ?? "")
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((n) => NAMES[n])
    .filter((n): n is RouteName => n !== undefined);
  // An unknown name falls back to choosing by the keys set, as before.
  const wanted: RouteName[] = [...new Set(named)];
  if (wanted.length === 0) {
    if (env.TYPESAFE_API_KEY) wanted.push("typesafe");
    else if ((env.LAYA_BASE_URL ?? "").trim()) wanted.push("laya");
    else if (env.AI_GATEWAY_API_KEY) wanted.push("gateway");
    else return { ok: false, reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY" };
  }
  const providers: ProviderOk[] = [];
  for (const name of wanted) {
    const p = checked(build(name, env), env);
    if (!p.ok) return p;
    providers.push(p);
  }
  return { ok: true, providers };
}

/** The first provider to try, for the callers that use one. */
export function providerOf(raw: ProviderEnv): ProviderResult {
  const all = providersOf(raw);
  return all.ok ? all.providers[0]! : all;
}
