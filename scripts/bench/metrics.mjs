/**
 * What a decision model's answers on a labelled set add up to. Pure: no
 * network, no files. `rows` are one model's results, one per case:
 *   { label, pick, confidence, ms, cost, error }
 * `label` is the tier a person said the prompt needs, `pick` the tier the
 * model chose (null on an error), `confidence` the router's reading of it.
 */

export const TIERS = ["haiku", "sonnet", "opus", "fable"];
const rank = (t) => TIERS.indexOf(t);

/** The p-th percentile (0..1) of numbers, nearest rank; null for none. */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Bars the router might use: how many answers clear one, and how right those are. */
export const BARS = [0.6, 0.75, 0.9];

export function summarize(rows) {
  const answered = rows.filter((r) => r.pick !== null && r.pick !== undefined && TIERS.includes(r.label));
  const n = answered.length;
  const right = answered.filter((r) => r.pick === r.label);
  const under = answered.filter((r) => rank(r.pick) < rank(r.label));
  const over = answered.filter((r) => rank(r.pick) > rank(r.label));
  const within = answered.filter((r) => Math.abs(rank(r.pick) - rank(r.label)) <= 1);

  // Five equal bins over [0, 1]: what the model says against how often it is right.
  const bins = Array.from({ length: 5 }, (_, i) => ({ lo: i / 5, hi: (i + 1) / 5, n: 0, said: 0, right: 0 }));
  for (const r of answered) {
    const c = Math.min(1, Math.max(0, r.confidence ?? 0));
    const b = bins[Math.min(4, Math.floor(c * 5))];
    b.n++;
    b.said += c;
    if (r.pick === r.label) b.right++;
  }
  const ece = n === 0 ? null : bins.reduce((sum, b) => sum + (b.n === 0 ? 0 : (Math.abs(b.right / b.n - b.said / b.n) * b.n) / n), 0);

  const bars = {};
  for (const bar of BARS) {
    const above = answered.filter((r) => (r.confidence ?? 0) >= bar);
    bars[bar] = { share: n === 0 ? null : above.length / n, accuracy: above.length === 0 ? null : above.filter((r) => r.pick === r.label).length / above.length };
  }

  const times = rows.map((r) => r.ms).filter((x) => Number.isFinite(x));
  const costs = rows.map((r) => r.cost).filter((x) => Number.isFinite(x));
  return {
    cases: rows.length,
    answered: n,
    errors: rows.filter((r) => r.error).length,
    accuracy: n === 0 ? null : right.length / n,
    withinOne: n === 0 ? null : within.length / n,
    under: n === 0 ? null : under.length / n,
    over: n === 0 ? null : over.length / n,
    ece,
    bins: bins.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, said: b.n === 0 ? null : b.said / b.n, accuracy: b.n === 0 ? null : b.right / b.n })),
    bars,
    meanMs: mean(times),
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    costPer1k: costs.length === 0 ? null : mean(costs) * 1000,
  };
}

/** How often two models pick the same tier on the cases both answered: { "a|b": share }. */
export function agreement(byModel) {
  const names = Object.keys(byModel);
  const out = {};
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const a = byModel[names[i]];
      const b = byModel[names[j]];
      let both = 0;
      let same = 0;
      for (let k = 0; k < Math.min(a.length, b.length); k++) {
        if (!a[k]?.pick || !b[k]?.pick) continue;
        both++;
        if (a[k].pick === b[k].pick) same++;
      }
      out[`${names[i]}|${names[j]}`] = both === 0 ? null : same / both;
    }
  return out;
}

/** How many of each label there are, over the rows that carry a tier label. */
export function labelCounts(rows) {
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));
  for (const r of rows) if (TIERS.includes(r.label)) counts[r.label]++;
  return counts;
}

/**
 * What always picking one tier would score: the bar a model has to clear to
 * be worth asking at all. A set where half the prompts are `sonnet` is
 * matched by a model that never looks at the prompt.
 */
export function baselines(rows) {
  const counts = labelCounts(rows);
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.fromEntries(TIERS.map((t) => [t, n === 0 ? null : counts[t] / n]));
}

/** label (rows) by pick (columns), counts, over the answered cases. */
export function confusion(rows) {
  const m = Object.fromEntries(TIERS.map((l) => [l, Object.fromEntries(TIERS.map((p) => [p, 0]))]));
  for (const r of rows) if (TIERS.includes(r.label) && TIERS.includes(r.pick)) m[r.label][r.pick]++;
  return m;
}

