import { isCollectionOn, setCollection } from "./collection.js";

// The footer checkbox. On by default; unchecking it also removes the copy of this page's run already posted.
export function setupCollectionToggle() {
  const toggle = document.getElementById("collectToggle");
  const note = document.getElementById("collectNote");
  if (!toggle) return;
  toggle.checked = isCollectionOn();
  const describe = () => {
    if (note) {
      note.textContent = toggle.checked
        ? ""
        : "Not kept. Reports from this browser are not stored, and this run was removed from the catalog. It may remain in anonymous daily totals.";
    }
  };
  describe();
  toggle.addEventListener("change", async () => {
    await setCollection(toggle.checked);
    describe();
  });
}

// The total number of reports collected, from the aggregate counter. Hidden until storage is on.
export async function showCollectedTotal() {
  const el = document.getElementById("collectTotal");
  if (!el) return;
  try {
    const response = await fetch("/api/stats");
    const stats = await response.json();
    if (!stats.enabled) return;
    el.textContent = `Reports collected so far: ${Number(stats.total_collected).toLocaleString("en-US")} (a sample of visitors, not the whole web).`;
    el.hidden = false;
  } catch (_) {
    // The figure is optional.
  }
}
