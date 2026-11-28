# Design plan: promote the Social Browser capture into the known-good corpus

Issue: blowhorn-ai/tells#82 — Capture Tells output in Social Browser.
Status: plan only. No fixture or manifest change is included in this PR; the
promotion itself is Phase 2 below, gated on the decision in §3. Q1 resolved
2026-11-26 (see §3); Q2 still needs Lee's decision.

## 1. Where things stand (verified)

The capture the issue asked for is done, by the external contributor, not by
this plan:

- Prayas-35 ran Social Browser 2026.11.5 on Windows 11 Home 24H2 (build
  26100.4770), fresh profile with defaults, no fingerprint tuning, no proxy,
  `https://tells.blowhorn.ai/` first and only (comment 2026-11-18T20:38:15Z).
- Interaction drill ran by hand. Initial inspection 51/100 (Suspicious);
  after the drill 71/100 (Suspicious).
- Attached to the issue: `social-browser-before-interaction-redacted.json`
  (51/100), `social-browser-after-interaction-redacted.json` (71/100), and
  `social-browser-verdict.png` (final verdict panel). Redactions already
  applied: public IPs, exact location (city, postal code, latitude,
  longitude), Cloudflare Ray ID, TLS client random.
- Kate Suttons acknowledged the capture the same evening (2026-11-18T20:59:46Z).
- Lee Calcote asked for this plan and a PR (2026-11-19T03:19:28Z).

The promotion tooling is ready, and the corpus is empty:

- `scripts/capture-fixture.mjs` redacts a Download JSON report into a fixture
  plus a manifest entry, validated against
  `schemas/fixture-manifest.schema.json` (v1). `tests/e2e/fixtures/captures/`
  currently holds only `manifest.json` with `"fixtures": []`.
- I ran the script on the final (after-drill) report. It produces fixture
  `social-browser-2026-11-5-windows-11.json` and a manifest entry (kind
  `human`, browser Social Browser 2026.11.5, OS Windows 11, no privacy
  settings, capturedOn 2026-11-19). The manifest validates, and
  `tests/capture-fixture.test.js` passes 18/18 with the fixture present
  (manifest schema, one file per entry, redaction is idempotent).

## 2. The blocker, verified by replay — not by reading the live score

The live capture scored 71/100 Suspicious, with two reasons:
`timezone_mismatch` (−14) and `fingerprint_context_inconsistent` (−15).
The promotion question is what the fixture scores when the gate replays it,
and that is different from the live score, so I replayed it: the redacted
fixture posted to `/api/report` through the same `scoreReport` path the
captured-corpus e2e gate uses.

Replayed verdict: **85 / likely_human / low**, with one reason —
`fingerprint_context_inconsistent` (−15, surfaces canvas, audio, voices).

That fails the gate. `tests/e2e/known-good-browsers.spec.js`
("captured known-good corpus") requires, for every `kind: human` fixture,
`verdict.classification === "likely_human"` **and** none of
`disallowedKnownGoodReasonIds` — and `fingerprint_context_inconsistent` is
in that list. The classification passes; the reason-id check does not. A
straight `kind: human` promotion ships a red gate.

Two details that matter for the decision:

- The timezone reason does **not** re-fire on replay. The redaction drops
  `client.consistency.timezoneMismatch` (server-side, needs the IP), and the
  replay has no IP geolocation. The #85 timezone-alias false positive
  (Asia/Calcutta vs Asia/Kolkata) is therefore not the promotion blocker.
- The fingerprint inconsistency survives redaction by design:
  `client.fingerprints.stability` is kept ("only counts and classes, and the
  corpus gate reads it"). The stability entries classify canvas, audio, and
  voices `context_inconsistent`, and `controlAltered` is true on canvas and
  audio — the control probe itself alters the values it compares.

## 3. Decision needed (Lee)

**Q1 — Is the cross-context inconsistency real browser behaviour, or a
measurement artifact?** The `controlAltered: true` readings on canvas and
audio suggest the control probe may be creating the mismatch it reports.
If the probe is at fault, the fix belongs in the stability derivation
(`deriveFingerprintStability` / the control probe), not in the fixture, and
the corrected derivation should re-score this capture to `likely_human`
with no disallowed reasons before any promotion.

**Q1 — Resolved 2026-11-26 (Prayas-35, PR #86 comment):** opt-in local
diagnostic run in regular Chrome and Social Browser on the same Windows
machine. Chrome returned the same unaltered value in the page, iframe,
main-thread OffscreenCanvas, and worker. Social Browser altered only the
top-level HTML canvas; its iframe and OffscreenCanvas readings exactly
matched Chrome. Audio: same pattern — top-level altered, iframe matched.
Voices: Chrome's iframe reached the full 24-voice list by 800 ms; Social
Browser exposed 22 voices in the page and only 5 in the iframe, mismatch
still present after 2 seconds. So the inconsistency is genuine Social
Browser behaviour, not an artifact caused by Tells' controls:
`controlAltered` is evidence of top-level modification, not the cause of
the cross-context mismatch. Tells is correctly detecting realm-specific
behaviour. Q1 resolves in favour of preserving the detection, leaving Q2
as the remaining fixture-classification decision. Diagnostic reports
attached to the PR comment (`chrome-diagnostic-1.json`,
`social-browser-diagnostic-1.json`).

**Q2 — If the inconsistency stands, what kind of fixture is this?** The
manifest schema only allows `human` (must stay `likely_human`) and
`automation` (must be caught). Social Browser is a real person's browser
that Tells scores Suspicious — that is the measured comparison data point
this issue exists to record. Options: (a) hold the promotion until Q1 is
resolved; (b) add a fixture kind for measured human captures that are not
asserted `likely_human` (schema change, plus a gate that pins the observed
verdict instead of asserting `likely_human`); (c) keep the capture on the
issue only, and do not promote it.

**Q3 — Scope of the promotion:** the final (after-drill) report only, or
the before/after pair as two fixtures? The issue's artifact is one raw
report plus notes; the before report is already preserved on the issue as
the pair record. Recommendation: final report only.

## 4. Proposed sequence

1. Q1 answered 2026-11-26 (see §3): the inconsistency is genuine Social
   Browser behaviour and the detection stands, so no derivation fix is
   needed. Next step is Q2: pick a fixture kind for this capture.
2. If Q2 resolves in favour of promotion, open the promotion PR: fixture
   file + manifest entry from `scripts/capture-fixture.mjs`, plus the
   screenshot staying on the issue (the corpus stores JSON only). The
   generated fixture and manifest entry are already verified locally and
   can be lifted straight into that PR.
3. If Q2 picks option (c), the capture stays on the issue only and is not
   promoted.
4. Either way, the measured 51 → 71 stands as the Social Browser
   comparison data point; nothing in this plan re-runs the capture or pays
   for anything.

## 5. Out of scope

- No re-run of the capture (Windows-only; already done by the contributor).
- No change to the report schema, the verdict UI, or the #85 timezone-alias
  fix, except what Q1 requires.
- No promotion of the before-interaction report unless Q3 says otherwise.
