import { expect, test } from "@playwright/test";
import { stubSharedCards } from "./support/cards.js";

// Each test reads the server-derived classes and reasons from the first /api/report response.
test.beforeEach(async ({ page }) => stubSharedCards(page));

async function firstReport(page) {
  const response = page.waitForResponse((res) => res.request().method() === "POST" && res.url().endsWith("/api/report"));
  await page.goto("/");
  return (await response).json();
}

const reasonIds = (body) => body.verdict.reasons.map((reason) => reason.id);

// Nudges every canvas read like a spoofer. topOnly skips iframes, and init scripts never reach the worker.
function spoofCanvas({ topOnly, perRead }) {
  if (topOnly && window !== window.top) return;
  const original = CanvasRenderingContext2D.prototype.getImageData;
  let calls = 0;
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const image = original.apply(this, args);
    calls += 1;
    image.data[0] = (image.data[0] + (perRead ? calls : 1)) % 256;
    return image;
  };
}

test("an unprotected browser reads every surface steadily and scores nothing", async ({ page }) => {
  const body = await firstReport(page);
  const stability = body.client.fingerprints.stability;

  expect(stability.canvas).toMatchObject({ reads: 3, distinct: 1, workerMatch: true, iframeMatch: true, controlAltered: false, classification: "stable" });
  expect(stability.audio).toMatchObject({ iframeMatch: true, controlAltered: false, classification: "stable" });
  for (const surface of Object.keys(stability)) {
    expect(stability[surface].classification, surface).not.toBe("context_inconsistent");
  }
  expect(reasonIds(body)).not.toContain("fingerprint_context_inconsistent");
});

test("a canvas spoof in the visible page only is caught as context_inconsistent", async ({ page }) => {
  await page.addInitScript(spoofCanvas, { topOnly: true, perRead: false });
  const body = await firstReport(page);

  expect(body.client.fingerprints.stability.canvas).toMatchObject({ distinct: 1, iframeMatch: false, classification: "context_inconsistent" });
  expect(body.verdict.reasons.find((reason) => reason.id === "fingerprint_context_inconsistent")).toMatchObject({ severity: "medium", data: ["canvas"] });
});

test("canvas noise that changes on every read is randomized_per_read and costs nothing", async ({ page }) => {
  await page.addInitScript(spoofCanvas, { topOnly: false, perRead: true });
  const body = await firstReport(page);

  expect(body.client.fingerprints.stability.canvas.classification).toBe("randomized_per_read");
  expect(body.verdict.reasons.find((reason) => reason.id === "fingerprint_randomized")).toMatchObject({ points: 0 });
  expect(reasonIds(body)).not.toContain("fingerprint_context_inconsistent");
});

test("the same noise in every context is randomized_session", async ({ page }) => {
  // Without a worker, the page and the iframe both add the same noise.
  await page.addInitScript(() => { delete window.Worker; });
  await page.addInitScript(spoofCanvas, { topOnly: false, perRead: false });
  const body = await firstReport(page);

  expect(body.client.fingerprints.stability.canvas).toMatchObject({ distinct: 1, workerMatch: null, iframeMatch: true, controlAltered: true, classification: "randomized_session" });
  expect(reasonIds(body)).not.toContain("fingerprint_context_inconsistent");
});