/** P(X ≤ k) for X ~ Binomial(n, 1/2). */
function binomialCdf(k, n) {
  let term = 1; // C(n, 0)
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += term;
    term = (term * (n - i)) / (i + 1);
  }
  return sum / 2 ** n;
}

/**
 * Whether two models differ on the same prompts: the cases where only one is
 * right, and the exact two-sided sign-test p-value on them. A large p means
 * the gap could be luck on a set this size.
 */
export function compare(a, b) {
  let onlyA = 0;
  let onlyB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!a[i]?.pick || !b[i]?.pick || !TIERS.includes(a[i].label)) continue;
    const ra = a[i].pick === a[i].label;
    const rb = b[i].pick === b[i].label;
    if (ra && !rb) onlyA++;
    if (rb && !ra) onlyB++;
  }
  const n = onlyA + onlyB;
  const p = n === 0 ? 1 : Math.min(1, 2 * binomialCdf(Math.min(onlyA, onlyB), n));
  return { onlyA, onlyB, p };
}

const pct = (x) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
const ms = (x) => (x === null || x === undefined ? "–" : `${Math.round(x)}ms`);
const usd = (x) => (x === null || x === undefined ? "–" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);

/** The summaries as a markdown table, one row per model. */
export function table(summaries) {
  const head = "| model | answered | exact | within 1 | too low | too high | ECE | ≥75% of answers (right) | mean / p95 | $ per 1k |";
  const rule = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const rows = Object.entries(summaries).map(([model, s]) => {
    const b = s.bars[0.75];
    return `| ${model} | ${s.answered}/${s.cases}${s.errors ? ` (${s.errors} err)` : ""} | ${pct(s.accuracy)} | ${pct(s.withinOne)} | ${pct(s.under)} | ${pct(s.over)} | ${s.ece === null ? "–" : s.ece.toFixed(3)} | ${pct(b.share)} (${pct(b.accuracy)}) | ${ms(s.meanMs)} / ${ms(s.p95Ms)} | ${usd(s.costPer1k)} |`;
  });
  return [head, rule, ...rows].join("\n");
}

/** Two models' rows as one: the lower or the higher of their two picks, case by case. */
export function combine(a, b, rule) {
  return a.map((ra, i) => {
    const rb = b[i];
    if (!ra?.pick || !rb?.pick) return { ...ra, pick: null };
    const pick = (rule === "lower" ? rank(ra.pick) <= rank(rb.pick) : rank(ra.pick) >= rank(rb.pick)) ? ra.pick : rb.pick;
    return { ...ra, pick, confidence: Math.min(ra.confidence ?? 0, rb.confidence ?? 0) };
  });
}

/** The label counts, the always-one-tier baselines and a confusion matrix per model, as text. */
export function report(rows, summaries) {
  const first = Object.values(rows)[0] ?? [];
  const counts = labelCounts(first);
  const base = baselines(first);
  const out = [];
  out.push(`Your labels: ${TIERS.map((t) => `${t} ${counts[t]}`).join(", ")}`);
  out.push(`Never looking at the prompt and always saying one tier scores: ${TIERS.map((t) => `${t} ${pct(base[t])}`).join(", ")}`);
  for (const [model, r] of Object.entries(rows)) {
    const m = confusion(r);
    out.push(`\n${model}: your label (rows) against its pick (columns)`);
    out.push(`            ${TIERS.map((t) => t.padStart(7)).join("")}`);
    for (const l of TIERS) out.push(`  ${l.padEnd(9)} ${TIERS.map((t) => String(m[l][t]).padStart(7)).join("")}`);
  }
  const names = Object.keys(rows);
  if (names.length > 1) {
    out.push(`\nAgainst ${names[0]}, on the cases where exactly one of the two is right (a p above 0.05 means the gap could be luck):`);
    for (const other of names.slice(1)) {
      const c = compare(rows[names[0]], rows[other]);
      out.push(`  ${other}: ${names[0]} alone right ${c.onlyA}, ${other} alone right ${c.onlyB}, p = ${c.p.toFixed(2)}`);
    }
  }
  if (names.length > 1) {
    out.push(`\nTwo models together, ${names[0]} with each other (the lower or the higher of the two picks). Many rules on a few dozen prompts will find a flattering one by luck: treat this as a lead to test on fresh prompts, not a result.`);
    for (const other of names.slice(1))
      for (const rule of ["lower", "higher"]) {
        const s = summarize(combine(rows[names[0]], rows[other], rule));
        out.push(`  ${rule.padEnd(6)} of ${names[0]} and ${other}: exact ${pct(s.accuracy)}, too low ${pct(s.under)}, too high ${pct(s.over)}`);
      }
  }
  void summaries;
  return out.join("\n");
}
