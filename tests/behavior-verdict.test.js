import { describe, expect, it } from "vitest";
import { buildCheckRows } from "../public/checks-view-model.js";
import { buildInteractionReport } from "../public/collect-interaction.js";
import { scoreReport, withDerivedBehavior } from "../src/report-verdict.js";
import worker from "../src/worker.js";
import { humanLike } from "./fixtures/interaction-events.js";
import { createWorkerEnv } from "./worker-env.js";

const server = { userAgent: "Mozilla/5.0" };

// Idle for 5s: base 0.12, time bonuses, then the empty-log rule sets the score to 0.03.
const idleBehavior = {
  score: 1,
  summary: {
    elapsedMs: 5000,
    eventCounts: {},
    pointerMoveSamples: 0,
    pointerDistance: 0,
    pointerSpeedStdDev: 0,
    rafStdDev: 0
  },
  recentEvents: []
};

// One click, one key and one scroll over 5s, no pointer travel.
// 0.12 + 0.08 + 0.08 + 0.10 + 0.08 + 0.08 = 0.54, which is a pass. The claimed score is a bot.
const activeBehavior = {
  score: 0.01,
  summary: {
    elapsedMs: 5000,
    eventCounts: { click: 1, keydown: 1, scroll: 1 },
    pointerMoveSamples: 0,
    pointerDistance: 0,
    pointerSpeedStdDev: 0,
    rafStdDev: 0
  },
  recentEvents: [
    { type: "click", t: 560 },
    { type: "keydown", t: 620 },
    { type: "scroll", t: 740 }
  ]
};

const behaviorReason = (verdict) => verdict.reasons.find((reason) => reason.id.startsWith("behavior_"));

describe("server-derived behaviour score", () => {
  it("scores the raw evidence when the claimed score disagrees with it", () => {
    const forgedHigh = scoreReport({ server, client: { behavior: idleBehavior } });
    const forgedLow = scoreReport({ server, client: { behavior: activeBehavior } });

    expect(behaviorReason(forgedHigh)).toMatchObject({
      id: "behavior_score_low",
      severity: "high",
      points: 25,
      data: { elapsedMs: 5000, pointerDistance: 0 }
    });
    expect(forgedHigh.score).toBe(75);
    expect(behaviorReason(forgedLow)).toBeUndefined();
    expect(forgedLow.score).toBe(100);
    expect(withDerivedBehavior({ behavior: idleBehavior }).behavior.score).toBe(0.03);
    expect(withDerivedBehavior({ behavior: idleBehavior }).behavior.claimedScore).toBe(1);
    expect(withDerivedBehavior({ behavior: activeBehavior }).behavior.score).toBe(0.54);
    expect(withDerivedBehavior({ behavior: activeBehavior }).behavior.claimedScore).toBe(0.01);
  });

  it("does not treat missing or inconsistent behaviour evidence as a pass", () => {
    const missing = scoreReport({ server, client: { behavior: { score: 1 } } });
    const inconsistent = scoreReport({
      server,
      client: {
        behavior: {
          score: 1,
          summary: {
            elapsedMs: 5000,
            eventCounts: { pointermove: 1 },
            pointerMoveSamples: 5,
            pointerDistance: 400,
            pointerSpeedStdDev: 0.5,
            rafStdDev: 1
          },
          recentEvents: [{ type: "pointermove", t: 10, x: 0, y: 0 }]
        }
      }
    });
    const absent = scoreReport({ server, client: {} });

    for (const verdict of [missing, inconsistent, absent]) {
      expect(behaviorReason(verdict)).toMatchObject({
        id: "behavior_evidence_invalid",
        severity: "high",
        points: 25
      });
      expect(verdict.score).toBe(75);
      expect(verdict.reasons.map((reason) => reason.id)).not.toContain("behavior_score_low");
      expect(verdict.reasons.map((reason) => reason.id)).not.toContain("behavior_score_borderline");
    }

    const shown = withDerivedBehavior({ behavior: { score: 1 } });
    const row = buildCheckRows({ server, client: shown, verdict: missing }).find((item) => item.name === "Behavioural classification");
    expect(shown.behavior).toBeUndefined();
    expect(row.status).not.toBe("pass");
    expect(row.status).toBe("fail");
  });

  it("leaves a server-only check without a behaviour penalty", () => {
    const verdict = scoreReport({ server, client: null });
    expect(verdict.reasons.map((reason) => reason.id)).not.toContain("behavior_evidence_invalid");
    expect(verdict.score).toBe(100);
  });

  it("scores summary totals when the event log is longer than the posted tail", () => {
    // 31 pointer samples: the page posts the last 30, all sitting on one point. The dropped
    // sample is what the summary's distance refers to, so the tail distance is not the total.
    const moves = Array.from({ length: 31 }, (_, index) => ({
      type: "pointermove",
      t: 100 + index * 50,
      x: index === 0 ? 0 : 10,
      y: 0
    }));
    const behavior = {
      score: 0.01,
      summary: {
        elapsedMs: 5000,
        eventCounts: { pointermove: 31 },
        pointerMoveSamples: 31,
        pointerDistance: 500,
        pointerSpeedStdDev: 0.5,
        rafStdDev: 0
      },
      recentEvents: moves.slice(1)
    };

    const verdict = scoreReport({ server, client: { behavior } });

    expect(behaviorReason(verdict)).toBeUndefined();
    expect(verdict.score).toBe(100);
    expect(withDerivedBehavior({ behavior }).behavior.score).toBe(0.71);
    expect(withDerivedBehavior({ behavior }).behavior.claimedScore).toBe(0.01);
  });

  it("adds the interaction-test bonus from the validated report, not from the claimed score", () => {
    const { events, task } = humanLike();
    const interaction = buildInteractionReport(events, task);
    const keyOnly = {
      score: 1,
      summary: {
        elapsedMs: 5000,
        eventCounts: { keydown: 1 },
        pointerMoveSamples: 0,
        pointerDistance: 0,
        pointerSpeedStdDev: 0,
        rafStdDev: 0
      },
      recentEvents: [{ type: "keydown", t: 620 }]
    };
    const keyWithout = scoreReport({ server, client: { behavior: keyOnly } });
    const keyWith = scoreReport({ server, client: { behavior: keyOnly, interaction } });

    expect(behaviorReason(keyWithout)).toMatchObject({ id: "behavior_score_borderline", points: 12 });
    expect(keyWithout.score).toBe(88);
    expect(behaviorReason(keyWith)).toBeUndefined();
    expect(keyWith.score).toBe(100);
    expect(withDerivedBehavior({ behavior: keyOnly, interaction }).behavior.score).toBe(0.52);
  });

  it("returns the derived score from POST /api/report and keeps the claimed score as a cross-check", async () => {
    const response = await worker.fetch(new Request("https://amiabot.example/api/report", {
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-language": "en",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0"
      },
      body: JSON.stringify({ behavior: idleBehavior })
    }), createWorkerEnv(), {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.client.behavior.score).toBe(0.03);
    expect(body.client.behavior.claimedScore).toBe(1);
    expect(body.verdict.reasons.map((reason) => reason.id)).toContain("behavior_score_low");
  });
});
