import { escapeHtml } from "/utils.js";

const $ = (selector) => document.querySelector(selector);
const NOTE = "This is a sample of visitors, not the whole web.";
const params = new URLSearchParams(location.search);
let windowDays = [7, 30, 90].includes(Number(params.get("window"))) ? Number(params.get("window")) : 30;
let focusReason = null;
let data = null;

const fmt = (n) => Number(n).toLocaleString("en-US");
const label = (text) => escapeHtml(String(text).replaceAll("_", " "));

function barRow(name, share, runs, extra = "", attrs = "") {
  const width = Math.max(0, Math.min(100, share));
  return `<tr ${attrs}><th scope="row">${label(name)}</th><td class="bar-cell"><span class="bar" style="--w:${width}%" aria-hidden="true"></span></td><td class="num">${share}%</td><td class="num dim">${fmt(runs)}${extra}</td></tr>`;
}

function barTable(rows, head = ["", "Share", "Runs"]) {
  return `<table class="bars"><thead><tr><th scope="col">${head[0]}</th><th scope="col" class="bar-cell"><span class="sr-only">Bar</span></th><th scope="col" class="num">${head[1]}</th><th scope="col" class="num">${head[2]}</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

const renderers = {
  reasons(card) {
    return barTable(card.data.reasons.map((r) =>
      barRow(r.id, r.share, r.runs, "", `class="pick${focusReason === r.id ? " is-focus" : ""}" data-reason="${escapeHtml(r.id)}" tabindex="0" role="button" aria-pressed="${focusReason === r.id}"`)), ["Tell", "Of runs", "Runs"]) +
      `<p class="hint">Select a tell to filter the pairs below.</p>`;
  },
  verdicts(card) {
    const max = Math.max(1, ...card.data.histogram.map((b) => b.runs));
    const hist = card.data.histogram.map((b) => `<li style="--h:${Math.round((100 * b.runs) / max)}%" title="${b.bucket * 10} to ${b.bucket * 10 + 9}: ${fmt(b.runs)} runs"><span class="col"></span><span class="tick">${b.bucket * 10}</span></li>`).join("");
    return `<ol class="hist" aria-label="Score histogram, 0 to 100 in steps of 10">${hist}</ol>` +
      barTable(card.data.classes.map((c) => barRow(c.class, c.share, c.runs)), ["Verdict", "Of runs", "Runs"]);
  },
  pairs(card) {
    const rows = card.data.pairs.filter((p) => !focusReason || p.a === focusReason || p.b === focusReason);
    if (!rows.length) return `<p class="hint">No pair includes ${label(focusReason)} in this window.</p>`;
    return barTable(rows.map((p) => barRow(`${p.a} + ${p.b}`, p.share, p.runs)), ["Pair", "Of runs", "Runs"]);
  },
  datacenter(card) {
    return barTable(card.data.datacenter.map((r) => barRow(r.class, r.share, r.runs, ` (${fmt(r.datacenter)} datacenter)`)), ["Verdict", "Datacenter", "Runs"]);
  },
  falsealarm(card) {
    const d = card.data;
    return `<p class="big">${d.share}<span>%</span></p><p class="hint">${fmt(d.flagged)} of ${fmt(d.completed)} runs that completed the interaction challenge were flagged as suspicious or likely bot.</p>`;
  },
  browsers(card) {
    return barTable(card.data.browsers.map((r) => barRow(r.cohort, r.share, r.runs)), ["Browser", "Flagged", "Runs"]) +
      `<p class="hint">Flagged means suspicious or likely bot. Overall: ${card.data.overall_flagged_share}% flagged.</p>`;
  },
  checks(card) {
    return `<table class="plain-table"><thead><tr><th scope="col">Check</th><th scope="col">Statuses</th><th scope="col" class="num">Reports</th></tr></thead><tbody>${card.data.checks.map((c) =>
      `<tr><th scope="row">${label(c.name)}</th><td>${Object.entries(c.statuses).map(([s, n]) => `${label(s)} ${fmt(n)}`).join(", ")}</td><td class="num">${fmt(c.runs)}</td></tr>`).join("")}</tbody></table>`;
  },
  countries(card) {
    const max = Math.max(1, ...card.data.countries.map((c) => c.share));
    return `<ul class="tiles">${card.data.countries.map((c) => `<li style="--a:${(0.25 + 0.75 * c.share / max).toFixed(2)}"><strong>${escapeHtml(c.country)}</strong><span>${c.share}%</span></li>`).join("")}</ul>`;
  },
  standouts(card) {
    return `<table class="plain-table"><thead><tr><th scope="col">Group</th><th scope="col" class="num">Runs</th><th scope="col" class="num">Flagged</th><th scope="col" class="num">Expected</th><th scope="col" class="num">Difference</th></tr></thead><tbody>${card.data.standouts.map((s) =>
      `<tr><th scope="row">${label(s.cohort)}</th><td class="num">${fmt(s.runs)}</td><td class="num">${fmt(s.flagged)} (${s.share}%)</td><td class="num">${s.expected}</td><td class="num ${s.excess > 0 ? "up" : "down"}">${s.excess > 0 ? "+" : ""}${s.excess}</td></tr>`).join("")}</tbody></table><p class="hint">Ranked by how far the flagged count sits from what the overall rate predicts.</p>`;
  }
};

function cardHtml(card) {
  const render = renderers[card.id];
  const permalink = `${location.origin}/insights/?window=${windowDays}#card-${card.id}`;
  return `<article class="card card-paper insight" id="card-${card.id}" data-card="${card.id}" aria-labelledby="t-${card.id}">
    <p class="label">${escapeHtml(card.title)}</p>
    <h2 id="t-${card.id}">${escapeHtml(card.headline)}</h2>
    <div class="chart">${render ? render(card) : ""}</div>
    <p class="claim-label">n = ${fmt(card.sample)} runs, last ${card.window_days} days, as of ${escapeHtml(card.as_of)}. ${NOTE}</p>
    <p class="actions">
      <button class="button-primary" type="button" data-share="${card.id}">Share this insight</button>
      <button class="button-secondary" type="button" data-copy="${card.id}">Copy quote</button>
      <a class="button-secondary" href="/insights/card/${card.id}.svg?window=${windowDays}" target="_blank" rel="noopener">Image</a>
      <a class="button-secondary" href="${escapeHtml(permalink)}" data-permalink="${card.id}">Link</a>
      <button class="button-secondary" type="button" data-plain="${card.id}" aria-pressed="false">View as table</button>
      <span class="status" role="status" data-status="${card.id}"></span>
    </p>
  </article>`;
}

