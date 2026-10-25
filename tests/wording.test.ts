import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { parseCatalog } from "../hooks/catalog.ts";
import { assignmentsOf, BUILTIN_WORDINGS, unknownNames, wordingFor, wordingOf } from "../hooks/wording.ts";

describe("wording per decision model", () => {
  test("the shipped sonnet-wider is the bench's file, word for word", () => {
    const file = JSON.parse(readFileSync(new URL("../scripts/bench/criteria/sonnet-wider.json", import.meta.url), "utf8"));
    assert.deepEqual(BUILTIN_WORDINGS["sonnet-wider"], file);
  });

  test("a wording from JSON is checked", () => {
    assert.deepEqual(wordingOf({ criteria: { sonnet: "  a  b " } }), { criteria: { sonnet: "a b" } });
    assert.deepEqual(wordingOf({ instructions: "Which tier?" }), { instructions: "Which tier?" });
    assert.equal(wordingOf({ criteria: { mythos: "x" } }), null);
    assert.equal(wordingOf({ criteria: { sonnet: "" } }), null);
    assert.equal(wordingOf({ criteria: { sonnet: "x".repeat(601) } }), null);
    assert.equal(wordingOf({}), null);
    assert.equal(wordingOf("text"), null);
  });

  test("assignments, keyed as the bars are", () => {
    assert.deepEqual({ ...assignmentsOf("Microsoft-Decision-1=Sonnet-Wider, laya=x;bad pair=") }, { "microsoft-decision-1": "sonnet-wider", laya: "x" });
    const available = BUILTIN_WORDINGS;
    assert.equal(wordingFor({ "microsoft/microsoft-decision-1": "sonnet-wider" }, available, "openrouter-decisions", "microsoft/microsoft-decision-1")?.name, "sonnet-wider");
    assert.equal(wordingFor({ "microsoft-decision-1": "sonnet-wider" }, available, "openrouter-decisions", "microsoft/microsoft-decision-1")?.name, "sonnet-wider");
    assert.equal(wordingFor({ laya: "sonnet-wider" }, available, "laya", "multilingual")?.name, "sonnet-wider");
    assert.equal(wordingFor({ laya: "nope" }, available, "laya", "multilingual"), null);
    assert.equal(wordingFor({ constructor: "sonnet-wider" }, available, "constructor", "x/constructor")?.name, "sonnet-wider");
    assert.equal(wordingFor({}, available, "openrouter", "typesafe/jev-1.14"), null);
    assert.deepEqual(unknownNames({ a: "sonnet-wider", b: "nope", c: "nope" }, available), ["nope"]);
  });

  test("the catalog can add wordings and assign them; a bad entry is dropped alone", () => {
    const base = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
    const r = parseCatalog({
      ...base,
      wordings: { bolder: { criteria: { opus: "Real work." } }, Bad: { criteria: {} }, empty: {} },
      deciderWordings: { "Microsoft-Decision-1": "bolder", "x y": "bolder" },
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.catalog.wordings, { bolder: { criteria: { opus: "Real work." } } });
    assert.deepEqual(r.catalog.deciderWordings, { "microsoft-decision-1": "bolder" });
    assert.deepEqual(r.dropped.filter((d) => d.includes("wording")).sort(), ["decider wording x y", "wording Bad", "wording empty"]);
  });
});
