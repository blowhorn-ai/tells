import { HttpError, json, JSON_HEADERS, readJsonBody, reportCorsHeaders } from "./http.js";
import { API_RATE_LIMIT_RETRY_AFTER_SECONDS, checkApiRateLimit } from "./rate-limit.js";
import { collectServer, collectServerBasics } from "./server-signals.js";
import {
  collectionOptedOut,
  forgetReport,
  persistReport,
  RUN_HEADER
} from "./report-catalog.js";
import { BUDGET } from "./report-budget.js";
import { collectionStats, compactReports, pruneReports } from "./report-store.js";
import {
  deriveBehavior,
  deriveFingerprintStability,
  deriveInteraction,
  detectionMatrix,
  enrichClientConsistency,
  scoreReport,
  withDerivedBehavior,
  withDerivedFingerprintStability,
  withValidInteraction
} from "./report-verdict.js";

// Integer 1 matches schemas/v1/. Bump it only when the report or check schema breaks.
export const SCHEMA_VERSION = 1;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: url.pathname === "/api/report" ? reportCorsHeaders(request) : JSON_HEADERS
      });
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        const rateLimit = await checkApiRateLimit(request, env);
        if (!rateLimit.allowed) {
          return json(rateLimit.responseBody, 429, {
            "Retry-After": String(API_RATE_LIMIT_RETRY_AFTER_SECONDS)
          });
        }
      }

      if (url.pathname === "/api/ping") {
        const server = collectServerBasics(request, env);
        return json({ ok: true, now: Date.now(), iso: new Date().toISOString(), server });
      }

      if (url.pathname === "/api/check") {
        const server = await collectServer(request, env);
        const verdict = scoreReport({ server, client: null });
        return json({ schema_version: SCHEMA_VERSION, ok: true, receivedAt: new Date().toISOString(), verdict, server });
      }

      if (url.pathname === "/api/report" && request.method === "POST") {
        const rawClient = await readJsonBody(request, 192 * 1024);
        const server = await collectServer(request, env);
        const scored = enrichClientConsistency(rawClient, server);
        const interaction = deriveInteraction(scored?.interaction);
        const interactionCompleted = interaction?.task?.completed === true;
        const behavior = deriveBehavior(scored?.behavior, interactionCompleted);
        const stability = deriveFingerprintStability(scored?.fingerprints?.stability);
        const verdict = scoreReport({ server, client: scored }, interaction, behavior, stability);
        const client = withDerivedFingerprintStability(
          withDerivedBehavior(withValidInteraction(scored, interaction), interactionCompleted),
          stability
        );
        const detections = detectionMatrix(server, client);
        const body = {
          schema_version: SCHEMA_VERSION,
          ok: true,
          receivedAt: new Date().toISOString(),
          verdict,
          server,
          client,
          detections
        };
        // Collection is on until the visitor sets the opt-out. A run that opted out is not collected or kept.
        if (!collectionOptedOut(request) && JSON.stringify(rawClient).length <= BUDGET.maxReportBytes) {
          const stored = persistReport(env, body, request.headers.get(RUN_HEADER));
          if (typeof ctx?.waitUntil === "function") ctx.waitUntil(stored);
        }
        return json(body, 200, {}, reportCorsHeaders(request));
      }

      // The collected total, always visible on the page. Cached for five minutes; the figure is a sum over one ledger row per day, so a miss is cheap.
      if (url.pathname === "/api/stats" && request.method === "GET") {
        const cache = typeof caches !== "undefined" ? caches.default : null;
        const cacheKey = new Request(`${url.origin}/api/stats`);
        const cached = cache ? await cache.match(cacheKey) : null;
        if (cached) return cached;
        const response = json(await collectionStats(env), 200, { "Cache-Control": "public, max-age=300" });
        if (cache) ctx?.waitUntil?.(cache.put(cacheKey, response.clone()));
        return response;
      }

      // The visitor turned collection off after the page had posted: remove this run's record.
      if (url.pathname === "/api/report/forget" && request.method === "POST") {
        const forgotten = await readJsonBody(request, 1024);
        await forgetReport(env, forgotten?.run_id);
        return json({ ok: true }, 200, {}, reportCorsHeaders(request));
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: "Unknown API route" }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const headers = url.pathname === "/api/report" ? reportCorsHeaders(request) : JSON_HEADERS;
      return json({ ok: false, error: String(error?.message || error) }, status, {}, headers);
    }
  },

  // Hourly: aggregate waiting rows and write the hour's R2 object. At 03:xx UTC also prune past retention.
  async scheduled(controller, env, ctx) {
    const when = new Date(controller?.scheduledTime ?? Date.now());
    const work = (async () => {
      await compactReports(env, when);
      if (when.getUTCHours() === 3) await pruneReports(env, when);
    })();
    if (typeof ctx?.waitUntil === "function") ctx.waitUntil(work);
    await work;
  }
};
