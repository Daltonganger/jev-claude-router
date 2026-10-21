/**
 * A stand-in for Jev, for driving the real plugin without a TypeSafe key.
 * It answers /v1/systemone over https with the tier and effort the prompt
 * asks for: `[[t=haiku]]` picks the tier (sonnet by default) and `[[e=0..4]]`
 * the effort score (low … max; 2 by default). `[[c=0.3]]` sets the effort
 * confidence (0.99 by default); the tier's confidence is always 0.99.
 *
 * With FAKE_STYLE=laya it answers as a Laya server does: `confidence` is a
 * different quantity (0.99 here, whatever the choice), and the Jev-scale number
 * is `x_jev_confidence` (`[[x=0.5]]` sets the tier's; 0.99 by default).
 *
 *   node scripts/fake-jev.mjs <dir>     # <dir> holds key.pem and cert.pem; writes <dir>/jev.log
 */
import https from "node:https";
import { appendFileSync, readFileSync } from "node:fs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/fake-jev.mjs <dir with key.pem and cert.pem>");
  process.exit(2);
}
const log = (o) => appendFileSync(`${dir}/jev.log`, JSON.stringify(o) + "\n");

https
  .createServer({ key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) }, (req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(b);
      } catch {}
      const state = String(body.state ?? "");
      const e = /\[\[e=(\d)\]\]/.exec(state);
      const t = /\[\[t=(\w+)\]\]/.exec(state);
      const tier = t ? t[1] : "sonnet";
      const score = e ? Number(e[1]) : 2;
      const c = /\[\[c=([\d.]+)\]\]/.exec(state);
      const effortConfidence = c ? Number(c[1]) : 0.99;
      const x = /\[\[x=([\d.]+)\]\]/.exec(state);
      const tierX = x ? Number(x[1]) : 0.99;
      const laya = process.env.FAKE_STYLE === "laya";
      const offered = Object.keys(body.questions?.tier?.criteria ?? {});
      log({ url: req.url, tier, score, offered, state: state.slice(0, 80) });
      const probs = Object.fromEntries(offered.map((o) => [o, o === tier ? 0.99 : 0.01 / Math.max(1, offered.length - 1)]));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          answers: {
            tier: laya
              ? { type: "choice", choice: tier, confidence: 0.99, x_jev_confidence: tierX, probabilities: probs }
              : { type: "choice", choice: tier, confidence: 0.99, probabilities: probs },
            effort: laya
              ? { type: "score", score, confidence: 0.99, x_jev_confidence: effortConfidence }
              : { type: "score", score, confidence: effortConfidence },
          },
        }),
      );
    });
  })
  .listen(8443, "127.0.0.1", () => console.log("up"));
