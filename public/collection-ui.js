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
        : "Not kept. Reports from this browser are not stored, and the copy of this run was removed.";
    }
  };
  describe();
  toggle.addEventListener("change", async () => {
    await setCollection(toggle.checked);
    describe();
  });
}
