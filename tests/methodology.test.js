import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../scripts/generate-check-pages.mjs";
import { SCHEMA_VERSION } from "../src/worker.js";
import { docPagePaths, stripePages } from "./e2e/support/doc-pages.js";

const pageUrl = new URL("../public/methodology/index.html", import.meta.url);
const SOURCE = "https://github.com/blowhorn-ai/tells";
const VARIANTS = ["card-paper", "card-dispatch", "card-stamp", "card-field", "card-plain"];

function read(url) {
  return readFileSync(url, "utf8");
}

function pageHtml(route) {
  const relative = route === "/" ? "index.html" : `${route.slice(1)}index.html`;
  return read(new URL(`../public/${relative}`, import.meta.url));
}

describe("methodology page", () => {
  const html = () => read(pageUrl);

  it("is published at /methodology/", () => {
    expect(existsSync(pageUrl), "public/methodology/index.html").toBe(true);
    expect(docPagePaths()).toContain("/methodology/");
  });

  it("states the score, the verdict, and that scoring happens on the server", () => {
    const page = html();
    expect(page).toContain("The score runs from 0 to 100.");
    expect(page).toContain("pass, warn, or fail");
    expect(page).toContain("Pass");
    expect(page).toContain("Warning");
    expect(page).toContain("Fail");
    expect(page).toContain("<h2>Scoring happens on the server</h2>");
    expect(page).toContain("Scoring happens on the server.");
  });

  it("states schema_version, catalog_version, and comparability", () => {
    const page = html();
    const catalog = loadCatalog();
    expect(page).toContain(
      "<code>schema_version</code> is on the success body of <code>GET /api/check</code> and"
    );
    expect(page).toContain("<code>POST /api/report</code>");
    expect(page).toContain(`<code>schema_version</code> is ${SCHEMA_VERSION}.`);
    expect(page).toContain("<code>catalog_version</code>");
    expect(page).toContain(`<code>catalog_version</code> is ${catalog.catalog_version}.`);
    expect(page).toContain('href="/checks/changelog/"');
    expect(page).toContain(
      "Scores are only comparable across the same <code>schema_version</code>, and across"
    );
    expect(page).toContain("the same catalog when you cite a check.");
    expect(page).not.toContain("catalog_version</code> is a field on");
    expect(page).toContain("<code>catalog_version</code> is not a field on");
  });

  it("links the schema, the catalog, the changelog, and /compare/ instead of copying them", () => {
    const page = html();
    for (const path of [
      "/blob/master/schemas/report.schema.json",
      "/blob/master/schemas/check.schema.json",
      "/blob/master/schemas/check-catalog.json"
    ]) {
      expect(page).toContain(`${SOURCE}${path}`);
    }
    expect(page).toContain('href="/checks/changelog/"');
    expect(page).toContain('href="/compare/"');
    expect(page).toContain('href="/checks/"');
    expect(page).not.toMatch(/border-left:\s*[2-9]/);
  });

  it("uses the shared card stylesheet and the Blowhorn lockup", () => {
    const page = html();
    expect(page).toContain("https://blowhorn.ai/assets/brand/cards.css");
    expect(existsSync(new URL("../public/assets/brand/cards.css", import.meta.url))).toBe(false);
    expect(page).toContain("blowhorn-lockup-horizontal.svg");
    expect(page).toContain("blowhorn-lockup-horizontal-on-dark.svg");
    expect(page).not.toContain("layer5-blowhorn-lockup");
    expect(page).toContain("Your voice, at full volume.");
    expect(page).toContain(SOURCE);
    expect(page).not.toContain("layer5io/blowhorn-tells");

    const main = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
    const variants = [...main.matchAll(/class="[^"]*\b(card-[a-z]+)\b/g)].map((match) => match[1]);
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.length).toBeLessThanOrEqual(VARIANTS.length);
    expect(new Set(variants).size, variants.join(", ")).toBe(variants.length);
    expect(variants.every((variant) => VARIANTS.includes(variant))).toBe(true);
    expect(variants.at(-1)).not.toBe("card-plain");
  });

  it("is on the card, stripe, and footer walks", () => {
    expect(stripePages()).toContain("/methodology/");
    expect(docPagePaths()).toContain("/methodology/");
    const stripes = read(new URL("./e2e/no-edge-stripes.spec.js", import.meta.url));
    const neighbours = read(new URL("./e2e/card-neighbours.spec.js", import.meta.url));
    expect(stripes).toContain("stripePages()");
    expect(neighbours).toContain("docPagePaths()");
    expect(neighbours).toContain('"/methodology/"');

    for (const route of docPagePaths()) {
      const page = pageHtml(route);
      expect(page, route).toContain("Your voice, at full volume.");
      expect(page, route).toContain("blowhorn-lockup-horizontal.svg");
      expect(page, route).not.toContain("layer5-blowhorn-lockup");
      expect(page, route).toContain("https://blowhorn.ai/assets/brand/cards.css");
    }
  });

  it("is linked from the README, llms.txt, and the agents page", () => {
    const readme = read(new URL("../README.md", import.meta.url));
    const llms = read(new URL("../public/llms.txt", import.meta.url));
    const agents = read(new URL("../public/agents/index.html", import.meta.url));
    expect(readme).toContain("https://tells.blowhorn.ai/methodology/");
    expect(readme).toContain("Scores are only comparable across the same `schema_version`");
    expect(llms).toContain("https://tells.blowhorn.ai/methodology/");
    expect(llms).toContain("Scores are only comparable across the");
    expect(agents).toContain('href="/methodology/"');
  });
});
