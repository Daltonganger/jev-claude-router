/**
 * Tests for the benchmark tools in scripts/bench: the numbers they report,
 * the prompts they pull from transcripts, and a run against a local stand-in
 * for OpenRouter's Decisions API.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

// @ts-expect-error plain JavaScript modules
import { agreement, barTable, baselines, betterThanRest, normalSf, combine, compare, confusion, costIndex, OUTPUT_PRICE, suggestBar, labelCounts, percentile, report, summarize, table } from "../scripts/bench/metrics.mjs";
// @ts-expect-error plain JavaScript modules
import { seeded, typedPrompt } from "../scripts/bench/extract.mjs";
// @ts-expect-error plain JavaScript modules
import { merge } from "../scripts/bench/report.mjs";
import { ledgerEntries, wholePrompt } from "../scripts/bench/ledger.mjs";
// @ts-expect-error plain JavaScript modules
import { barsReport, checkBar, pool } from "../scripts/bench/bars.mjs";
// @ts-expect-error plain JavaScript modules
import { ask, catalog, layaCatalog, OPTIONS, routerAsks, run, specOf, unknownOption, wordingOf } from "../scripts/bench/run.mjs";

const row = (label: string, pick: string | null, confidence = 0.9, ms = 100, cost = 0.00001) => ({ label, pick, confidence, ms, cost });

describe("metrics", () => {
  test("percentile is nearest rank, and null for nothing", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
    assert.equal(percentile([10, 20, 30, 40], 0.95), 40);
    assert.equal(percentile([5, Number.NaN, 7], 0.5), 5);
  });

  test("exact, within one, too low and too high are counted on the answered cases", () => {
    const s = summarize([
      row("opus", "opus"),
      row("opus", "sonnet"), // too low, within one
      row("haiku", "fable"), // too high, far
      row("sonnet", "sonnet"),
      row("fable", null), // an error: not answered
    ]);
    assert.equal(s.cases, 5);
    assert.equal(s.answered, 4);
    assert.equal(s.accuracy, 0.5);
    assert.equal(s.withinOne, 0.75);
    assert.equal(s.under, 0.25);
    assert.equal(s.over, 0.25);
  });

  test("a case without a usable label is not scored", () => {
    const s = summarize([row("skip", "opus"), row("opus", "opus")]);
    assert.equal(s.answered, 1);
  });

  test("calibration: a model that says 90% and is right half the time is off by 0.4", () => {
    const rows = [row("opus", "opus", 0.9), row("opus", "haiku", 0.9), row("opus", "opus", 0.9), row("opus", "haiku", 0.9)];
    const s = summarize(rows);
    assert.ok(Math.abs((s.ece ?? 0) - 0.4) < 1e-9);
    const bin = s.bins.find((b: { n: number }) => b.n > 0);
    assert.equal(bin.accuracy, 0.5);
    assert.ok(Math.abs(bin.said - 0.9) < 1e-9);
  });

  test("a model that is exactly as sure as it is right has no calibration error", () => {
    const rows = [...Array(9)].map(() => row("opus", "opus", 0.9)).concat([row("opus", "haiku", 0.9)]);
    assert.ok(Math.abs(summarize(rows).ece ?? 1) < 1e-9);
  });

  test("the bar: how many answers clear it, and how often those are right", () => {
    const s = summarize([row("opus", "opus", 0.95), row("opus", "haiku", 0.8), row("opus", "opus", 0.5), row("opus", "opus", 0.2)]);
    assert.equal(s.bars[0.75].share, 0.5);
    assert.equal(s.bars[0.75].accuracy, 0.5);
    assert.equal(s.bars[0.9].share, 0.25);
    assert.equal(s.bars[0.9].accuracy, 1);
    assert.equal(s.bars[0.6].share, 0.5);
  });

  test("latency and cost per thousand decisions", () => {
    const s = summarize([row("opus", "opus", 0.9, 100, 0.00002), row("opus", "opus", 0.9, 300, 0.00004)]);
    assert.equal(s.meanMs, 200);
    assert.equal(s.p50Ms, 100);
    assert.equal(s.p95Ms, 300);
    assert.ok(Math.abs((s.costPer1k ?? 0) - 0.03) < 1e-9);
  });

  test("no answers at all gives nulls, not NaN", () => {
    const s = summarize([row("opus", null, 0, Number.NaN, Number.NaN)]);
    assert.equal(s.accuracy, null);
    assert.equal(s.ece, null);
    assert.equal(s.costPer1k, null);
    assert.equal(s.bars[0.75].share, null);
  });

  test("agreement is on the cases both answered", () => {
    const a = [row("x", "opus"), row("x", "haiku"), row("x", null)];
    const b = [row("x", "opus"), row("x", "sonnet"), row("x", "fable")];
    assert.deepEqual(agreement({ a, b }), { "a|b": 0.5 });
  });

  test("the table has a row per model", () => {
    const t = table({ m1: summarize([row("opus", "opus")]), m2: summarize([row("opus", "haiku")]) });
    assert.equal(t.split("\n").length, 4);
    assert.match(t, /\| m1 \| 1\/1 \| 100% /);
  });
});

describe("the label set, baselines and a fair comparison", () => {
  const rows = [row("sonnet", "opus"), row("sonnet", "sonnet"), row("sonnet", "opus"), row("haiku", "haiku"), row("fable", "opus")];

  test("label counts and what always saying one tier would score", () => {
    assert.deepEqual(labelCounts(rows), { haiku: 1, sonnet: 3, opus: 0, fable: 1 });
    assert.deepEqual(baselines(rows), { haiku: 0.2, sonnet: 0.6, opus: 0, fable: 0.2 });
    assert.equal(baselines([])["sonnet"], null);
  });

  test("the confusion matrix has your label in the rows and the pick in the columns", () => {
    const m = confusion(rows);
    assert.equal(m.sonnet.opus, 2);
    assert.equal(m.sonnet.sonnet, 1);
    assert.equal(m.fable.opus, 1);
    assert.equal(m.haiku.haiku, 1);
    assert.equal(confusion([row("skip", "opus"), row("opus", null)]).opus.opus, 0);
  });

  test("the sign test: equal gaps are luck, a lopsided one on many cases is not", () => {
    const right = (n: number) => [...Array(n)].map(() => row("opus", "opus"));
    const wrong = (n: number) => [...Array(n)].map(() => row("opus", "haiku"));
    const even = compare([...right(5), ...wrong(5)], [...wrong(5), ...right(5)]);
    assert.equal(even.onlyA, 5);
    assert.equal(even.onlyB, 5);
    assert.ok(even.p > 0.9);
    const lopsided = compare(right(20), wrong(20));
    assert.equal(lopsided.onlyA, 20);
    assert.ok(lopsided.p < 0.001);
    assert.equal(compare(right(3), right(3)).p, 1, "no case where they differ");
  });

  test("the report states the labels, the baselines and each matrix", () => {
    const text = report({ a: rows, b: rows.map((r) => ({ ...r, pick: r.label })) }, {});
    assert.match(text, /Your labels: haiku 1, sonnet 3, opus 0, fable 1/);
    assert.match(text, /always saying one tier scores: haiku 20%, sonnet 60%/);
    assert.match(text, /a: your label \(rows\) against its pick \(columns\)/);
    assert.match(text, /Against a, on the cases where exactly one/);
    assert.match(text, /b: a alone right 0, b alone right 3, p = 0\.25/);
  });

  test("two models together: the lower or the higher pick, case by case", () => {
    const a = [row("sonnet", "haiku"), row("sonnet", "fable"), row("sonnet", "sonnet")];
    const b = [row("sonnet", "opus"), row("sonnet", "sonnet"), row("sonnet", null)];
    assert.deepEqual(combine(a, b, "lower").map((r: { pick: string | null }) => r.pick), ["haiku", "sonnet", null]);
    assert.deepEqual(combine(a, b, "higher").map((r: { pick: string | null }) => r.pick), ["opus", "fable", null]);
    const text = report({ a, b }, {});
    assert.match(text, /lower\s+of a and b: exact 50%/);
    assert.match(text, /treat this as a lead to test on fresh prompts/);
  });

  test("a prompt the router never sends to the model is left out", () => {
    for (const p of ["ok", "Yes!", "go ahead.", "use opus for this", "switch to haiku"]) assert.equal(routerAsks(p), false, p);
    for (const p of ["rename foo to bar", "Ja, maak dat", "ok but first explain the change"]) assert.equal(routerAsks(p), true, p);
  });
});

describe("report on several results files", () => {
  const rowsFor = (ids: number[]) => ids.map((id) => ({ id, label: "opus", pick: "opus", confidence: 0.9, ms: 1 }));

  test("puts the models of each file side by side", () => {
    const merged = merge([
      { name: "a.json", data: { rows: { m1: rowsFor([1, 2, 3]), m2: rowsFor([1, 2, 3]) } } },
      { name: "b.json", data: { rows: { "laya:x": rowsFor([1, 2, 3]) } } },
    ]);
    assert.deepEqual(Object.keys(merged), ["m1", "m2", "laya:x"]);
  });

  test("a model with the same name in two files keeps both", () => {
    const merged = merge([
      { name: "a.json", data: { rows: { m: rowsFor([1, 2]) } } },
      { name: "b.json", data: { rows: { m: rowsFor([1, 2]) } } },
    ]);
    assert.deepEqual(Object.keys(merged), ["m", "m'"]);
  });

  test("files run on other prompts are refused, naming the file", () => {
    assert.throws(
      () => merge([{ name: "a.json", data: { rows: { m: rowsFor([1, 2, 3]) } } }, { name: "b.json", data: { rows: { n: rowsFor([1, 2, 4]) } } }]),
      /b\.json: n was run on different prompts/,
    );
  });
});

describe("other wording for the tier question", () => {
  test("a file of wording is read, and a mistake in it is an error, not a silent run on the old wording", () => {
    const w = wordingOf({ criteria: { sonnet: "  a contained change  " }, instructions: "Which tier?" }, "v1");
    assert.deepEqual(w, { name: "v1", criteria: { sonnet: "a contained change" }, instructions: "Which tier?" });
    for (const bad of [null, [], "x", {}, { criteria: { sonet: "typo" } }, { criteria: { haiku: "" } }, { criteria: { haiku: 5 } }, { criteria: [] }, { instructions: "x".repeat(900) }, { crteria: {} }])
      assert.throws(() => wordingOf(bad), undefined, JSON.stringify(bad)?.slice(0, 40));
  });

  test("the request carries the wording, and the router's own where none is given", async () => {
    const s = await standIn();
    try {
      const wording = wordingOf({ criteria: { sonnet: "A contained change." }, instructions: "Pick the tier." }, "w");
      await ask({ base: s.base, api: "decisions", key: "k", model: "m", prompt: "rename foo", wording });
      await ask({ base: s.base, api: "decisions", key: "k", model: "m", prompt: "rename foo" });
      assert.equal(s.seen[0]?.criteria.sonnet, "A contained change.");
      assert.equal(s.seen[0]?.instructions, "Pick the tier.");
      assert.match(s.seen[0]?.criteria.haiku ?? "", /^Trivial\./, "a tier not reworded keeps the router's description");
      assert.match(s.seen[1]?.criteria.sonnet ?? "", /^Straightforward and minor/);
      assert.match(s.seen[1]?.instructions ?? "", /^A developer typed this request/);
    } finally {
      s.close();
    }
  });

  test("each wording is run on every model, after the router's own, and listed by name", async () => {
    const s = await standIn();
    try {
      const w1 = wordingOf({ criteria: { sonnet: "A." } }, "wider");
      const r = await run({ cases: cases.slice(0, 2), models: ["typesafe/jev-1.14", "unsure/model"], base: s.base, api: "decisions", key: "k", wordings: [w1] });
      assert.deepEqual(Object.keys(r.rows), ["typesafe/jev-1.14", "typesafe/jev-1.14 [wider]", "unsure/model", "unsure/model [wider]"]);
      assert.equal(s.seen.filter((x) => x.criteria.sonnet === "A.").length, 4);
    } finally {
      s.close();
    }
  });

  test("the command line takes the files, names them, and refuses a bad one", async () => {
    const s = await standIn();
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const casesFile = join(dir, "cases.jsonl");
      writeFileSync(casesFile, cases.slice(0, 2).map((c) => JSON.stringify(c)).join("\n") + "\n");
      writeFileSync(join(dir, "wider.json"), JSON.stringify({ criteria: { sonnet: "A contained change." } }));
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ criteria: { sonet: "typo" } }));
      const script = new URL("../scripts/bench/run.mjs", import.meta.url).pathname;
      const { execFile } = await import("node:child_process");
      const go = (criteria: string) =>
        new Promise<{ code: number; out: string; err: string }>((resolve) =>
          execFile(process.execPath, ["--experimental-strip-types", script, "--cases", casesFile, "--models", "typesafe/jev-1.14", "--base", s.base, "--out", join(dir, "o.json"), "--criteria", criteria], { env: { ...process.env, OPENROUTER_API_KEY: "k" } }, (err, out, errText) =>
            resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out, err: errText }),
          ),
        );
      const ok = await go(join(dir, "wider.json"));
      assert.equal(ok.code, 0);
      assert.match(ok.out, /Wording: the router's own, then wider\. Choose on one set of prompts and confirm on another\./);
      assert.match(ok.out, /\| typesafe\/jev-1\.14 \[wider\] \|/);
      const bad = await go(join(dir, "bad.json"));
      assert.equal(bad.code, 2);
      assert.match(bad.err, /--criteria: bad: "sonet" is not a tier/);
    } finally {
      s.close();
    }
  });
});

describe("options", () => {
  test("a name the script does not take is an error, not something skipped", () => {
    assert.equal(unknownOption(["--cases", "a.jsonl", "--criteria", "x.json"], OPTIONS), null);
    assert.equal(unknownOption(["--cases", "a.jsonl", "--criterai", "x.json"], OPTIONS), "--criterai");
  });

  test("the command line refuses one, for run and for extract", async () => {
    const { execFile } = await import("node:child_process");
    const go = (script: string, ...args: string[]) =>
      new Promise<{ code: number; err: string }>((resolve) =>
        execFile(process.execPath, ["--experimental-strip-types", new URL(`../scripts/bench/${script}`, import.meta.url).pathname, ...args], (err, _out, errText) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, err: errText }),
        ),
      );
    for (const script of ["run.mjs", "extract.mjs"]) {
      const r = await go(script, "--bogus", "x");
      assert.equal(r.code, 2, script);
      assert.match(r.err, /unknown option --bogus/);
    }
  });
});

describe("a second set that shares nothing with the first", () => {
  test("--exclude takes several files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    const line = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
    const prompts = ["rename the helper in utils", "add a null check to the parser", "explain this stack trace to me", "write a test for the exporter", "bump the version in package.json"];
    writeFileSync(join(dir, "t.jsonl"), prompts.map(line).join("\n") + "\n");
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, JSON.stringify({ id: 1, prompt: prompts[0], tier: "haiku" }) + "\n");
    writeFileSync(b, JSON.stringify({ id: 1, prompt: prompts[3], tier: "haiku" }) + "\n");
    const script = new URL("../scripts/bench/extract.mjs", import.meta.url).pathname;
    const { execFileSync } = await import("node:child_process");
    const out = join(dir, "c.jsonl");
    execFileSync(process.execPath, ["--experimental-strip-types", script, "--dir", dir, "--n", "10", "--out", out, "--exclude", `${a},${b}`]);
    const got = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).prompt).sort();
    assert.deepEqual(got, [prompts[1], prompts[2], prompts[4]].sort());
  });

  test("--exclude leaves out the prompts already in another file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    const line = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
    const prompts = ["rename the helper in utils", "add a null check to the parser", "explain this stack trace to me", "write a test for the exporter"];
    writeFileSync(join(dir, "t.jsonl"), prompts.map(line).join("\n") + "\n");
    const first = join(dir, "a.jsonl");
    writeFileSync(first, [prompts[0], prompts[2]].map((p, i) => JSON.stringify({ id: i, prompt: p, tier: "sonnet" })).join("\n") + "\n");
    const script = new URL("../scripts/bench/extract.mjs", import.meta.url).pathname;
    const { execFileSync } = await import("node:child_process");
    const out = join(dir, "b.jsonl");
    execFileSync(process.execPath, ["--experimental-strip-types", script, "--dir", dir, "--n", "10", "--out", out, "--exclude", first]);
    const got = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).prompt).sort();
    assert.deepEqual(got, [prompts[1], prompts[3]].sort());
  });
});

describe("what following a model costs against your labels", () => {
  test("the index is the output prices of the picks over those of the labels", () => {
    // labels: haiku 0.5 + sonnet 10 + opus 20 = 30.5; picks: sonnet 10 + sonnet 10 + opus 20 = 40
    const rows = [row("haiku", "sonnet"), row("sonnet", "sonnet"), row("opus", "opus")];
    assert.ok(Math.abs(costIndex(rows) - 40 / 30.5) < 1e-9);
    assert.equal(costIndex(rows, () => "opus"), 60 / 30.5);
    assert.equal(costIndex([row("skip", "opus"), row("opus", null)]), null);
  });

  test("a pick that is too low makes it cheaper, which is the point and the risk", () => {
    assert.ok(costIndex([row("opus", "haiku")]) < 0.05);
  });

  test("the summary and the table carry it", () => {
    const s = summarize([row("sonnet", "opus"), row("sonnet", "sonnet")]);
    assert.equal(s.costVsLabels, 1.5);
    assert.match(table({ m: s }), /\| 1\.50 \|$/m);
    const text = report({ m: [row("sonnet", "sonnet"), row("opus", "sonnet")] }, {});
    assert.match(text, /always haiku 0\.03, always sonnet 0\.67, always opus 1\.33/);
  });

  test("the prices are the router's own", async () => {
    const { PRICE } = await import("../hooks/pricing.ts");
    for (const tier of ["haiku", "sonnet", "opus", "fable"] as const) assert.equal(OUTPUT_PRICE[tier], PRICE[tier].output, tier);
  });
});

describe("where a bar would help", () => {
  const r = (right: boolean, confidence: number) => ({ label: "opus", pick: right ? "opus" : "haiku", confidence, ms: 1 });
  // 40 answers: the 20 at 0.55 are right half the time, the 20 at 0.9 nine times in ten.
  const informative = [
    ...[...Array(20)].map((_, i) => r(i < 10, 0.55)),
    ...[...Array(20)].map((_, i) => r(i < 18, 0.9)),
  ];
  // A model equally sure whether right or wrong.
  const flat = [...Array(40)].map((_, i) => r(i % 2 === 0, 0.8));

  test("for each bar, how many answers reach it and how often those are right", () => {
    const t = barTable(informative);
    const at = (bar: number) => t.find((b: { bar: number }) => b.bar === bar);
    assert.deepEqual({ ...at(0.5), p: null }, { bar: 0.5, n: 40, share: 1, accuracy: 28 / 40, p: null });
    assert.equal(at(0.5).p, null, "everything reaches it: nothing below to compare with");
    assert.equal(at(0.9).n, 20);
    assert.equal(at(0.9).share, 0.5);
    assert.equal(at(0.9).accuracy, 0.9);
    assert.ok(at(0.9).p < 0.01);
    assert.equal(at(0.2).n, 40, "the table starts low, for a model that is never very sure");
    assert.equal(at(0.95).n, 0);
    assert.equal(at(0.95).accuracy, null);
  });

  test("the normal tail, and the test that the confident are right more often", () => {
    assert.ok(Math.abs(normalSf(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(normalSf(1.645) - 0.05) < 1e-3);
    assert.ok(Math.abs(normalSf(-1.645) - 0.95) < 1e-3);
    assert.equal(betterThanRest(9, 10, 5, 10), null, "under 15 on a side: too few to say");
    // 18/20 against 10/20: a clear gap.
    assert.ok((betterThanRest(18, 20, 10, 20) as number) < 0.01);
    // 10/15 (67%) against 66/138 (48%), the size of Jev's best bar: could be luck.
    assert.ok((betterThanRest(10, 15, 66, 138) as number) > 0.05);
  });

  test("the lowest bar that lifts the confident answers clearly above the rest", () => {
    const pick = suggestBar(informative);
    assert.equal(pick.bar, 0.6, "from 0.6 only the 0.9 answers remain: 90% against 50% below");
    assert.ok(pick.p < 0.05 / 12, "the limit shares 5% over the bars that can be tested");
    assert.equal(pick.accuracy, 0.9);
    assert.equal(pick.overall, 0.7);
    assert.ok(pick.p < 0.01);
  });

  test("a model whose confidence says nothing gets no bar, and the report says so", () => {
    assert.equal(suggestBar(flat), null);
    assert.match(barsReport({ flat }), /No bar helps: no bar separates/);
    assert.match(barsReport({ informative }), /Suggested bar 60%: 50% of answers reach it, 90% of those are right, against 70% overall \(p = /);
  });

  test("a bar over too few answers, or a gap that luck explains, is not suggested", () => {
    const few = [...Array(10)].map(() => r(true, 0.95)).concat([...Array(30)].map((_, i) => r(i < 12, 0.5)));
    assert.equal(suggestBar(few), null, "10 answers reach 0.95");
    // 15 confident answers, 10 right (67%), against 66 of 138 (48%): the best bar Jev had, and luck.
    const jevLike = [
      ...[...Array(15)].map((_, i) => r(i < 10, 0.9)),
      ...[...Array(138)].map((_, i) => r(i < 66, 0.6)),
    ];
    assert.equal(suggestBar(jevLike), null);
  });

  test("one bar chosen beforehand is tested at the ordinary 5%", () => {
    const text = checkBar({ m: informative }, 0.6);
    assert.match(text, /^m: bar 60%: 20 of 40 answers reach it, 90% of those are right, 50% of the rest \(p = <?0\.\d+\): HOLDS at 5% and 10 points/);
    // Equally right above and below the bar: not better.
    const noise = [...Array(40)].map((_, i) => r(i % 4 < 2, i % 2 === 0 ? 0.9 : 0.6));
    assert.match(checkBar({ m: noise }, 0.8), /does not hold at 5% and 10 points/);
    assert.match(checkBar({ m: informative }, 0.99), /too few on one side to say\): nothing to test/);
  });

  test("results files are pooled per model name", () => {
    const merged = pool([{ rows: { a: [r(true, 0.9)], b: [r(true, 0.9)] } }, { rows: { a: [r(false, 0.9)] } }]);
    assert.equal(merged.a.length, 2);
    assert.equal(merged.b.length, 1);
  });
});

describe("extract", () => {
  const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, ...extra });

  test("takes what a person typed", () => {
    assert.equal(typedPrompt(user("rename foo to bar in utils.ts")), "rename foo to bar in utils.ts");
    assert.equal(typedPrompt(user([{ type: "text", text: "  two blocks " }, { type: "text", text: "of text" }])), "two blocks \nof text");
  });

  test("leaves out tool results, subagent and meta turns, commands and engine text", () => {
    for (const line of [
      user([{ type: "tool_result", content: "x" }]),
      user("something a subagent was told", { isSidechain: true }),
      user("a meta turn that is long enough", { isMeta: true }),
      user("<system-reminder>something</system-reminder>"),
      user("[Request interrupted by user]"),
      user("/jev tiers off fable"),
      user("short"),
      JSON.stringify({ type: "assistant", message: { content: "a reply that is long enough" } }),
      "not json",
    ])
      assert.equal(typedPrompt(line), null, line.slice(0, 40));
  });

  test("a long prompt is cut", () => {
    const t = typedPrompt(user("x".repeat(2000)));
    assert.equal(t?.length, 601);
  });

  test("a seed gives the same shuffle, and a different seed another", () => {
    const items = [...Array(20).keys()];
    assert.deepEqual(seeded(items, 3), seeded(items, 3));
    assert.notDeepEqual(seeded(items, 3), seeded(items, 4));
    assert.deepEqual([...seeded(items, 3)].sort((a, b) => a - b), items);
  });
});

/** A stand-in for OpenRouter's Decisions API: the tier follows a keyword in the state. */
function standIn() {
  const seen: { path: string; auth: string | undefined; model: string; questions: string[]; options: string[]; criteria: Record<string, string>; instructions: string }[] = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url?.startsWith("/api/v1/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "typesafe/jev-1.14", name: "Jev 1.14", context_length: 8000, pricing: { prompt: "0.000000042" } }] }));
        return;
      }
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "multilingual" }, { id: "english" }] }));
        return;
      }
      const body = JSON.parse(b);
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, model: body.model, questions: Object.keys(body.questions), options: Object.keys(body.questions.tier.criteria), criteria: body.questions.tier.criteria, instructions: body.questions.tier.instructions });
      const state: string = body.state;
      if (body.model === "bad/model") {
        res.statusCode = 500;
        res.end("{}");
        return;
      }
      const wanted = /rename|typo/.test(state) ? "haiku" : /small edit/.test(state) ? "sonnet" : /plan/.test(state) ? "fable" : "opus";
      // A tier that is not among the options cannot be chosen: the nearest below is.
      const options = Object.keys(body.questions.tier.criteria);
      const tier = options.includes(wanted) ? wanted : options[options.length - 1];
      // The model called "unsure" splits its mass; the others are sure.
      const p = body.model === "unsure/model" ? 0.5 : 0.97;
      const probabilities = Object.fromEntries(options.map((t) => [t, t === tier ? p : (1 - p) / (options.length - 1)]));
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/systemone") {
        // A Laya server: its own `confidence` is another quantity; the Jev-scale number is x_jev_confidence.
        const jevScale = body.model === "no-xjev" ? {} : { x_jev_confidence: p };
        res.end(
          JSON.stringify({
            answers: {
              tier: { type: "choice", choice: tier, probabilities, confidence: 0.01, ...jevScale },
              effort: { type: "score", score: 2, probabilities: [0.1, 0.2, 0.4, 0.2, 0.1], confidence: 0.01, ...jevScale },
            },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: "gen-dec-1",
          model: `${body.model}-20261014`,
          answers: {
            tier: { type: "choice", choice: tier, probabilities, confidence: 0.123 },
            effort: { type: "score", score: 2, probabilities: [0.1, 0.2, 0.4, 0.2, 0.1] },
          },
          usage: { cost: 0.00002 },
        }),
      );
    });
  });
  return new Promise<{ base: string; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, seen, close: () => server.close() });
    }),
  );
}

