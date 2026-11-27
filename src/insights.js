import { CARD_ART } from "./card-art.js";
// The insights report (blowhorn-ai/tells#107): cards computed from the daily aggregates in agg_counts.
// Everything here reads aggregate counts only. No card holds anything from one visitor.

export const SAMPLE_LABEL = "This is a sample of visitors, not the whole web.";
export const WINDOWS = [7, 30, 90];
const FLAGGED = (cls) => cls !== "likely_human";

const pct = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);
const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export function windowStart(now, days) {
  const start = new Date(now.getTime() - (days - 1) * 86400000);
  return start.toISOString().slice(0, 10);
}

function tally(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.dim}\u0000${row.k}`;
    map.set(key, (map.get(key) || 0) + Number(row.n || 0));
  }
  const dim = (name) => [...map.entries()]
    .filter(([key]) => key.startsWith(`${name}\u0000`))
    .map(([key, n]) => ({ k: key.slice(name.length + 1), n }));
  return { dim, total: map.get("total\u0000all") || 0 };
}

function top(list, count) {
  return [...list].sort((a, b) => b.n - a.n || a.k.localeCompare(b.k)).slice(0, count);
}

export function buildInsights(rows, windowDays, now = new Date()) {
  const { dim, total } = tally(rows);
  const asOf = now.toISOString().slice(0, 10);
  const label = { sample: total, window_days: windowDays, as_of: asOf, note: SAMPLE_LABEL };
  const card = (id, title, headline, data, extra = {}) => ({
    id,
    title,
    headline,
    quote: `${headline} (n = ${(extra.sample ?? total).toLocaleString("en-US")} runs, last ${windowDays} days, as of ${asOf}). ${SAMPLE_LABEL} Blowhorn Tells`,
    ...label,
    data,
    ...extra
  });

  if (total === 0) {
    return { ...label, empty: true, cards: [] };
  }

  const cards = [];

  const reasons = top(dim("reason"), 12).map((r) => ({ id: r.k, runs: r.n, share: pct(r.n, total) }));
  if (reasons.length) {
    cards.push(card("reasons", "What gives a bot away", `The most common tell, ${reasons[0].id}, fired in ${reasons[0].share}% of runs`, { reasons }));
  }

  const classes = dim("class").map((c) => ({ class: c.k, runs: c.n, share: pct(c.n, total) }))
    .sort((a, b) => b.runs - a.runs);
  const histogram = Array.from({ length: 10 }, (_, i) => ({ bucket: i, runs: dim("score").find((s) => s.k === String(i))?.n || 0 }));
  const human = classes.find((c) => c.class === "likely_human")?.share || 0;
  cards.push(card("verdicts", "How runs score", `${human}% of runs scored as likely human`, { classes, histogram }));

  const pairs = top(dim("pair"), 10).map((p) => {
    const [a, b] = p.k.split("|");
    return { a, b, runs: p.n, share: pct(p.n, total) };
  });
  if (pairs.length) {
    cards.push(card("pairs", "Tells that travel together", `${pairs[0].a} and ${pairs[0].b} fired together in ${pairs[0].share}% of runs`, { pairs }));
  }

  const asn = new Map();
  for (const entry of dim("asn")) {
    const [kind, cls] = entry.k.split("|");
    const row = asn.get(cls) || { class: cls, runs: 0, datacenter: 0 };
    row.runs += entry.n;
    if (kind === "datacenter") row.datacenter += entry.n;
    asn.set(cls, row);
  }
  const datacenter = [...asn.values()].map((r) => ({ ...r, share: pct(r.datacenter, r.runs) })).sort((a, b) => b.runs - a.runs);
  const dcRuns = datacenter.reduce((sum, r) => sum + r.datacenter, 0);
  cards.push(card("datacenter", "Datacenter addresses", `${pct(dcRuns, total)}% of runs came from datacenter addresses`, { datacenter }));

  const inter = { completed: 0, flagged: 0 };
  for (const entry of dim("interaction")) {
    const [cls, done] = entry.k.split("|");
    if (done === "1") {
      inter.completed += entry.n;
      if (FLAGGED(cls)) inter.flagged += entry.n;
    }
  }
  if (inter.completed > 0) {
    cards.push(card("falsealarm", "The false alarm rate", `${pct(inter.flagged, inter.completed)}% of runs that completed the human interaction challenge were still flagged`, { ...inter, share: pct(inter.flagged, inter.completed) }, { sample: inter.completed }));
  }

  const cohorts = new Map();
  for (const entry of dim("browser")) {
    const [ua, os, cls] = entry.k.split("|");
    const key = `${ua} on ${os}`;
    const row = cohorts.get(key) || { cohort: key, runs: 0, flagged: 0 };
    row.runs += entry.n;
    if (FLAGGED(cls)) row.flagged += entry.n;
    cohorts.set(key, row);
  }
  const allFlagged = [...cohorts.values()].reduce((s, r) => s + r.flagged, 0);
  const rate = allFlagged / total;
  const browsers = [...cohorts.values()].sort((a, b) => b.runs - a.runs).slice(0, 12)
    .map((r) => ({ ...r, share: pct(r.flagged, r.runs) }));
  if (browsers.length) {
    cards.push(card("browsers", "Browsers and how they score", `${browsers[0].cohort} is the largest group, ${browsers[0].share}% flagged`, { browsers, overall_flagged_share: pct(allFlagged, total) }));
  }

  const checks = new Map();
  for (const entry of dim("check")) {
    const [name, status] = entry.k.split("|");
    const row = checks.get(name) || { name, statuses: {}, runs: 0 };
    row.statuses[status] = (row.statuses[status] || 0) + entry.n;
    row.runs += entry.n;
    checks.set(name, row);
  }
  const checkList = top([...checks.values()].map((r) => ({ k: r.name, n: r.runs, ...r })), 12);
  if (checkList.length) {
    cards.push(card("checks", "Check health", `${plural(checks.size, "check")} reported in this window`, { checks: checkList.map(({ name, statuses, runs }) => ({ name, statuses, runs })) }));
  }

  const countries = top(dim("country"), 20).map((c) => ({ country: c.k, runs: c.n, share: pct(c.n, total) }));
  if (countries.length) {
    cards.push(card("countries", "Where runs come from", `${countries[0].country} is the largest source, ${countries[0].share}% of runs`, { countries }));
  }

  // No fixed list can name what the data will show. Rank each browser group by how far its flagged count sits
  // from what the overall rate predicts. A larger sample moves the count further, so big groups rank first
  // without any cut-off.
  const standouts = [...cohorts.values()]
    .map((r) => ({ ...r, expected: Math.round(r.runs * rate * 10) / 10, excess: Math.round((r.flagged - r.runs * rate) * 10) / 10, share: pct(r.flagged, r.runs) }))
    .filter((r) => r.excess !== 0)
    .sort((a, b) => Math.abs(b.excess) - Math.abs(a.excess))
    .slice(0, 6);
  if (standouts.length) {
    const s = standouts[0];
    cards.push(card("standouts", "Standouts", `${s.cohort} is flagged ${s.excess > 0 ? "more" : "less"} than the overall rate: ${s.share}% against ${pct(allFlagged, total)}% (${plural(s.runs, "run")})`, { standouts }));
  }

  return { ...label, empty: false, cards };
}

const MAX_LINES = 5;

export function shareCardSvg(card) {
  const esc = (text) => String(text).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]);
  const words = String(card.headline).split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > 24) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  if (lines.length > MAX_LINES) {
    // Cut at a word boundary and say so, never mid-sentence without a mark.
    const kept = lines.slice(0, MAX_LINES);
    kept[MAX_LINES - 1] = `${kept[MAX_LINES - 1].replace(/[\s.,;:]+$/, "").slice(0, 21)}...`;
    lines.length = 0;
    lines.push(...kept);
  }
  const body = lines.map((text, i) => `<text x="72" y="${250 + i * 70}" font-size="52" font-weight="700" fill="#FFFFFF">${esc(text)}</text>`).join("");
  const src = CARD_ART[card.id];
  const art = src ? `<image href="${src}" x="830" y="190" width="340" height="191" preserveAspectRatio="xMidYMid meet"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${esc(card.headline)}">
<rect width="1200" height="630" fill="#1E2117"/>
<rect x="0" y="0" width="16" height="630" fill="#00B39F"/>
<text x="72" y="110" font-size="30" font-weight="700" fill="#00D3A9" font-family="Helvetica, Arial, sans-serif">${esc(card.title.toUpperCase())}</text>
<g font-family="Helvetica, Arial, sans-serif">${body}</g>${art}
<text x="72" y="560" font-size="24" fill="#D9DFDC" font-family="Helvetica, Arial, sans-serif">n = ${esc(card.sample.toLocaleString("en-US"))} runs, last ${esc(card.window_days)} days, as of ${esc(card.as_of)}</text>
<text x="72" y="596" font-size="22" fill="#A3AEB2" font-family="Helvetica, Arial, sans-serif">${esc(SAMPLE_LABEL)}  Blowhorn Tells</text>
</svg>`;
}
