// The visitor's collection setting. Tells keeps a redacted copy of each report for later reporting unless the
// visitor opts out. The setting is on by default, is kept in this browser only, and a `collect=off` page
// parameter (the CLI's --no-collect) applies to that load.

export const COLLECT_HEADER = "X-Tells-Collect";
export const RUN_HEADER = "X-Tells-Run";

const STORAGE_KEY = "tells.collect";
let runId = null;

export function currentRunId() {
  if (!runId) runId = crypto.randomUUID();
  return runId;
}

export function newRunId() {
  runId = crypto.randomUUID();
  return runId;
}

function storedSetting() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

export function isCollectionOn() {
  if (new URLSearchParams(location.search).get("collect") === "off") return false;
  return storedSetting() !== "off";
}

// Turning collection off also asks the server to remove the copy of the run already posted on this page.
export async function setCollection(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch (_) {
    // Storage blocked: the setting then holds for this page only.
  }
  if (!on && runId) {
    try {
      await fetch("/api/report/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId })
      });
    } catch (_) {
      // Best effort: the record also expires on its own.
    }
  }
}
