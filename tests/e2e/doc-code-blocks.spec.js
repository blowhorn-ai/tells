import { expect, test } from "@playwright/test";
import { docPagePaths } from "./support/doc-pages.js";
import { SHARED_CARDS_URL } from "./support/cards.js";

// Code blocks on doc pages read as one surface, and prose after a block does not touch it.
// The shared cards.css gives every code element inside a card an inline chip background through
// a zero-specificity :where rule. The stub below serves that rule, so the test proves the page's
// own pre code reset wins over it rather than passing because the stub is empty.
const SHARED_CODE_CHIP_RULE = `:where(.card, .card-paper, .card-dispatch, .card-stamp, .card-field, .card-plain) :where(code) {
  background: color-mix(in srgb, #ffffff 10%, transparent);
}`;

function codeBlockLayout() {
  return [...document.querySelectorAll("pre")].map((pre) => {
    const next = pre.nextElementSibling;
    const nextIsProse = next?.tagName === "P";
    return {
      text: pre.textContent.trim().split("\n")[0].slice(0, 40),
      codeBackgrounds: [...pre.querySelectorAll("code")].map((code) => getComputedStyle(code).backgroundColor),
      gapToProse: nextIsProse ? Math.round(next.getBoundingClientRect().top - pre.getBoundingClientRect().bottom) : null
    };
  });
}

for (const colorScheme of ["dark", "light"]) {
  test.describe(`doc page code blocks, ${colorScheme} theme`, () => {
    test.use({ viewport: { width: 375, height: 900 }, colorScheme });

    test.beforeEach(async ({ page }) => {
      await page.route(SHARED_CARDS_URL, (route) => route.fulfill({ status: 200, contentType: "text/css", body: SHARED_CODE_CHIP_RULE }));
    });

    test("have no per-line chip and leave a gap before the next paragraph", async ({ page }) => {
      let blocks = 0;
      for (const path of docPagePaths()) {
        await page.goto(path);
        const layout = await page.evaluate(codeBlockLayout);
        blocks += layout.length;
        for (const block of layout) {
          for (const background of block.codeBackgrounds) {
            expect(background, `${path} pre "${block.text}"`).toBe("rgba(0, 0, 0, 0)");
          }
          if (block.gapToProse !== null) {
            expect(block.gapToProse, `${path} gap after pre "${block.text}"`).toBeGreaterThanOrEqual(12);
          }
        }
      }
      // /agents/ alone has three code blocks; the walk must find them.
      expect(blocks).toBeGreaterThanOrEqual(3);
    });
  });
}
