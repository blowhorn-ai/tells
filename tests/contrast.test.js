import { describe, expect, it } from "vitest";
import { contrastTable, GRAPHIC, TEXT } from "../scripts/contrast.mjs";

// Checks the colour tokens in public/styles.css against WCAG 2.1 AA, in both colour schemes and
// inside the dispatch card. The ratios and surfaces come from scripts/contrast.mjs, which
// `pnpm contrast` prints as a table. How the rendered page uses them (warn text in --warn-ink, plain
// check rows, the dispatch card, the status link) is checked in tests/e2e/checks-layout.spec.js.

describe("token contrast", () => {
  it("keeps text at 4.5:1 or better on every surface", () => {
    for (const row of contrastTable(TEXT)) {
      expect(row.ratio, `${row.scheme}: ${row.token} ${row.fg} on ${row.surface} ${row.bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps status icons and borders at 3:1 or better on every surface", () => {
    for (const row of contrastTable(GRAPHIC)) {
      expect(row.ratio, `${row.scheme}: ${row.token} ${row.fg} on ${row.surface} ${row.bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});
