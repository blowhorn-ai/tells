// Shared by the page and the Worker. The Worker re-derives each class so the page cannot pick its own.

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

// Per-read noise also differs between contexts, so it is checked first. Steady reads with an
// altered control are session-seeded noise, like Brave's farbling.
export function classifyStability({ distinct, workerMatch, iframeMatch, controlAltered }) {
  if (distinct === 0) return "blocked";
  if (distinct > 1) return "randomized_per_read";
  if (workerMatch === false || iframeMatch === false) return "context_inconsistent";
  if (controlAltered === true) return "randomized_session";
  return "stable";
}
