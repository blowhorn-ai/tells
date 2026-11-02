import { expect, test } from "@playwright/test";

const STATUS_LABELS = ["Pass", "Warning", "Fail", "Not available"];
const GROUP_TITLES = ["Automation flags", "Behavior", "Fingerprint consistency"];

for (const colorScheme of ["dark", "light"]) {
  for (const width of [320, 375, 390, 1280]) {
    test.describe(`checks list at ${width}px, ${colorScheme} theme`, () => {
      test.use({ viewport: { width, height: 800 }, colorScheme });

      test("shows a status icon, a plain summary and an observed value for every check without overflowing", async ({ page }) => {
        await page.goto("/");
        const items = page.locator("#checks .check-item");
        await expect(items.first()).toBeAttached({ timeout: 20_000 });
        expect(await items.count()).toBeGreaterThanOrEqual(12);

        const list = await page.locator("#checks").evaluate((section) => {
          const viewport = document.documentElement.clientWidth;
          return {
            pageOverflow: document.documentElement.scrollWidth - viewport,
            outside: [...section.querySelectorAll("*")].filter((node) => node.getBoundingClientRect().right > viewport + 0.5).length,
            labels: [...section.querySelectorAll(".check-item .check-icon")].map((icon) => icon.getAttribute("aria-label")),
            summaries: [...section.querySelectorAll(".check-item .check-summary")].map((node) => node.textContent.trim()),
            observed: [...section.querySelectorAll(".check-item .check-detail code")].map((node) => node.textContent.trim()),
            groups: [...section.querySelectorAll(".check-group h3")].map((node) => node.textContent.trim()),
            groupCardVariants: [...section.querySelectorAll(".check-group")].map((node) => node.className)
          };
        });

        expect(list.pageOverflow).toBeLessThanOrEqual(0);
        expect(list.outside).toBe(0);
        expect(list.labels.length).toBe(await items.count());
        for (const label of list.labels) expect(STATUS_LABELS).toContain(label);
        for (const summary of list.summaries) expect(summary.length).toBeGreaterThan(0);
        expect(list.groups).toEqual(GROUP_TITLES);
        expect(list.observed.join(" ")).toMatch(/webdriver: (true|false|absent)/);
        // Adjacent group cards never share a variant.
        const variants = list.groupCardVariants.map((className) => className.match(/card-[a-z]+/)?.[0]);
        for (let i = 1; i < variants.length; i++) expect(variants[i]).not.toBe(variants[i - 1]);
      });

      test("hero verdict lines link to their group and read as 'Group: sentence'", async ({ page }) => {
        await page.goto("/");
        const lines = page.locator("#verdictGroups .verdict-line");
        await expect(lines).toHaveCount(3, { timeout: 20_000 });
        const texts = await lines.evaluateAll((links) => links.map((link) => link.querySelector(".verdict-line-text").textContent.replace(/\s+/g, " ").trim()));
        GROUP_TITLES.forEach((title, i) => expect(texts[i].startsWith(`${title}: `), texts[i]).toBe(true));
        for (const href of await lines.evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
          await expect(page.locator(href)).toBeAttached();
        }
      });

      test("the verdict word and score are visible, with one Verdict label", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator("#verdictWord")).not.toHaveText("In progress", { timeout: 20_000 });
        await expect(page.locator("#verdictScore")).toHaveText(/^\d+$/);
        await expect(page.locator(".eyebrow:text-is('Verdict')")).toHaveCount(0);
        await expect(page.locator(".label:text-is('Verdict')")).toHaveCount(1);
        await expect(page.locator("#status")).not.toContainText("Risk:");
      });
    });
  }
}

test.describe("independent panel controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  const diagnosticPanels = [
    "#panel-top-signals",
    "#panel-runtime",
    "#panel-server-ip",
    "#panel-browser",
    "#panel-behaviour",
    "#panel-webrtc",
    "#panel-consistency",
    "#panel-network",
    "#panel-surfaces",
    "#panel-media",
    "#panel-memory",
    "#panel-sensors",
    "#panel-resources",
    "#panel-extensions",
    "#panel-voices"
  ];

  test("Interaction Test toggles independently", async ({ page }) => {
    const challenge = page.locator("#panel-challenge");

    // Capture the initial states of all diagnostic panels.
    const initialStates = await Promise.all(
      diagnosticPanels.map((selector) =>
        page.locator(selector).evaluate((panel) => panel.open)
      )
    );

    // Interaction Test starts collapsed.
    await expect(challenge).not.toHaveAttribute("open", "");

    // Open Interaction Test.
    await challenge.locator("summary").click();
    await expect(challenge).toHaveAttribute("open", "");

    // Diagnostic panels should retain their initial states.
    const statesAfterOpening = await Promise.all(
      diagnosticPanels.map((selector) =>
        page.locator(selector).evaluate((panel) => panel.open)
      )
    );

    expect(statesAfterOpening).toEqual(initialStates);

    // Close Interaction Test.
    await challenge.locator("summary").click();
    await expect(challenge).not.toHaveAttribute("open", "");

    // Diagnostic panels should still retain their initial states.
    const statesAfterClosing = await Promise.all(
      diagnosticPanels.map((selector) =>
        page.locator(selector).evaluate((panel) => panel.open)
      )
    );

    expect(statesAfterClosing).toEqual(initialStates);
  });

  test("Expand all and Collapse all affect only diagnostic panels", async ({ page }) => {
    const challenge = page.locator("#panel-challenge");

    // Open Interaction Test first.
    await challenge.locator("summary").click();
    await expect(challenge).toHaveAttribute("open", "");

    // Collapse all diagnostic panels.
    await page.locator("#collapseAllBtn").click();

    for (const selector of diagnosticPanels) {
      await expect(page.locator(selector)).not.toHaveAttribute("open", "");
    }

    // Interaction Test should remain open.
    await expect(challenge).toHaveAttribute("open", "");

    // Expand all diagnostic panels.
    await page.locator("#expandAllBtn").click();

    for (const selector of diagnosticPanels) {
      await expect(page.locator(selector)).toHaveAttribute("open", "");
    }

    // Interaction Test should still remain open.
    await expect(challenge).toHaveAttribute("open", "");
  });

  test("bulk buttons reflect diagnostic panel states", async ({ page }) => {
    const expandAll = page.locator("#expandAllBtn");
    const collapseAll = page.locator("#collapseAllBtn");

    // Initial state: some diagnostic panels are open and others are closed.
    await expect(expandAll).toBeEnabled();
    await expect(collapseAll).toBeEnabled();

    // Collapse all diagnostic panels.
    await collapseAll.click();

    await expect(collapseAll).toBeDisabled();
    await expect(expandAll).toBeEnabled();

    // Manually open one diagnostic panel.
    await page.locator("#panel-runtime summary").click();

    // Both buttons should now be enabled.
    await expect(expandAll).toBeEnabled();
    await expect(collapseAll).toBeEnabled();

    // Expand all diagnostic panels.
    await expandAll.click();

    await expect(expandAll).toBeDisabled();
    await expect(collapseAll).toBeEnabled();
  });
});
