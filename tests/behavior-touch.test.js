import { describe as describeTouch, expect as expectTouch, it as itTouch } from "vitest";
import { assessBehaviorEvidence, scoreBehavior as scoreBehaviorTouch } from "../public/behavior-score.js";

describeTouch("touch sessions", () => {
  itTouch("earns the pointer credit from touch events, with no mouse path", () => {
    const mouse = scoreBehaviorTouch({ elapsedMs: 5000, eventCounts: { pointermove: 8, click: 1, scroll: 1 }, pointerMoveSamples: 8, pointerDistance: 300, pointerSpeedStdDev: 0.05 });
    const touch = scoreBehaviorTouch({ elapsedMs: 5000, eventCounts: { pointerdown: 4, pointerup: 4, scroll: 2 }, touchEvents: 8 });
    const touchless = scoreBehaviorTouch({ elapsedMs: 5000, eventCounts: { pointerdown: 4, pointerup: 4, scroll: 2 } });
    expectTouch(touch).toBeGreaterThan(touchless);
    expectTouch(touch).toBeGreaterThanOrEqual(0.5);
    expectTouch(mouse).toBeGreaterThanOrEqual(0.5);
  });
  itTouch("rejects a touch count larger than the events seen", () => {
    const behavior = { summary: { elapsedMs: 5000, eventCounts: { pointerdown: 1 }, pointerMoveSamples: 0, pointerDistance: 0, pointerSpeedStdDev: 0, rafStdDev: 0, touchEvents: 5 }, recentEvents: [{ type: "pointerdown", t: 100, pointerType: "touch" }] };
    expectTouch(assessBehaviorEvidence(behavior).ok).toBe(false);
  });
});