const cases = [
  { id: 1, prompt: "rename foo to bar", tier: "haiku" },
  { id: 2, prompt: "a small edit to the handler", tier: "sonnet" },
  { id: 3, prompt: "implement the export endpoint", tier: "opus" },
  { id: 4, prompt: "plan the migration", tier: "fable" },
  { id: 5, prompt: "fix the typo", tier: "sonnet" },
];

describe("run, against a stand-in for the Decisions API", () => {
  test("asks the router's own questions of each model and scores them", async () => {
    const s = await standIn();
    try {
      const r = await run({ cases, models: ["typesafe/jev-1.14", "unsure/model", "bad/model"], base: s.base, api: "decisions", key: "k" });
      // The same two questions the router asks, to the Decisions endpoint, with the key.
      assert.ok(s.seen.length >= 10);
      assert.ok(s.seen.every((x) => x.path === "/api/alpha/decisions" && x.auth === "Bearer k" && x.questions.join() === "tier,effort"));
      // Jev here gets 4 of 5 (the typo case is labelled sonnet, answered haiku).
      assert.equal(r.summaries["typesafe/jev-1.14"].accuracy, 0.8);
      assert.equal(r.summaries["typesafe/jev-1.14"].under, 0.2);
      // The unsure model picks the same tiers but says so: its confidence is lower, read from the probabilities.
      assert.equal(r.summaries["unsure/model"].accuracy, 0.8);
      assert.ok(r.rows["unsure/model"][0].confidence < r.rows["typesafe/jev-1.14"][0].confidence);
      assert.equal(r.summaries["unsure/model"].bars[0.75].share, 0);
      // A model that errors is counted, not scored.
      assert.equal(r.summaries["bad/model"].errors, 5);
      assert.equal(r.summaries["bad/model"].answered, 0);
      assert.equal(r.agreement["typesafe/jev-1.14|unsure/model"], 1);
      // Cost comes from the response, latency is measured.
      assert.ok(Math.abs(r.summaries["typesafe/jev-1.14"].costPer1k - 0.02) < 1e-9);
      assert.ok(r.summaries["typesafe/jev-1.14"].meanMs >= 0);
    } finally {
      s.close();
    }
  });

  test("the table reads the probabilities for every model by default, the router's reading on request", async () => {
    const s = await standIn();
    try {
      const common = await run({ cases: cases.slice(0, 1), models: ["typesafe/jev-1.14"], base: s.base, api: "decisions", key: "k" });
      const router = await run({ cases: cases.slice(0, 1), models: ["typesafe/jev-1.14"], base: s.base, api: "decisions", key: "k", confidence: "router" });
      // From the probabilities: (4·0.97 − 1)/3. As the router reads Jev: the `confidence` field, 0.123.
      assert.ok(Math.abs(common.rows["typesafe/jev-1.14"][0].confidence - (4 * 0.97 - 1) / 3) < 1e-9);
      assert.equal(router.rows["typesafe/jev-1.14"][0].confidence, 0.123);
    } finally {
      s.close();
    }
  });

  test("only the tiers you offer are put to the model, and only those can be picked", async () => {
    const s = await standIn();
    try {
      const r = await run({ cases, models: ["typesafe/jev-1.14"], base: s.base, api: "decisions", key: "k", offered: ["haiku", "sonnet", "opus"] });
      assert.ok(s.seen.every((x) => x.options.join() === "haiku,sonnet,opus"));
      // The "plan" prompt, labelled fable, is answered opus now: fable was never an option.
      assert.equal(r.rows["typesafe/jev-1.14"][3].pick, "opus");
      // A model that names a tier outside the options is an error, not a pick.
      const stray = async () => new Response(JSON.stringify({ answers: { tier: { type: "choice", choice: "fable", probabilities: { haiku: 0.1, fable: 0.9 } }, effort: { type: "score", score: 1 } } }), { status: 200 });
      const bad = await ask({ base: "http://x", api: "decisions", key: "k", model: "m", prompt: "p", offered: ["haiku", "sonnet"], fetchImpl: stray as unknown as typeof fetch });
      assert.equal(bad.error, "no usable tier");
    } finally {
      s.close();
    }
  });

  test("a model written laya:<name> is asked on your Laya server, with its key or none", async () => {
    assert.deepEqual(specOf("laya:multilingual"), { route: "laya", model: "multilingual" });
    assert.deepEqual(specOf("perplexity/pplx-decider-v1.2"), { route: "openrouter", model: "perplexity/pplx-decider-v1.2" });
    const s = await standIn();
    try {
      const open = await run({ cases: cases.slice(0, 2), models: ["laya:multilingual"], layaBase: s.base, layaKey: "", key: "or-key", base: "http://not-used", api: "decisions", confidence: "router" });
      assert.ok(s.seen.every((x) => x.path === "/v1/systemone" && x.auth === undefined && x.model === "multilingual"));
      // Read as the router reads Laya: x_jev_confidence (0.97), not its own `confidence` (0.01).
      assert.equal(open.rows["laya:multilingual"][0].confidence, 0.97);
      assert.deepEqual(open.rows["laya:multilingual"][0].xjev, { tier: true, effort: true });
      const keyed = await run({ cases: cases.slice(0, 1), models: ["laya:multilingual"], layaBase: s.base, layaKey: "nas-key", key: "or-key", base: "http://not-used", api: "decisions" });
      assert.equal(s.seen.at(-1)?.auth, "Bearer nas-key");
      assert.equal(keyed.summaries["laya:multilingual"].answered, 1);
    } finally {
      s.close();
    }
  });

  test("your Laya server is asked one prompt at a time, so its latency is its own", async () => {
    let now = 0;
    let peak = 0;
    const slow = async () => {
      now++;
      peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return new Response(JSON.stringify({ answers: { tier: { type: "choice", choice: "opus", probabilities: { haiku: 0.1, sonnet: 0.1, opus: 0.8 } }, effort: { type: "score", score: 1 } } }), { status: 200 });
    };
    await run({ cases, models: ["laya:multilingual"], layaBase: "http://x", base: "http://y", api: "decisions", key: "k", concurrency: 4, fetchImpl: slow as unknown as typeof fetch });
    assert.equal(peak, 1);
    peak = 0;
    await run({ cases, models: ["laya:multilingual"], layaBase: "http://x", layaConcurrency: 3, base: "http://y", api: "decisions", key: "k", fetchImpl: slow as unknown as typeof fetch });
    assert.ok(peak > 1);
  });

  test("it says when the Jev-scale number is missing from a Laya answer", async () => {
    const s = await standIn();
    try {
      const r = await run({ cases: cases.slice(0, 2), models: ["laya:no-xjev"], layaBase: s.base, base: "http://not-used", api: "decisions", key: "k", confidence: "router" });
      assert.deepEqual(r.rows["laya:no-xjev"][0].xjev, { tier: false, effort: false });
      // With none, the router derives it from the probabilities, so there is still a number.
      assert.ok(r.rows["laya:no-xjev"][0].confidence > 0.9);
    } finally {
      s.close();
    }
  });

  test("the models on a Laya server are listed", async () => {
    const s = await standIn();
    try {
      assert.deepEqual(await layaCatalog({ base: s.base }), ["multilingual", "english"]);
    } finally {
      s.close();
    }
  });

  test("System One mode uses that endpoint", async () => {
    const s = await standIn();
    try {
      await ask({ base: s.base, api: "systemone", key: "k", model: "typesafe/jev-1.14", prompt: "rename foo" });
      assert.equal(s.seen[0]?.path, "/api/v1/systemone");
    } finally {
      s.close();
    }
  });

  test("a request that fails or answers nonsense is an error row, never a throw", async () => {
    const boom = async () => {
      throw new Error("offline");
    };
    const r = await ask({ base: "http://x", api: "decisions", key: "k", model: "m", prompt: "p", fetchImpl: boom as unknown as typeof fetch });
    assert.equal(r.pick, null);
    assert.equal(r.error, "request failed");
    const nonsense = async () => new Response("{\"answers\":{}}", { status: 200 });
    const n = await ask({ base: "http://x", api: "decisions", key: "k", model: "m", prompt: "p", fetchImpl: nonsense as unknown as typeof fetch });
    assert.equal(n.error, "no usable tier");
  });

  test("the command line says why a model failed", async () => {
    const s = await standIn();
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const casesFile = join(dir, "cases.jsonl");
      writeFileSync(casesFile, cases.slice(0, 2).map((c) => JSON.stringify(c)).join("\n") + "\n");
      const script = new URL("../scripts/bench/run.mjs", import.meta.url).pathname;
      const { execFile } = await import("node:child_process");
      const stdout = await new Promise<string>((resolve, reject) =>
        execFile(process.execPath, ["--experimental-strip-types", script, "--cases", casesFile, "--models", "bad/model", "--base", s.base, "--out", join(dir, "o.json")], { env: { ...process.env, OPENROUTER_API_KEY: "k" } }, (err, so) => (err ? reject(err) : resolve(so))),
      );
      assert.match(stdout, /bad\/model failed: HTTP 500 ×2/);
    } finally {
      s.close();
    }
  });

  test("the catalog lists the decision models", async () => {
    const s = await standIn();
    try {
      const list = await catalog({ base: s.base });
      assert.deepEqual(list, [{ id: "typesafe/jev-1.14", name: "Jev 1.14", context: 8000, price: "0.000000042" }]);
    } finally {
      s.close();
    }
  });

  test("the command line prints the table and writes the rows", async () => {
    const s = await standIn();
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const casesFile = join(dir, "cases.jsonl");
      writeFileSync(casesFile, cases.map((c) => JSON.stringify(c)).join("\n") + "\n" + JSON.stringify({ id: 9, prompt: "unlabelled", tier: null }) + "\n");
      const script = new URL("../scripts/bench/run.mjs", import.meta.url).pathname;
      const out = join(dir, "out.json");
      const stdout = await new Promise<string>((resolve, reject) => {
        import("node:child_process").then(({ execFile }) =>
          execFile(process.execPath, ["--experimental-strip-types", script, "--cases", casesFile, "--models", "typesafe/jev-1.14", "--base", s.base, "--out", out], { env: { ...process.env, OPENROUTER_API_KEY: "k" } }, (err, so) => (err ? reject(err) : resolve(so))),
        );
      });
      assert.match(stdout, /5 labelled prompts, 1 models/);
      assert.match(stdout, /\| typesafe\/jev-1\.14 \| 5\/5 \| 80% /);
      assert.doesNotMatch(stdout, /failed:/);
      assert.equal(JSON.parse(readFileSync(out, "utf8")).summaries["typesafe/jev-1.14"].answered, 5);
    } finally {
      s.close();
    }
  });
});



