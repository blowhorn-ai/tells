import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import { stubSharedCards } from "./support/cards.js";

// Brand rule: no card, panel, row, callout or quote draws a coloured stripe on one edge. The shared
// cards.css holds the rule for the variants; this holds Tells' own styles to it, as the browser
// computes them on every page. A stripe is an uneven border wider than 1px, a one-sided inset shadow
// wider than 1px, or a thin ::before/::after bar. 1px hairlines (row dividers, a header's bottom
// edge) are allowed.

const PAGES = ["/", "/checks/", "/agents/", ...readdirSync(new URL("../../public/checks/", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `/checks/${entry.name}/`)];

test.beforeEach(async ({ page }) => stubSharedCards(page));

function edgeStripes(root = document.body) {
  const TARGET = /card|panel|row|callout|quote|item/i;
  const SIDES = ["top", "right", "bottom", "left"];
  const px = (value) => Number.parseFloat(value) || 0;
  const visible = (color) => !/^(transparent|rgba\([^)]*,\s*0\))$/.test(color);
  const name = (el) => `${el.localName}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].join(".")}` : ""}`;
  const found = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (!el.getClientRects().length || !TARGET.test(`${el.localName} ${el.getAttribute("class") || ""}`)) continue;
    for (const pseudo of [null, "::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      if (pseudo && (style.content === "none" || style.content === "normal" || style.display === "none")) continue;
      const where = `${name(el)}${pseudo || ""}`;

      const widths = SIDES.map((side) => (visible(style.getPropertyValue(`border-${side}-color`)) ? px(style.getPropertyValue(`border-${side}-width`)) : 0));
      if (new Set(widths).size > 1) {
        SIDES.forEach((side, i) => { if (widths[i] > 1) found.push(`${where}: border-${side} ${widths[i]}px`); });
      }

      for (const shadow of style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/)) {
        if (!/\binset\b/.test(shadow) || !visible(shadow.match(/rgba?\([^)]*\)/)?.[0] || "")) continue;
        const [x = 0, y = 0, blur = 0] = [...shadow.matchAll(/(-?[\d.]+)px/g)].map((match) => Number(match[1]));
        if ((x === 0) !== (y === 0) && Math.max(Math.abs(x), Math.abs(y)) > 1 && blur === 0) found.push(`${where}: inset shadow ${shadow.trim()}`);
      }

      if (pseudo && style.position === "absolute" && (visible(style.backgroundColor) || style.backgroundImage !== "none")) {
        const [thin, long] = [px(style.width), px(style.height)].sort((a, b) => a - b);
        if (thin > 0 && thin <= 8 && long >= 3 * thin) found.push(`${where}: ${px(style.width)}×${px(style.height)}px bar`);
      }
    }
  }
  return found;
}

test("finds each kind of stripe in a sample", async ({ page }) => {
  await page.setContent(`
    <div class="card-note" style="border-left: 4px solid teal">note</div>
    <div class="panel-x" style="box-shadow: inset 3px 0 0 gold, 0 4px 12px rgba(0, 0, 0, 0.3)">panel</div>
    <style>.quote { position: relative; } .quote::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 3px; background: teal; }</style>
    <blockquote class="quote">quote</blockquote>
    <div class="check-item" style="border-bottom: 1px solid gray">row</div>
    <div class="card-frame" style="border: 2px solid gray">framed</div>
    <header class="site-header" style="box-shadow: inset 0 -1px 0 0 gray">header</header>
    <style>.challenge-toggle-icon::before { content: ""; display: inline-block; width: 6px; height: 6px; border-right: 2px solid teal; border-bottom: 2px solid teal; }</style>
    <div class="challenge-panel"><span class="challenge-toggle-icon"></span></div>
  `);
  const found = await page.evaluate(edgeStripes);
  expect(found).toHaveLength(3);
  expect(found.join("\n")).toMatch(/card-note: border-left 4px/);
  expect(found.join("\n")).toMatch(/panel-x: inset shadow/);
  expect(found.join("\n")).toMatch(/quote::before: 3×\d+px bar/);
});

for (const colorScheme of ["dark", "light"]) {
  for (const width of [375, 1280]) {
    test(`no page draws a one-edge stripe at ${width}px, ${colorScheme} theme`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      for (const path of PAGES) {
        await page.goto(path);
        if (path === "/") {
          await expect(page.locator("#verdictWord")).not.toHaveText("In progress", { timeout: 20_000 });
          await expect(page.locator("#checks .check-item").first()).toBeAttached();
        }
        await page.evaluate(() => document.querySelectorAll("details").forEach((node) => { node.open = true; }));
        expect(await page.evaluate(edgeStripes), path).toEqual([]);
      }
    });
  }
}
