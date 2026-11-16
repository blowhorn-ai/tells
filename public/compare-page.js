import { compareReports } from "./compare-reports.js";
import { escapeHtml } from "./utils.js";

const $ = (selector) => document.querySelector(selector);

const slots = {
  A: { file: $("#fileA"), text: $("#textA") },
  B: { file: $("#fileB"), text: $("#textB") }
};

for (const slot of Object.values(slots)) {
  slot.file.addEventListener("change", () => {
    const file = slot.file.files?.[0];
    if (!file) return;
    readDropped(file, slot.text);
  });
  const zone = slot.text.closest(".compare-slot");
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("is-dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("is-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) readDropped(file, slot.text);
  });
}

$("#compareForm").addEventListener("submit", (event) => {
  event.preventDefault();
  show(compareReports(slots.A.text.value, slots.B.text.value));
});

function readDropped(file, textarea) {
  const reader = new FileReader();
  reader.onload = () => {
    textarea.value = String(reader.result || "");
  };
  reader.readAsText(file);
}

function show(comparison) {
  const status = $("#compareStatus");
  const errors = comparison.sides.filter((side) => side.error).map((side) => `Report ${side.name}: ${side.error}`);
  status.textContent = errors.length ? errors.join(" ") : "Compared in this browser. Nothing was uploaded.";

  const warning = $("#versionWarning");
  warning.hidden = !comparison.versionWarning;
  warning.textContent = comparison.versionWarning || "";

  $("#verdictDiff").innerHTML = comparison.verdict ? verdictHtml(comparison.verdict) : emptyHtml("Verdict");
  $("#checkDiff").innerHTML = comparison.checks ? checksHtml(comparison.checks) : emptyHtml("Checks");
  $("#flagDiff").innerHTML = comparison.flags ? flagsHtml(comparison.flags) : emptyHtml("Flags");
}

function emptyHtml(title) {
  return `<p class="muted">No ${escapeHtml(title.toLowerCase())} to compare until both files are Tells reports.</p>`;
}

function verdictHtml(verdict) {
  const same = verdict.changed
    ? ""
    : `<p>The verdict matches: ${escapeHtml(verdict.left.label)}, score ${formatScore(verdict.left.score)}.</p>`;
  const reasons = verdict.reasonChanges.length
    ? `<ul>${verdict.reasonChanges.map(reasonItem).join("")}</ul>`
    : `<p class="muted">No reason was added, removed, or changed in severity.</p>`;
  return `${same}
    <div class="table-wrap"><table class="compact-table">
      <thead><tr><th></th><th>Report A</th><th>Report B</th></tr></thead>
      <tbody>
        <tr><th scope="row">Label</th><td>${escapeHtml(verdict.left.label)}</td><td>${escapeHtml(verdict.right.label)}</td></tr>
        <tr><th scope="row">Score</th><td>${formatScore(verdict.left.score)}</td><td>${formatScore(verdict.right.score)}</td></tr>
      </tbody>
    </table></div>
    <h3>Reasons</h3>
    ${reasons}`;
}

function reasonItem(change) {
  const where = change.change === "added"
    ? `only in report B${change.rightSeverity ? `, ${change.rightSeverity}` : ""}`
    : change.change === "removed"
      ? `only in report A${change.leftSeverity ? `, ${change.leftSeverity}` : ""}`
      : `severity ${change.leftSeverity || "unset"} in A, ${change.rightSeverity || "unset"} in B`;
  return `<li>${escapeHtml(change.headline)} <span class="muted">(${escapeHtml(where)})</span></li>`;
}

function checksHtml(checks) {
  const changed = checks.filter((row) => row.changed);
  if (!changed.length) return `<p>Every check matches on status and summary.</p>`;
  const same = checks.length - changed.length;
  const rows = changed.map((row) => `<tr>
    <th scope="row">${escapeHtml(row.name)}</th>
    <td>${sideCell(row.left)}</td>
    <td>${sideCell(row.right)}</td>
  </tr>`).join("");
  return `<p>${changed.length} ${changed.length === 1 ? "check differs" : "checks differ"}. ${same} ${same === 1 ? "check matches" : "checks match"}.</p>
    <div class="table-wrap"><table class="compact-table">
      <thead><tr><th>Check</th><th>Report A</th><th>Report B</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function flagsHtml(flags) {
  const rows = flags.map((flag) => `<tr>
    <th scope="row">${escapeHtml(flag.label)}</th>
    <td>${sideCell(flag.left, "sentence")}</td>
    <td>${sideCell(flag.right, "sentence")}</td>
  </tr>`).join("");
  const changed = flags.filter((flag) => flag.changed).length;
  const lead = changed ? `${changed} of ${flags.length} flag groups differ.` : "Flag groups match.";
  return `<p>${lead}</p>
    <div class="table-wrap"><table class="compact-table">
      <thead><tr><th>Group</th><th>Report A</th><th>Report B</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function sideCell(side, textKey = "summary") {
  return `<span class="check-icon check-${escapeHtml(side.status)}" aria-hidden="true">${icon(side.status)}</span> ${escapeHtml(side.statusLabel)}. ${escapeHtml(side[textKey])}`;
}

function icon(status) {
  if (status === "pass") return "✓";
  if (status === "warn") return "!";
  if (status === "fail") return "✕";
  return "–";
}

function formatScore(score) {
  return score === null ? "n/a" : escapeHtml(String(score));
}
