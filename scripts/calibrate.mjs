// Scores a labelled set of reports and shows how the verdict and each score threshold perform.
//
// Usage: node scripts/calibrate.mjs labelled.ndjson [--json]
//
// Each line of the input is {"label": "human" | "bot", "report": <the report object scoreReport reads>}
// with an optional "source" (for example "browser-use", "stock-chrome") used for the per-source table.
// Labels come from ground-truth captures (#105, #74 to #82), stock and privacy browsers (#43) and
// completed interaction runs. The script reads files only and writes nothing.
import { readFileSync } from "node:fs";
import { scoreReport } from "../src/report-verdict.js";

export function wilson(successes, total, z = 1.96) {
  if (total === 0) return { low: 0, high: 1 };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export function evaluate(rows) {
  const scored = rows.map((row) => ({ ...row, verdict: scoreReport(row.report) }));
  const bots = scored.filter((row) => row.label === "bot");
  const humans = scored.filter((row) => row.label === "human");
  const flagged = (row) => row.verdict.classification !== "likely_human";
  const caught = bots.filter(flagged).length;
  const falseAlarms = humans.filter(flagged).length;
  const sweep = [];
  for (let threshold = 10; threshold <= 100; threshold += 5) {
    const botHits = bots.filter((row) => row.verdict.score < threshold).length;
    const humanHits = humans.filter((row) => row.verdict.score < threshold).length;
    sweep.push({
      threshold,
      recall: bots.length ? botHits / bots.length : null,
      false_alarm_rate: humans.length ? humanHits / humans.length : null
    });
  }
  const bySource = {};
  for (const row of scored) {
    const key = `${row.source || "unlabelled"} (${row.label})`;
    bySource[key] ||= { runs: 0, flagged: 0 };
    bySource[key].runs += 1;
    if (flagged(row)) bySource[key].flagged += 1;
  }
  return {
    bots: bots.length,
    humans: humans.length,
    bot_recall: bots.length ? caught / bots.length : null,
    bot_recall_ci: wilson(caught, bots.length),
    human_false_alarm_rate: humans.length ? falseAlarms / humans.length : null,
    human_false_alarm_ci: wilson(falseAlarms, humans.length),
    sweep,
    by_source: bySource
  };
}

export function parseNdjson(text) {
  return text.split("\n").filter((line) => line.trim()).map((line, i) => {
    const row = JSON.parse(line);
    if (row.label !== "human" && row.label !== "bot") throw new Error(`Line ${i + 1}: label must be "human" or "bot".`);
    if (!row.report || typeof row.report !== "object") throw new Error(`Line ${i + 1}: missing report.`);
    return row;
  });
}

const pct = (value) => (value == null ? "n/a" : `${(value * 100).toFixed(1)}%`);

if (process.argv[1] && process.argv[1].endsWith("calibrate.mjs")) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/calibrate.mjs labelled.ndjson [--json]");
    process.exit(2);
  }
  const result = evaluate(parseNdjson(readFileSync(file, "utf8")));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`bots ${result.bots}, humans ${result.humans}`);
    console.log(`bot recall ${pct(result.bot_recall)} (95% ${pct(result.bot_recall_ci.low)} to ${pct(result.bot_recall_ci.high)})`);
    console.log(`human false alarms ${pct(result.human_false_alarm_rate)} (95% ${pct(result.human_false_alarm_ci.low)} to ${pct(result.human_false_alarm_ci.high)})`);
    console.log("\nthreshold  recall  false alarms");
    for (const row of result.sweep) console.log(`${String(row.threshold).padStart(9)}  ${pct(row.recall).padStart(6)}  ${pct(row.false_alarm_rate).padStart(12)}`);
    console.log("\nsource                          runs  flagged");
    for (const [key, v] of Object.entries(result.by_source)) console.log(`${key.padEnd(30)}  ${String(v.runs).padStart(4)}  ${String(v.flagged).padStart(7)}`);
  }
}
