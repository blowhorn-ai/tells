import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const publicRoot = fileURLToPath(new URL("../../../public/", import.meta.url));

function indexDirs(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "index.html")))
    .map((entry) => `${prefix}${entry.name}/`);
}

// Every published directory index except the checker at /. Card, stripe, and footer
// tests walk this list, so a new doc page is covered without editing each spec.
export function docPagePaths() {
  const top = indexDirs(publicRoot, "/");
  const checksRoot = join(publicRoot, "checks");
  const checks = existsSync(checksRoot) ? indexDirs(checksRoot, "/checks/") : [];
  return [...top, ...checks].sort();
}

// The checker plus every doc page. no-edge-stripes.spec.js uses this.
export function stripePages() {
  return ["/", ...docPagePaths()];
}
