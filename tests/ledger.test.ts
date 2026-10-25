import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LEDGER_MAX,
  LEDGER_PER_DAY,
  dayKey,
  entryOf,
  label,
  labelReply,
  ledgerOn,
  prune,
  put,
  readSince,
  statsOf,
  statsReport,
  update,
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
      id: "t1", at: NOW, session: "sess-1", prompt: undefined, ms: 413,
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

describe("ledger: the store", () => {
  test("one key per UTC day, a record replaced by its id, a day capped", async () => {
    const s = memory();
    await put(s, rec("a", NOW));
    await put(s, rec("a", NOW, { cost: 1 }));
    await put(s, rec("b", NOW - DAY));
    assert.deepEqual([...s.m.keys()].sort(), ["ledger:2026-10-24", "ledger:2026-10-25"]);
    assert.equal((s.m.get(dayKey(NOW)) as LedgerEntry[])[0]!.cost, 1);
    for (let i = 0; i < LEDGER_PER_DAY + 5; i++) await put(s, rec(`x${i}`, NOW));
    assert.equal((s.m.get(dayKey(NOW)) as LedgerEntry[]).length, LEDGER_PER_DAY);
  });

  test("an update finds a turn that crossed midnight", async () => {
    const s = memory();
    await put(s, rec("late", NOW - DAY));
    assert.equal(await update(s, "late", NOW, (e) => ({ ...e, cost: 2 })), true);
    assert.equal((await readSince(s, NOW - 2 * DAY, NOW))[0]!.cost, 2);
    assert.equal(await update(s, "nowhere", NOW, (e) => e), false);
  });

  test("read since a time, oldest first", async () => {
    const s = memory();
    await put(s, rec("old", NOW - 10 * DAY));
    await put(s, rec("b", NOW - 1000));
    await put(s, rec("a", NOW - 2 * DAY));
    assert.deepEqual((await readSince(s, NOW - 7 * DAY, NOW)).map((e) => e.id), ["a", "b"]);
  });

  test("labels go on the latest turn Jev was asked about", async () => {
    const s = memory();
    await put(s, rec("asked", NOW - 2000));
    await put(s, rec("unrouted", NOW - 1000, { jev: undefined, skipped: "timed out" }));
    const right = await label(s, "right", NOW);
    assert.equal(right?.id, "asked");
    assert.equal(right?.label, "opus");
    assert.equal((await label(s, "sonnet", NOW))?.label, "sonnet");
    assert.equal(await label(memory(), "right", NOW), null);
  });

  test("prune drops days past the keep, then the oldest past the cap, never today", async () => {
    const s = memory();
    await s.set(dayKey(NOW - 40 * DAY), [rec("ancient", NOW - 40 * DAY)]);
    await s.set(dayKey(NOW - 3 * DAY), Array.from({ length: LEDGER_MAX }, (_, i) => rec(`o${i}`, NOW - 3 * DAY)));
    await s.set(dayKey(NOW), [rec("today", NOW)]);
    await s.set("session:other", { keep: true });
    assert.equal(await prune(s, NOW), 2);
    assert.deepEqual([...s.m.keys()].sort(), ["ledger:2026-10-25", "session:other"]);
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
  });

  test("windows", () => {
    assert.deepEqual(windowOf("24h"), { ms: 24 * 3_600_000, name: "24 hours" });
    assert.deepEqual(windowOf("7d"), { ms: 7 * DAY, name: "7 days" });
    assert.equal(windowOf("90d"), null);
    assert.equal(windowOf("week"), null);
  });

  test("the label reply", () => {
    assert.match(labelReply(rec("refactor the parser", NOW, { label: "opus" }), "right"), /Labelled "refactor the parser" opus: Jev said opus, and you agree/);
    assert.match(labelReply(rec("p", NOW, { label: "sonnet" }), "sonnet"), /Labelled "p" sonnet: Jev said opus\./);
    assert.match(labelReply(null, "right"), /No routed turn/);
  });
});
