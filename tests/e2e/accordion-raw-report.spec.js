import { expect, test } from "@playwright/test";
import { stubSharedCards } from "./support/cards.js";

const PLUS = "+";
const MINUS = "\u2212";
const GROUPS = [
  ["#checks-fingerprint", "Fingerprint consistency"],
  ["#checks-behavior", "Behavior"],
  ["#checks-automation", "Automation flags"]
];

test.beforeEach(async ({ page }) => stubSharedCards(page));

test.describe("disclosure indicators", () => {
  test("switches + to − and back for check groups and Server / IP", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#checks-fingerprint .check-item").first()).toBeAttached({ timeout: 20_000 });

    for (const [group, title] of GROUPS) {
      await expect(page.locator(`${group} h3`)).toHaveText(title);
      const summary = page.locator(`${group} .check-item summary`).first();
      await expect(summary).toBeVisible();
      expect(await glyph(summary, "::after")).toBe(PLUS);
      await summary.click();
      expect(await glyph(summary, "::after")).toBe(MINUS);
      await summary.click();
      expect(await glyph(summary, "::after")).toBe(PLUS);
    }

    const server = page.locator("#panel-server-ip");
    const serverIcon = server.locator(":scope > summary .summary-icon");
    await expect(server).toHaveJSProperty("open", true);
    expect(await glyph(serverIcon, "::before")).toBe(MINUS);
    await server.locator(":scope > summary").click();
    await expect(server).toHaveJSProperty("open", false);
    expect(await glyph(serverIcon, "::before")).toBe(PLUS);
    await server.locator(":scope > summary").click();
    await expect(server).toHaveJSProperty("open", true);
    expect(await glyph(serverIcon, "::before")).toBe(MINUS);
  });
});

test.describe("raw report icon actions", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("stay disabled until a report exists, then copy and download the full JSON", async ({ page }) => {
    let releaseReport;
    const reportGate = new Promise((resolve) => {
      releaseReport = resolve;
    });
    await page.route("**/api/report", async (route) => {
      await reportGate;
      await route.continue();
    });

    await page.goto("/");
    const copyRaw = page.locator("#copyRawBtn");
    const downloadRaw = page.locator("#downloadRawBtn");
    await expect(copyRaw).toBeDisabled();
    await expect(downloadRaw).toBeDisabled();
    await expect(page.locator("#copyBtn")).toBeDisabled();
    await expect(page.locator("#downloadBtn")).toBeDisabled();

    releaseReport();
    await expect(copyRaw).toBeEnabled({ timeout: 20_000 });
    await expect(downloadRaw).toBeEnabled();
    await expect(page.locator("#copyBtn")).toBeEnabled();
    await expect(page.locator("#downloadBtn")).toBeEnabled();

    await expect(copyRaw).toHaveAttribute("aria-label", "Copy raw report JSON");
    await expect(copyRaw).toHaveAttribute("title", "Copy raw report JSON");
    await expect(downloadRaw).toHaveAttribute("aria-label", "Download raw report JSON");
    await expect(downloadRaw).toHaveAttribute("title", "Download raw report JSON");
    await expect(copyRaw.locator("svg")).toHaveCount(1);
    await expect(downloadRaw.locator("svg")).toHaveCount(1);

    const rawPanel = page.locator("#panel-raw");
    const openBefore = await rawPanel.evaluate((el) => el.open);
    await copyRaw.focus();
    await expect(copyRaw).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#status")).toHaveText("Report copied as JSON.");
    const shown = await page.locator("#jsonOut").textContent();
    expect(JSON.parse(shown).verdict).toBeTruthy();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
    expect(await rawPanel.evaluate((el) => el.open)).toBe(openBefore);

    const [rawDownload] = await Promise.all([
      page.waitForEvent("download"),
      downloadRaw.click()
    ]);
    expect(rawDownload.suggestedFilename()).toMatch(/^blowhorn-tells-report-.+\.json$/);
    expect(await readDownload(rawDownload)).toBe(shown);
    expect(await rawPanel.evaluate((el) => el.open)).toBe(openBefore);

    const [topDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#downloadBtn").click()
    ]);
    expect(topDownload.suggestedFilename()).toMatch(/^blowhorn-tells-report-.+\.json$/);
    expect(await readDownload(topDownload)).toBe(shown);

    await page.locator("#copyBtn").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  });

  test("icon actions fit a 375px viewport without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    await expect(page.locator("#copyRawBtn")).toBeEnabled({ timeout: 20_000 });
    const raw = page.locator("#panel-raw");
    await raw.scrollIntoViewIfNeeded();

    const layout = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const panel = document.querySelector("#panel-raw");
      const nodes = [panel, ...panel.querySelectorAll("*")];
      return {
        viewport,
        outside: nodes
          .filter((node) => node.getClientRects().length)
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return box.right > viewport + 0.5 || box.left < -0.5;
          })
          .map((node) => node.id || node.getAttribute("aria-label") || node.tagName)
      };
    });

    expect(layout.viewport).toBe(375);
    expect(layout.outside).toEqual([]);
    const copyBox = await page.locator("#copyRawBtn").boundingBox();
    const downloadBox = await page.locator("#downloadRawBtn").boundingBox();
    expect(copyBox.width).toBeGreaterThan(0);
    expect(downloadBox.x).toBeGreaterThan(copyBox.x);
    expect(downloadBox.x + downloadBox.width).toBeLessThanOrEqual(375);
  });
});

async function glyph(locator, pseudo) {
  const value = await locator.evaluate((el, pseudoEl) => getComputedStyle(el, pseudoEl).content, pseudo);
  return value.replace(/^["']|["']$/g, "");
}

async function readDownload(download) {
  const path = await download.path();
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
