import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The site moved from layer5io/blowhorn-tells to blowhorn-ai/tells. A leftover
// link in a public page sends visitors to the old repo. .github welcome images
// and historical contributing examples are out of scope.

const OLD_REPO = "layer5io/blowhorn-tells";
const SOURCE = "https://github.com/blowhorn-ai/tells";

function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) found.push(...filesUnder(url));
    else found.push(url);
  }
  return found;
}

function rel(url) {
  const root = new URL("../", import.meta.url).pathname;
  return decodeURIComponent(url.pathname.slice(root.length));
}

const published = filesUnder(new URL("../public/", import.meta.url)).filter((url) => {
  const path = url.pathname;
  return path.endsWith(".html") || path.endsWith("/llms.txt");
});

describe("published source URL", () => {
  it("keeps public pages and llms.txt off the old GitHub repo", () => {
    const hits = published.filter((url) => readFileSync(url, "utf8").includes(OLD_REPO)).map(rel);
    expect(hits, `still point at ${OLD_REPO}`).toEqual([]);
  });

  it("points every public GitHub source link at blowhorn-ai/tells", () => {
    const drifted = [];
    for (const url of published) {
      const text = readFileSync(url, "utf8");
      const links = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/blowhorn-tells\b[^"'\s)]*/g) ?? [];
      for (const link of links) {
        if (!link.startsWith(SOURCE)) drifted.push(`${rel(url)}: ${link}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it("keeps a README source URL on blowhorn-ai/tells when the README names one", () => {
    const text = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const links = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? [];
    const sourceLinks = links.filter((link) => /blowhorn-tells|\/tells\b/.test(link));
    for (const link of sourceLinks) expect(link.startsWith(SOURCE), link).toBe(true);
  });
});
