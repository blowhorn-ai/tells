import { standardDeviation } from "./utils.js";

// The page posts at most this many events. computeBehavior in public/runtime.js uses the same cap.
export const BEHAVIOR_RECENT_EVENT_LIMIT = 30;

// Score from the summary the page posts, not from the raw samples. The page rounds those
// figures before they are sent, and the thresholds below read the rounded figures, so the
// Worker and the page cannot disagree about a sub-pixel or a fraction of a millisecond.
export function scoreBehavior({
  elapsedMs,
  eventCounts = {},
  pointerMoveSamples = 0,
  pointerDistance = 0,
  pointerSpeedStdDev = 0,
  rafStdDev = 0,
  interactionCompleted = false
}) {
  let score = 0.12;
  if (elapsedMs > 1200) score += 0.08;
  if (elapsedMs > 4000) score += 0.08;
  if (pointerMoveSamples >= 5) score += 0.17;
  if (pointerDistance > 120) score += 0.16;
  if (pointerSpeedStdDev > 0.02) score += 0.10;
  if ((eventCounts.click || 0) > 0 || (eventCounts.pointerdown || 0) > 0) score += 0.10;
  if ((eventCounts.keydown || 0) > 0) score += 0.08;
  if ((eventCounts.scroll || 0) > 0) score += 0.08;
  if (rafStdDev > 0.3) score += 0.05;
  if (interactionCompleted === true) score += 0.16;
  if (elapsedMs > 3500 && Object.keys(eventCounts).length === 0) score = 0.03;

  score = Math.max(0, Math.min(1, score));
  return Math.round(score * 1000) / 1000;
}

// Pointer distance and speed jitter for a list of events. Non-pointer events are ignored,
// so a full session log and the posted tail can both be passed in.
export function summarizePointerMoves(events) {
  const pointerMoves = [];
  for (const event of events) {
    if (event?.type === "pointermove") pointerMoves.push(event);
  }
  let pointerDistance = 0;
  const speeds = [];
  for (let i = 1; i < pointerMoves.length; i += 1) {
    const prev = pointerMoves[i - 1];
    const curr = pointerMoves[i];
    const distance = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    pointerDistance += distance;
    const dt = Math.max(1, curr.t - prev.t);
    speeds.push(distance / dt);
  }
  return {
    pointerMoveSamples: pointerMoves.length,
    pointerDistance: Math.round(pointerDistance),
    pointerSpeedStdDev: round4(standardDeviation(speeds))
  };
}

// Reads the evidence computeBehavior posts. A client score is not an input.
// ok: false when the evidence is missing, malformed, or disagrees with itself.
// When the posted tail is the whole log, pointer distance and speed jitter are recomputed
// from it. When the log was truncated, the summary totals are the evidence and the tail
// only has to fit inside them.
export function assessBehaviorEvidence(behavior, interactionCompleted = false) {
  if (behavior == null || typeof behavior !== "object" || Array.isArray(behavior)) {
    return { ok: false, problem: "missing" };
  }
  const summary = behavior.summary;
  const recentEvents = behavior.recentEvents;
  if (summary == null || typeof summary !== "object" || Array.isArray(summary) || !Array.isArray(recentEvents)) {
    return { ok: false, problem: "malformed" };
  }

  const { elapsedMs, eventCounts, pointerMoveSamples, pointerDistance, pointerSpeedStdDev, rafStdDev } = summary;
  if (!nonNegativeFinite(elapsedMs)
    || !Number.isInteger(pointerMoveSamples) || pointerMoveSamples < 0
    || !nonNegativeFinite(pointerDistance)
    || !nonNegativeFinite(pointerSpeedStdDev)
    || !nonNegativeFinite(rafStdDev)
    || eventCounts == null || typeof eventCounts !== "object" || Array.isArray(eventCounts)) {
    return { ok: false, problem: "malformed" };
  }

  let total = 0;
  for (const [type, count] of Object.entries(eventCounts)) {
    if (typeof type !== "string" || type.length === 0 || !Number.isInteger(count) || count < 1) {
      return { ok: false, problem: "malformed" };
    }
    total += count;
  }
  if ((eventCounts.pointermove || 0) !== pointerMoveSamples) return { ok: false, problem: "inconsistent" };

  const tailCounts = {};
  let maxT = 0;
  for (const event of recentEvents) {
    if (event == null || typeof event !== "object" || Array.isArray(event)) return { ok: false, problem: "malformed" };
    if (typeof event.type !== "string" || event.type.length === 0 || !nonNegativeFinite(event.t)) {
      return { ok: false, problem: "malformed" };
    }
    if (event.type === "pointermove" && (!finiteNumber(event.x) || !finiteNumber(event.y))) {
      return { ok: false, problem: "malformed" };
    }
    tailCounts[event.type] = (tailCounts[event.type] || 0) + 1;
    if (event.t > maxT) maxT = event.t;
  }

  if (recentEvents.length !== Math.min(BEHAVIOR_RECENT_EVENT_LIMIT, total)) return { ok: false, problem: "inconsistent" };
  if (maxT > elapsedMs) return { ok: false, problem: "inconsistent" };
  for (const [type, count] of Object.entries(tailCounts)) {
    if (count > (eventCounts[type] || 0)) return { ok: false, problem: "inconsistent" };
  }

  const pointer = summarizePointerMoves(recentEvents);
  if (total <= BEHAVIOR_RECENT_EVENT_LIMIT) {
    for (const [type, count] of Object.entries(eventCounts)) {
      if ((tailCounts[type] || 0) !== count) return { ok: false, problem: "inconsistent" };
    }
    if (pointer.pointerMoveSamples !== pointerMoveSamples) return { ok: false, problem: "inconsistent" };
    if (pointer.pointerDistance !== pointerDistance) return { ok: false, problem: "inconsistent" };
    if (pointer.pointerSpeedStdDev !== round4(pointerSpeedStdDev)) return { ok: false, problem: "inconsistent" };
  } else if (pointer.pointerDistance > pointerDistance) {
    return { ok: false, problem: "inconsistent" };
  }

  return {
    ok: true,
    score: scoreBehavior({
      elapsedMs,
      eventCounts,
      pointerMoveSamples,
      pointerDistance,
      pointerSpeedStdDev,
      rafStdDev,
      interactionCompleted
    })
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeFinite(value) {
  return finiteNumber(value) && value >= 0;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
