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
import { WINDOWS, shareCardSvg } from "./insights.js";
import { readInsightsPayload, refreshInsights } from "./insights-store.js";
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

      // The insights report. Reads one precomputed row (rebuilt by the scheduled job), cached for an hour.
      if (url.pathname === "/api/insights" && request.method === "GET") {
        const days = Number(url.searchParams.get("window") || 30);
        if (!WINDOWS.includes(days)) return json({ ok: false, error: `window must be one of ${WINDOWS.join(", ")}` }, 400);
        if (!env.REPORTS) return json({ enabled: false, empty: true, cards: [] });
        const cache = typeof caches !== "undefined" ? caches.default : null;
        const cacheKey = new Request(`${url.origin}/api/insights?window=${days}`);
        const cached = cache ? await cache.match(cacheKey) : null;
        if (cached) return cached;
        const stored = await readInsightsPayload(env, days);
        const headers = { "Cache-Control": `public, max-age=${stored ? 3600 : 300}` };
        const response = stored
          ? new Response(stored, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } })
          : json({ enabled: true, empty: true, cards: [], sample: 0, window_days: days }, 200, headers);
        if (cache) ctx?.waitUntil?.(cache.put(cacheKey, response.clone()));
        return response;
      }

      // A shareable image for one insight card, as SVG. Cache first, then the same stored payload: never a scan.
      const shareMatch = url.pathname.match(/^\/insights\/card\/([a-z]+)\.svg$/);
      if (shareMatch && request.method === "GET") {
        const days = Number(url.searchParams.get("window") || 30);
        if (!WINDOWS.includes(days) || !env.REPORTS) return new Response("Not found", { status: 404 });
        const cache = typeof caches !== "undefined" ? caches.default : null;
        const cacheKey = new Request(`${url.origin}/insights/card/${shareMatch[1]}.svg?window=${days}`);
        const cached = cache ? await cache.match(cacheKey) : null;
        if (cached) return cached;
        const stored = await readInsightsPayload(env, days);
        const card = stored ? JSON.parse(stored).cards?.find((c) => c.id === shareMatch[1]) : null;
        if (!card) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
        const response = new Response(shareCardSvg(card), { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
        if (cache) ctx?.waitUntil?.(cache.put(cacheKey, response.clone()));
        return response;
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
      const compacted = await compactReports(env, when);
      if (!compacted?.skipped && compacted?.mode !== "off") await refreshInsights(env, when);
      if (when.getUTCHours() === 3) await pruneReports(env, when);
    })();
    if (typeof ctx?.waitUntil === "function") ctx.waitUntil(work);
    await work;
  }
};
