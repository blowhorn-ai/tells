import { expect, test } from "@playwright/test";

const human = {
  schema_version: 1,
  verdict: { classification: "likely_human", score: 92, reasons: [] },
  server: { ip: "203.0.113.10", headers: { "user-agent": "Mozilla/5.0" } },
  client: {
    browser: { webdriver: false, historyLength: 4, userAgent: "Mozilla/5.0", languages: ["en"] },
    network: { webrtc: { supported: true, candidates: [{ address: "203.0.113.20", port: 9 }] } }
  }
};

const bot = {
  schema_version: 1,
  verdict: {
    classification: "likely_bot",
    score: 18,
    reasons: [{ id: "navigator_webdriver", severity: "high", message: "navigator.webdriver is true" }]
  },
  server: { ip: "192.0.2.10", headers: { "user-agent": "Mozilla/5.0" } },
  client: { browser: { webdriver: true, userAgent: "Mozilla/5.0", languages: ["en"] } }
};

test("compare view loads, rejects invalid input, and shows a verdict difference", async ({ page }) => {
  const apiCalls = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiCalls.push(request.url());
  });

  await page.goto("/compare/");
  await expect(page.getByRole("heading", { level: 1, name: "Compare two reports" })).toBeVisible();
  await expect(page.locator("#verdictDiff")).toContainText("Label, score and reasons");

  await page.locator("#textA").fill("{");
  await page.locator("#textB").fill(JSON.stringify({ nope: true }));
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.locator("#compareStatus")).toContainText("not valid JSON");
  await expect(page.locator("#compareStatus")).toContainText("not a Tells report");
  await expect(page.locator("#verdictDiff")).toContainText("No verdict");

  await page.locator("#textA").fill(JSON.stringify(human));
  await page.locator("#textB").fill(JSON.stringify(bot));
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.locator("#verdictDiff")).toContainText("Looks human");
  await expect(page.locator("#verdictDiff")).toContainText("Looks like a bot");
  await expect(page.locator("#verdictDiff")).toContainText("92");
  await expect(page.locator("#verdictDiff")).toContainText("18");
  await expect(page.locator("#verdictDiff")).toContainText("WebDriver detected");
  await expect(page.locator("#checkDiff")).toContainText("Browser data");
  await expect(page.locator("#compareStatus")).toContainText("Nothing was uploaded");

  const body = await page.locator("#main").innerText();
  expect(body).not.toContain("203.0.113.10");
  expect(body).not.toContain("203.0.113.20");
  expect(body).not.toContain("192.0.2.10");
  expect(apiCalls).toEqual([]);
});