describe("bench:ledger: verdicts from the ledger as a test set", () => {
  const typed = (text: string) => JSON.stringify({ type: "user", message: { content: text } });

  test("records are read from a store file, top level or one down", () => {
    const rec = { id: "t1", at: 1, prompt: "p", jev: "opus" };
    assert.equal(ledgerEntries({ "ledger:2026-10-25": [rec], "session:x": {} }).length, 1);
    assert.equal(ledgerEntries({ data: { "ledger:2026-10-25": [rec, { nope: 1 }] } }).length, 1);
    assert.deepEqual(ledgerEntries({}), []);
  });

  test("the whole prompt is found again by its first 200 characters", () => {
    const long = `refactor the parser so that ${"x".repeat(400)}`;
    const lines = [typed("something else"), typed(long)];
    assert.equal(wholePrompt(long.slice(0, 200), lines), long);
    assert.equal(wholePrompt("not there", lines), null);
  });

  test("the script writes labelled turns, with the whole prompt where the transcript has it", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const long = `plan the migration from MySQL to Postgres and ${"y".repeat(300)}`;
    writeFileSync(join(dir, "store.json"), JSON.stringify({
      "ledger:2026-10-25": [
        { id: "a", at: 2, session: "s1", prompt: long.slice(0, 200), jev: "opus", decider: "Jev", label: "fable" },
        { id: "b", at: 1, session: "gone", prompt: "rename foo", jev: "haiku", decider: "d3-turbo", label: "haiku" },
        { id: "c", at: 3, prompt: "unlabelled", jev: "sonnet" },
        { id: "d", at: 4, prompt: "unrouted", skipped: "timed out" },
      ],
    }));
    writeFileSync(join(dir, "s1.jsonl"), typed(long) + "\n");
    const out = join(dir, "out.jsonl");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/bench/ledger.mjs", "--store", join(dir, "store.json"), "--dir", dir, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => [x.prompt.length > 200, x.tier, x.jev, x.decider]), [[false, "haiku", "haiku", "d3-turbo"], [true, "fable", "opus", "Jev"]]);
    assert.match(r.stdout, /2 turns written .* \(2 labelled, 1 with the whole prompt from the transcript\)/);
    const all = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/bench/ledger.mjs", "--store", join(dir, "store.json"), "--dir", dir, "--out", out, "--all"], { encoding: "utf8" });
    assert.equal(all.status, 0, all.stderr);
    assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 3, "the unlabelled routed turn joins with tier null; the unrouted one never");
  });
});
