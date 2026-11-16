import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECK_GROUPS } from "../public/checks-view-model.js";
import {
  GUIDE_GROUPS,
  generatedPages,
  loadCatalog,
  renderCheckPage,
  renderIndex
} from "../scripts/generate-check-pages.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalog = loadCatalog(root);

function pageAt(path) {
  return readFileSync(join(root, path), "utf8");
}

describe("generated check pages", () => {
  it("uses the same group order and labels as the checks list", () => {
    expect(GUIDE_GROUPS).toEqual(CHECK_GROUPS.map(({ key, label }) => ({ key, label })));
  });

  it("writes one page per catalog check and lists every check on the index", () => {
    const index = renderIndex(catalog);
    expect(pageAt("public/checks/index.html")).toBe(index);
    expect(index).toContain(catalog.catalog_version);
    expect(index).toContain("https://github.com/blowhorn-ai/tells");
    expect(index).not.toContain("layer5io/blowhorn-tells");
    expect(index).toContain("Your voice, at full volume.");
    expect(index).toContain("https://blowhorn.ai/assets/brand/cards.css");
    expect(index).toContain("blowhorn-lockup-horizontal.svg");
    expect(index).not.toContain("layer5-blowhorn-lockup");

    for (const check of catalog.checks) {
      const path = `public/checks/${check.slug}/index.html`;
      const html = pageAt(path);
      expect(html, check.id).toBe(renderCheckPage(catalog, check));
      expect(index).toContain(`href="${check.page}"`);
      expect(index).toContain(check.name);
      expect(html).toContain(check.name);
      expect(html).toContain(`Group: ${check.group}.`);
      expect(html).toContain(`Since ${check.since}.`);
      expect(html).toContain(`Catalog ${catalog.catalog_version}.`);
      for (const read of check.reads) expect(html, read).toContain(read);
      for (const rule of Object.values(check.rules)) {
        if (rule) expect(html, rule).toContain(rule);
      }
      if (check.note) expect(html).toContain(check.note);
      for (const reason of check.reasons) {
        expect(html).toContain(reason.id);
        expect(html).toContain(`since ${reason.since}`);
        if (reason.note) expect(html).toContain(reason.note);
        if (reason.outcomes) {
          for (const outcome of reason.outcomes) {
            expect(html).toContain(`${outcome.severity}, ${outcome.points} points`);
          }
        } else {
          expect(html).toContain(`${reason.severity}, ${reason.points} points`);
        }
        if (reason.affects_row === false) expect(html).toContain("does not change the check row");
        if (reason.provisional === true) expect(html).toContain("provisional");
      }
      expect(html).not.toContain("layer5io/blowhorn-tells");
    }
  });

  it("matches the files the generator would write", () => {
    for (const { path, html } of generatedPages(catalog)) {
      expect(pageAt(path), path).toBe(html);
    }
  });
});
