import { $ } from "./dom.js";

// The same JSON the Raw report panel shows, and the same file the top Download JSON button saves.
export function reportJson(report) {
  return JSON.stringify(report, null, 2);
}

export function buildReportDownload(report, now = new Date()) {
  if (!report) return null;
  return {
    filename: `blowhorn-tells-report-${now.toISOString().replace(/[:.]/g, "-")}.json`,
    body: reportJson(report),
    type: "application/json"
  };
}

// Success and failure both land in the page status, which is an aria-live region.
export async function copyReport(report, { writeText, setStatus }) {
  if (!report) return;
  try {
    await writeText(reportJson(report));
    setStatus("Report copied as JSON.");
  } catch {
    setStatus("Could not copy the report.");
  }
}

function downloadReport(report) {
  const file = buildReportDownload(report);
  if (!file) return;
  const blob = new Blob([file.body], { type: file.type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function setupButtons(state, runChecks, setStatus) {
  const panels = [...document.querySelectorAll(".panel-grid > details.panel")];
  const expandAllBtn = $("#expandAllBtn");
  const collapseAllBtn = $("#collapseAllBtn");
  function updatePanelButtons() {
    const allExpanded = panels.every((panel) => panel.open);
    const allCollapsed = panels.every((panel) => !panel.open);

    if (expandAllBtn) expandAllBtn.disabled = allExpanded;
    if (collapseAllBtn) collapseAllBtn.disabled = allCollapsed;
  }

  expandAllBtn?.addEventListener("click", () => {
    panels.forEach((panel) => { panel.open = true; });
    updatePanelButtons();
  });

  collapseAllBtn?.addEventListener("click", () => {
    panels.forEach((panel) => { panel.open = false; });
    updatePanelButtons();
  });

  panels.forEach((panel) => {
    panel.addEventListener("toggle", updatePanelButtons);
  });

  // A link that names a closed section (an explainer page sending the reader
  // back to one panel) opens that section instead of landing on a shut panel.
  const named = window.location.hash && document.querySelector(window.location.hash);
  if (named?.tagName === "DETAILS") named.open = true;

  updatePanelButtons();

  $("#runBtn").addEventListener("click", () => runChecks(state));

  const onCopy = (event) => {
    // A control inside a summary must not also toggle that disclosure.
    event.stopPropagation();
    return copyReport(state.report, {
      writeText: (text) => navigator.clipboard.writeText(text),
      setStatus
    });
  };
  const onDownload = (event) => {
    event.stopPropagation();
    downloadReport(state.report);
  };
  for (const id of ["#copyBtn", "#copyRawBtn"]) $(id).addEventListener("click", onCopy);
  for (const id of ["#downloadBtn", "#downloadRawBtn"]) $(id).addEventListener("click", onDownload);
}
