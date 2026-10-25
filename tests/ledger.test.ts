import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LEDGER_MAX,
  LEDGER_PER_DAY,
  LEDGER_PROMPT,
  entryOf,
  label,
  labelReply,
  ledgerKey,
  ledgerOn,
  promptDigest,
  prune,
  put,
  readSince,
  statsOf,
  statsReport,
  windowOf,
  withUsage,
  type LedgerEntry,
} from "../hooks/ledger.ts";
import type { Decision } from "../hooks/policy.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 12);

function memory() {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async (k: string) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : undefined),
    set: async (k: string, v: unknown) => void m.set(k, JSON.parse(JSON.stringify(v))),
    delete: async (k: string) => void m.delete(k),
    keys: async () => [...m.keys()],
  };
}

const decision = (over: Partial<Decision> = {}): Decision => ({ tier: "opus", model: "claude-opus-5-5", effort: "high", confidence: 0.82, ...over });
const rec = (id: string, at: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({ id, at, prompt: id, ms: 300, jev: "opus", tier: "opus", decider: "Jev", ...over });

describe("ledger: records", () => {
  test("a routed turn keeps what Jev named, what ran and who answered", () => {
    const e = entryOf({ prompt: "x".repeat(500), ms: 412.6, decision: decision({ decider: "d3-turbo" }) }, "t1", NOW, "sess-1");
    assert.equal(e.prompt.length, 200);
    assert.deepEqual({ ...e, prompt: undefined }, {
      id: "t1", at: NOW, session: "sess-1", prompt: undefined, digest: promptDigest("x".repeat(500)), ms: 413,
      tier: "opus", model: "claude-opus-5-5", effort: "high", jev: "opus", confidence: 0.82, decider: "d3-turbo",
    });
  });

  test("a held turn keeps Jev's pick apart from the tier that ran", () => {
    const e = entryOf({ prompt: "p", ms: 1, decision: decision({ tier: "sonnet", model: "claude-sonnet-5-5", held: "opus" }) }, "t", NOW);
    assert.equal(e.jev, "opus");
    assert.equal(e.tier, "sonnet");
    assert.equal(e.held, true);
  });

  test("a named tier or a go-ahead asked nobody, and an unrouted turn says why", () => {
    assert.equal(entryOf({ prompt: "use opus", ms: 0, decision: decision({ forced: true }) }, "f", NOW).jev, undefined);
    assert.equal(entryOf({ prompt: "yes", ms: 0, kind: "continue", continued: true, decision: decision() }, "c", NOW).jev, undefined);
    assert.equal(entryOf({ prompt: "p", ms: 1500, skipped: "timed out after 1500ms" }, "s", NOW).skipped, "timed out after 1500ms");
  });

  test("usage folds in the turn's totals and the model that answered", () => {
    const e = withUsage(rec("t", NOW), { model: "claude-opus-5-5", input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, 0.0123456789);
    assert.deepEqual(e.tokens, { in: 10, out: 20, read: 30, write: 40 });
    assert.equal(e.cost, 0.012346);
    assert.equal(withUsage(e, undefined, undefined).cost, undefined);
  });

  test("the flag is on unless switched off", () => {
    assert.equal(ledgerOn(undefined), true);
    assert.equal(ledgerOn("0"), false);
    assert.equal(ledgerOn("off"), false);
    assert.equal(ledgerOn("1"), true);
  });
});

/** A store whose reads and writes take a turn of the event loop each, as the engine's do, so writes can interleave. */
function slow() {
  const s = memory();
  const tick = () => new Promise((r) => setImmediate(r));
  return { ...s, get: async (k: string) => (await tick(), s.get(k)), set: async (k: string, v: unknown) => (await tick(), s.set(k, v)) };
}

describe("ledger: the store", () => {
  const A = "sess-a";
  const B = "sess-b";
  const putIn = (s: ReturnType<typeof memory>, session: string | undefined, e: LedgerEntry) => put(s, { ...e, ...(session ? { session } : {}) }, ledgerKey(e.at, session));

  test("one key per UTC day and session, a record replaced by its id, a key capped", async () => {
    const s = memory();
    await putIn(s, A, rec("a", NOW));
    await putIn(s, A, rec("a", NOW, { cost: 1 }));
    await putIn(s, A, rec("b", NOW - DAY));
    await putIn(s, B, rec("c", NOW));
    await putIn(s, undefined, rec("d", NOW));
    assert.deepEqual([...s.m.keys()].sort(), ["ledger:2026-10-24:sess-a", "ledger:2026-10-25:-", "ledger:2026-10-25:sess-a", "ledger:2026-10-25:sess-b"]);
    assert.equal((s.m.get(ledgerKey(NOW, A)) as LedgerEntry[])[0]!.cost, 1);
    for (let i = 0; i < LEDGER_PER_DAY + 5; i++) await putIn(s, A, rec(`x${i}`, NOW));
    assert.equal((s.m.get(ledgerKey(NOW, A)) as LedgerEntry[]).length, LEDGER_PER_DAY);
  });

  test("writes at the same moment keep every record: one session's turns, and two sessions'", async () => {
    // Before: one key per day, read, changed and written back; two at once left one.
    const s = slow();
    await Promise.all([putIn(s, A, rec("main", NOW)), putIn(s, A, rec("agent:1", NOW, { kind: "agent" })), putIn(s, A, rec("agent:2", NOW, { kind: "agent" }))]);
    await Promise.all([putIn(s, A, rec("main", NOW, { cost: 1 })), putIn(s, B, rec("other", NOW)), putIn(s, A, rec("agent:1", NOW, { kind: "agent", cost: 2 }))]);
    const all = await readSince(s, NOW - DAY);
    assert.deepEqual(all.map((e) => e.id).sort(), ["agent:1", "agent:2", "main", "other"]);
    assert.equal(all.find((e) => e.id === "main")?.cost, 1);
    assert.equal(all.find((e) => e.id === "agent:1")?.cost, 2);
  });

  test("a turn's usage, written after a verdict, keeps the verdict", async () => {
    const s = memory();
    const first = rec("t", NOW);
    await putIn(s, A, first);
    await label(s, "sonnet", NOW, A);
    // The record the turn holds in memory has no label; its usage goes on it.
    await putIn(s, A, withUsage(first, { model: "claude-opus-5-5", input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, 0.5));
    const [e] = await readSince(s, NOW - DAY);
    assert.equal(e?.label, "sonnet");
    assert.equal(e?.cost, 0.5);
    // A verdict given after the usage stays too, and a later verdict replaces it.
    assert.equal((await label(s, "right", NOW, A))?.label, "opus");
    assert.equal((await readSince(s, NOW - DAY))[0]?.label, "opus");
  });

  test("read since a time, oldest first, across sessions", async () => {
    const s = memory();
    await putIn(s, A, rec("old", NOW - 10 * DAY));
    await putIn(s, B, rec("b", NOW - 1000));
    await putIn(s, A, rec("a", NOW - 2 * DAY));
    assert.deepEqual((await readSince(s, NOW - 7 * DAY)).map((e) => e.id), ["a", "b"]);
  });

  test("a verdict goes on this session's latest main turn Jev was asked about", async () => {
    const s = memory();
    await putIn(s, A, rec("asked", NOW - 3000, { prompt: "my request in chat A" }));
    await putIn(s, A, rec("unrouted", NOW - 2500, { jev: undefined, skipped: "timed out" }));
    // A subagent of A decided later, and chat B after that: neither is A's turn.
    await putIn(s, A, rec("agent:x", NOW - 2000, { kind: "agent", prompt: "subagent task" }));
    await putIn(s, B, rec("theirs", NOW - 1000, { prompt: "Unrelated request in chat B" }));
    const right = await label(s, "right", NOW, A);
    assert.equal(right?.id, "asked");
    assert.equal(right?.label, "opus");
    assert.equal((await label(s, "haiku", NOW, A))?.prompt, "my request in chat A");
    const b = (await readSince(s, NOW - DAY)).find((e) => e.id === "theirs");
    assert.equal(b?.label, undefined, "chat B's turn is never labelled from chat A");
    assert.equal((await readSince(s, NOW - DAY)).find((e) => e.id === "agent:x")?.label, undefined);
    assert.equal(await label(s, "right", NOW, "sess-c"), null);
  });

  test("prune drops days past the keep, then the oldest days past the cap, never today", async () => {
    const s = memory();
    await s.set(ledgerKey(NOW - 40 * DAY, A), [rec("ancient", NOW - 40 * DAY)]);
    await s.set(ledgerKey(NOW - 3 * DAY, A), Array.from({ length: LEDGER_MAX - 10 }, (_, i) => rec(`o${i}`, NOW - 3 * DAY)));
    await s.set(ledgerKey(NOW - 3 * DAY, B), Array.from({ length: 20 }, (_, i) => rec(`p${i}`, NOW - 3 * DAY)));
    await s.set(ledgerKey(NOW, A), [rec("today", NOW)]);
    await s.set("session:other", { keep: true });
    assert.equal(await prune(s, NOW), 3);
    assert.deepEqual([...s.m.keys()].sort(), ["ledger:2026-10-25:sess-a", "session:other"]);
    // Under the cap, nothing within the days goes.
    await s.set(ledgerKey(NOW - DAY, B), [rec("y", NOW - DAY)]);
    assert.equal(await prune(s, NOW), 0);
  });

  test("the whole prompt's digest is kept, and tells apart prompts that start alike", () => {
    const head = "Project rules: ".padEnd(LEDGER_PROMPT, "x");
    const one = entryOf({ prompt: `${head} fix the login bug`, ms: 1 }, "1", NOW);
    const two = entryOf({ prompt: `${head} write the release notes`, ms: 1 }, "2", NOW);
    assert.equal(one.prompt, two.prompt);
    assert.notEqual(one.digest, two.digest);
    assert.equal(one.digest, promptDigest(`${head}   fix the login bug\n`), "whitespace is folded");
    assert.match(one.digest!, /^[0-9a-f]{14}$/);
  });
});

describe("ledger: stats", () => {
  const usage = { tokens: { in: 1000, out: 2000, read: 50_000, write: 5000 } };
  const entries = [
    rec("1", NOW, { tier: "haiku", jev: "haiku", ms: 200, cost: 0.002, ...usage, label: "haiku" }),
    rec("2", NOW, { tier: "opus", jev: "opus", ms: 400, cost: 0.08, ...usage, label: "sonnet" }),
    rec("3", NOW, { tier: "sonnet", jev: "opus", held: true, ms: 600, decider: "d3-turbo", cost: 0.04, ...usage, label: "fable" }),
    rec("4", NOW, { jev: undefined, tier: undefined, skipped: "vllm: timed out after 1500ms; openrouter said HTTP 500" }),
  ];

  test("counts, deciders, the median, spend, and verdicts", () => {
    const s = statsOf(entries);
    assert.equal(s.turns, 4);
    assert.equal(s.asked, 3);
    assert.equal(s.unrouted, 1);
    assert.deepEqual(s.ran, { haiku: 1, opus: 1, sonnet: 1 });
    assert.deepEqual(s.deciders, [["Jev", 2], ["d3-turbo", 1]]);
    assert.equal(s.held, 1);
    assert.equal(s.medianMs, 400);
    assert.ok(Math.abs(s.spent - 0.122) < 1e-9);
    assert.equal(s.priced, 3);
    assert.ok(s.always.opus! > s.always.sonnet! && s.always.sonnet! > s.always.haiku!);
    assert.deepEqual([s.labelled, s.agree, s.tooLow, s.tooHigh], [3, 1, 1, 1]);
    assert.deepEqual(s.reasons, [["vllm: timed out; openrouter said HTTP 500", 1]]);
  });

  test("the report says it in a few lines", () => {
    const text = statsReport(statsOf(entries), "7 days");
    assert.match(text, /turns\s+4 — haiku 1 \(25%\) · sonnet 1 \(25%\) · opus 1 \(25%\)/);
    assert.match(text, /decided\s+3 by Jev 2, d3-turbo 1, median 400ms · 1 held on the running tier/);
    assert.match(text, /unrouted\s+1 \(25%\): vllm: timed out; openrouter said HTTP 500 ×1/);
    assert.match(text, /spent\s+\$0\.122 at list price; the same tokens on always sonnet \$\d/);
    assert.match(text, /verdicts\s+3 labelled: 33% right, 1 too low, 1 too high \(Jev 50% of 2, d3-turbo 0% of 1\)/);
    assert.match(statsReport(statsOf([]), "24 hours"), /No routed turns in this window yet/);
    assert.match(statsReport(statsOf(entries.slice(3)), "7 days"), /verdicts\s+none yet/);
    assert.match(statsReport(statsOf(entries), "7 days", { count: 2, reason: "store over 4 MiB" }), /missing\s+2 ledger writes failed in this session \(store over 4 MiB\): those turns are not counted/);
    assert.match(statsReport(statsOf([]), "7 days", { count: 1, reason: "x" }), /missing\s+1 ledger write failed/);
    assert.doesNotMatch(statsReport(statsOf(entries), "7 days", { count: 0, reason: "" }), /missing/);
  });

  test("each decision model's part when several were asked", () => {
    const race = [
      rec("r1", NOW, { tries: [{ name: "vllm", outcome: "won", start: 0, ms: 400 }, { name: "openrouter", outcome: "not asked" }] }),
      rec("r2", NOW, { tries: [{ name: "vllm", outcome: "timed out", start: 0, ms: 1500 }, { name: "openrouter", outcome: "won", start: 400, ms: 600 }] }),
      rec("r3", NOW, { tries: [{ name: "vllm", outcome: "pending", start: 0 }, { name: "openrouter", outcome: "won", start: 400, ms: 500 }] }),
      rec("r4", NOW, { tries: [{ name: "vllm", outcome: "won", start: 0, ms: 600 }, { name: "openrouter", outcome: "answered", start: 0, ms: 300 }] }),
    ];
    const s = statsOf(race);
    assert.deepEqual(s.race, [
      ["vllm", { turns: 4, asked: 4, won: 2, lost: 1, failed: 0, timedOut: 1, medianMs: 500 }],
      ["openrouter", { turns: 4, asked: 3, won: 2, lost: 1, failed: 0, timedOut: 0, medianMs: 500 }],
    ]);
    const text = statsReport(s, "7 days");
    assert.match(text, /race\s+vllm: asked 4 of 4, won 2, lost 1, timed out 1, median 500ms\n\s+openrouter: asked 3 of 4, won 2, lost 1, median 500ms/);
    assert.doesNotMatch(statsReport(statsOf(entries), "7 days"), /race/);
    assert.deepEqual(entryOf({ prompt: "p", ms: 1, decision: decision() }, "t", NOW, "s", [{ name: "vllm", outcome: "won", start: 0, ms: 3 }]).tries, [{ name: "vllm", outcome: "won", start: 0, ms: 3 }]);
    assert.equal(entryOf({ prompt: "p", ms: 1, decision: decision() }, "t", NOW).tries, undefined);
  });

  test("windows", () => {
    assert.deepEqual(windowOf("24h"), { ms: 24 * 3_600_000, name: "24 hours" });
    assert.deepEqual(windowOf("7d"), { ms: 7 * DAY, name: "7 days" });
    assert.equal(windowOf("90d"), null);
    assert.equal(windowOf("week"), null);
  });

  test("the label reply names the turn it labelled", () => {
    assert.match(
      labelReply(rec("refactor the parser", NOW - 5000, { label: "opus" }), "right", NOW),
      /Labelled "refactor the parser" \(this chat's last decided turn, just now\) opus: Jev said opus, and you agree/,
    );
    assert.match(labelReply(rec("p", NOW - 12 * 60_000, { label: "sonnet" }), "sonnet", NOW), /Labelled "p" \(this chat's last decided turn, 12 min ago\) sonnet: Jev said opus\./);
    assert.match(labelReply(rec("p", NOW - 3 * 3_600_000, { label: "sonnet" }), "sonnet", NOW), /3 h ago/);
    assert.match(labelReply(null, "right", NOW), /No routed turn of this session/);
  });
});
