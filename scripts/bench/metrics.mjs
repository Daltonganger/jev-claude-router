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
