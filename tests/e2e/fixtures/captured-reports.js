import { readFileSync } from "node:fs";

// Real reports redacted by scripts/capture-fixture.mjs and listed in captures/manifest.json.
const capturesDir = new URL("./captures/", import.meta.url);

export const capturedManifest = JSON.parse(readFileSync(new URL("manifest.json", capturesDir), "utf8"));

export const capturedReports = capturedManifest.fixtures.map((entry) => ({
  ...entry,
  ...JSON.parse(readFileSync(new URL(entry.file, capturesDir), "utf8")),
  name: captureName(entry)
}));

export const capturedHumanReports = capturedReports.filter((report) => report.kind === "human");
export const capturedAutomationReports = capturedReports.filter((report) => report.kind === "automation");

function captureName({ id, browser, os, privacySettings }) {
  const privacy = privacySettings.length ? `, ${privacySettings.join(", ")}` : "";
  return `${browser.name} ${browser.version} on ${os.name} ${os.version}${privacy} (${id})`;
}