function render() {
  const mount = $("#cards");
  if (!data || !data.enabled || data.empty) {
    mount.innerHTML = `<section class="card card-paper"><h2>Not enough data yet</h2><p>The insights fill in as reports are collected. Come back soon. ${NOTE}</p></section>`;
    return;
  }
  mount.innerHTML = data.cards.map(cardHtml).join("");
  if (location.hash.startsWith("#card-")) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

function quoteFor(id) {
  const card = data?.cards.find((c) => c.id === id);
  return card ? `${card.quote} ${location.origin}/insights/?window=${windowDays}#card-${id}` : "";
}

async function load() {
  $("#windowNote").textContent = `Last ${windowDays} days.`;
  for (const button of document.querySelectorAll("[data-window]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.window) === windowDays));
  }
  try {
    const response = await fetch(`/api/insights?window=${windowDays}`);
    data = await response.json();
  } catch (_) {
    data = null;
  }
  render();
}

async function loadTotal() {
  try {
    const stats = await (await fetch("/api/stats")).json();
    if (stats.enabled) {
      $("#total").textContent = fmt(stats.total_collected);
      $("#totalSince").textContent = stats.since ? ` since ${stats.since}` : "";
    }
  } catch (_) {
    // The total is optional.
  }
}

document.addEventListener("click", async (event) => {
  const t = event.target.closest("button, [data-reason]");
  if (!t) return;
  if (t.dataset.window) {
    windowDays = Number(t.dataset.window);
    history.replaceState(null, "", `?window=${windowDays}`);
    load();
  } else if (t.dataset.reason) {
    focusReason = focusReason === t.dataset.reason ? null : t.dataset.reason;
    render();
  } else if (t.dataset.copy || t.dataset.share) {
    const id = t.dataset.copy || t.dataset.share;
    const text = quoteFor(id);
    const status = document.querySelector(`[data-status="${id}"]`);
    if (t.dataset.share && navigator.share) {
      try {
        await navigator.share({ title: "Blowhorn Tells", text });
        return;
      } catch (_) {
        // Fall through to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Quote copied.";
    } catch (_) {
      status.textContent = "Copy failed. Select the claim text instead.";
    }
  } else if (t.dataset.plain) {
    const card = document.getElementById(`card-${t.dataset.plain}`);
    const on = card.classList.toggle("as-table");
    t.setAttribute("aria-pressed", String(on));
    t.textContent = on ? "View as bars" : "View as table";
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-reason]")) {
    event.preventDefault();
    event.target.click();
  }
});

load();
loadTotal();
