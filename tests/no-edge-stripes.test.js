import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Brand rule: no card, panel, row, callout or quote draws a coloured stripe on one edge. The shared
// cards.css holds the rule for the variants; this holds Tells' own CSS to it. A stripe is a one-sided
// border wider than 1px, a one-sided inset shadow wider than 1px, or a ::before/::after bar. 1px
// hairlines (row dividers, a header's bottom edge) are allowed.

const TARGET = /card|panel|row|callout|quote|item/i;
const SIDE = "(?:left|right|top|bottom|inline-start|inline-end|block-start|block-end)";
const px = (value) => {
  const match = /(-?\d*\.?\d+)(px|rem|em)?/.exec(value);
  if (!match) return /thick|medium/.test(value) ? 4 : 0;
  return Math.abs(Number(match[1])) * (match[2] === "rem" || match[2] === "em" ? 16 : 1);
};

export function edgeStripes(css) {
  const found = [];
  for (const [, rawSelector, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rawSelector.trim();
    if (!TARGET.test(selector)) continue;
    for (const [, prop, value] of body.matchAll(new RegExp(`(border-${SIDE}(?:-width)?)\\s*:\\s*([^;]+)`, "g"))) {
      if (/^(0|none)\b/.test(value.trim()) || /transparent/.test(value)) continue;
      if (px(value) > 1) found.push(`${selector}: ${prop}: ${value.trim()}`);
    }
    for (const [, value] of body.matchAll(/box-shadow\s*:\s*([^;]+)/g)) {
      for (const [shadow, x, y, blur = "0"] of value.matchAll(/inset\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+([\d.]+)(?:px)?)?/g)) {
        const one = (Number(x) === 0) !== (Number(y) === 0);
        if (one && Math.max(Math.abs(Number(x)), Math.abs(Number(y))) > 1 && Number(blur) === 0) found.push(`${selector}: ${shadow}`);
      }
    }
    if (/::?(before|after)/.test(selector) && /position\s*:\s*absolute/.test(body) && /background(-color)?\s*:\s*(?!none|transparent)/.test(body)) {
      const width = /(?:^|[;\s])width\s*:\s*([^;]+)/.exec(body)?.[1];
      const height = /(?:^|[;\s])height\s*:\s*([^;]+)/.exec(body)?.[1];
      const thin = (width && px(width) <= 8 && !/%/.test(width)) || (height && px(height) <= 8 && !/%/.test(height));
      if (thin) found.push(`${selector}: pseudo-element bar`);
    }
  }
  return found;
}

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

describe("no one-edge accent stripes", () => {
  it("finds each kind of stripe in a sample", () => {
    expect(edgeStripes(`
      .card-note { border-left: 4px solid var(--teal); }
      .panel-x { box-shadow: inset 3px 0 0 var(--yellow), var(--glass-shadow); }
      .quote::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 3px; background: var(--teal); }
      .check-item { border-bottom: 1px solid var(--line); }
      .site-header { box-shadow: inset 0 -1px 0 0 var(--glass-edge); }
    `)).toHaveLength(3);
  });

  it("holds for every stylesheet under public/", () => {
    const files = cssFiles(fileURLToPath(new URL("../public/", import.meta.url)));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(edgeStripes(readFileSync(file, "utf8")), file).toEqual([]);
  });
});
