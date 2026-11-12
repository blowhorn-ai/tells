import { describe, expect, it, vi } from "vitest";
import { buildReportDownload, copyReport, reportJson } from "../public/controls.js";

const report = { verdict: { score: 80 }, client: { browser: { webdriver: false } }, server: { ip: "203.0.113.7" } };
const json = JSON.stringify(report, null, 2);

describe("report export", () => {
  it("serializes the complete report as pretty JSON", () => {
    expect(reportJson(report)).toBe(json);
  });

  it("builds the same download name and body the Download JSON button uses", () => {
    const file = buildReportDownload(report, new Date("2026-11-12T02:05:06.007Z"));
    expect(file).toEqual({
      filename: "blowhorn-tells-report-2026-11-12T02-05-06-007Z.json",
      body: json,
      type: "application/json"
    });
  });

  it("does not build a download when there is no report", () => {
    expect(buildReportDownload(null)).toBeNull();
    expect(buildReportDownload(undefined)).toBeNull();
  });

  it("copies the complete JSON and announces success", async () => {
    const writeText = vi.fn(async () => {});
    const setStatus = vi.fn();
    await copyReport(report, { writeText, setStatus });
    expect(writeText).toHaveBeenCalledWith(json);
    expect(setStatus).toHaveBeenCalledWith("Report copied as JSON.");
  });

  it("announces copy failure and does not throw", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    const setStatus = vi.fn();
    await expect(copyReport(report, { writeText, setStatus })).resolves.toBeUndefined();
    expect(setStatus).toHaveBeenCalledWith("Could not copy the report.");
  });

  it("does nothing when there is no report to copy", async () => {
    const writeText = vi.fn();
    const setStatus = vi.fn();
    await copyReport(null, { writeText, setStatus });
    expect(writeText).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
