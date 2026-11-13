// Fingerprint stability (#44): does each fingerprint surface read the same every time and in every
// context? Shared by the page, which measures it (public/collect-stability.js), and the Worker, which
// re-derives the classes from the counts so the page cannot choose its own result. Only counts,
// booleans and the class leave the page, never the values that were read.

export const STABILITY_SURFACES = Object.freeze(["canvas", "webgl", "audio", "fonts", "voices"]);

// Main-thread reads per surface. The iframe and the Web Worker read once each.
export const STABILITY_READS = 3;

export const STABILITY_CLASSES = Object.freeze([
  "stable",
  "randomized_session",
  "randomized_per_read",
  "blocked",
  "context_inconsistent"
]);

// The order matters. Values that change on every read will differ between contexts too, so
// per-read randomization comes before a context mismatch. Steady main-thread reads that disagree
// with the worker or iframe are the main-thread-only spoof. Steady reads everywhere with an altered
// control render (a solid-colour canvas, a constant audio buffer) are session-seeded noise, like
// Brave's farbling.
export function classifyStability({ distinct, workerMatch, iframeMatch, controlAltered }) {
  if (distinct === 0) return "blocked";
  if (distinct > 1) return "randomized_per_read";
  if (workerMatch === false || iframeMatch === false) return "context_inconsistent";
  if (controlAltered === true) return "randomized_session";
  return "stable";
}
