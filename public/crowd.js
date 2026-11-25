// "Where you land": compares this run with the collected reports, from the published aggregates only.
const NOTE = "This is a sample of visitors, not the whole web.";

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function placeInCrowd(score, histogram) {
  const total = histogram.reduce((sum, b) => sum + b.runs, 0);
  if (!total || !Number.isFinite(score)) return null;
  const bucket = Math.min(9, Math.max(0, Math.floor(score / 10)));
  const below = histogram.filter((b) => b.bucket < bucket).reduce((sum, b) => sum + b.runs, 0);
  const same = histogram.find((b) => b.bucket === bucket)?.runs || 0;
  return Math.round(((below + same / 2) / total) * 100);
}

export async function renderCrowd(report) {
  try {
    const response = await fetch("/api/insights?window=30");
    const data = await response.json();
    if (!data.enabled || data.empty) return;
    const verdicts = data.cards.find((c) => c.id === "verdicts");
    const reasons = data.cards.find((c) => c.id === "reasons");
    if (!verdicts) return;
    const score = report?.verdict?.score;
    const percentile = placeInCrowd(score, verdicts.data.histogram);
    if (percentile === null) return;

    let section = document.getElementById("crowdPanel");
    if (!section) {
      section = el("section", undefined, "card card-paper crowd-panel");
      section.id = "crowdPanel";
      section.setAttribute("aria-labelledby", "crowdTitle");
      document.getElementById("verdictCard")?.insertAdjacentElement("afterend", section);
    }
    section.replaceChildren();
    const title = el("h2", "Where you land");
    title.id = "crowdTitle";
    section.append(
      title,
      el("p", `Your score of ${score} is higher than about ${percentile}% of runs in the last 30 days.`)
    );
    const fired = (report?.verdict?.reasons || []).map((r) => r?.id).filter(Boolean);
    if (fired.length) {
      const list = el("ul", undefined, "crowd-reasons");
      for (const id of fired.slice(0, 8)) {
        const known = reasons?.data.reasons.find((r) => r.id === id);
        list.append(el("li", known
          ? `${id.replaceAll("_", " ")}: fired in ${known.share}% of runs`
          : `${id.replaceAll("_", " ")}: rarer than the twelve most common tells`));
      }
      section.append(list);
    }
    section.append(
      el("p", `n = ${verdicts.sample.toLocaleString("en-US")} runs, last 30 days, as of ${verdicts.as_of}. ${NOTE}`, "claim-label")
    );
    const link = el("a", "See all insights");
    link.href = "/insights/";
    link.className = "button-secondary";
    section.append(link);
  } catch (_) {
    // The comparison is optional.
  }
}
