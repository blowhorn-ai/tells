# Blowhorn Tells

**Am I a Bot?** A free check of what websites can see about your browser: the bot-detection and fingerprinting signals a site can read, explained in plain words.

It runs at [tells.blowhorn.ai](https://tells.blowhorn.ai) as one Cloudflare Worker with static assets. Use it to test your own browser, or point your Playwright, Puppeteer, Selenium or extension script at it and read the JSON result.

## Harness read path

Read the finished report from the page. The Raw report panel, `pre#jsonOut` with `[data-tells-report="raw"]`, is the full `/api/report` response as JSON text. Parse that text. The interaction report is at `/client/interaction`, and its check statuses are the ones the server derived. It is complete when `/client/interaction/task/completed` is true. Before Submit, that element holds `No report yet.` or a report whose interaction is not completed.

## What it checks

**Server.** Request headers (sensitive values redacted), client IP and Cloudflare connection data (country, colo, ASN, protocol, RTT), proxy-style headers (`Forwarded`, `Via`, `X-Forwarded-*` and similar), a datacenter ASN heuristic, optional IP intelligence for proxy, VPN, Tor and datacenter addresses, and managed bot fields when enabled.

**Browser.** `navigator` facts and client hints, permissions, storage, screen and viewport, locale and timezone, automation globals and headless markers, prototype and getter checks, plugin consistency, canvas, WebGL, audio, font and CSS media fingerprints, WebGPU, `performance.memory`, Resource Timing, DRM, speech voices, Permissions Policy, sensors, media constraints, known extension probes, WebRTC candidates and browser-to-edge latency.

**Cross-context consistency.** The same facts read in the window, a Web Worker, a Service Worker and a same-origin iframe must agree, and the request headers must agree with what the browser reports.

**Fingerprint protection.** Canvas, WebGL, audio, fonts and voices are each read three times in the window and once in a same-origin iframe, and canvas and WebGL once more in a Web Worker. A solid-colour canvas and a constant audio signal act as controls. Each surface is classed as stable, randomized per session, randomized per read, blocked, or inconsistent between contexts, and only those counts and classes are sent. The Worker re-derives the class. A surface that reads differently in the window than in a worker or iframe scores `fingerprint_context_inconsistent`. Randomization is reported as `fingerprint_randomized` at 0 points, because privacy browsers randomize too.

**Behavior.** A transparent score from pointer, key, scroll, focus and frame timing. The Worker derives that score from the evidence the page posts and uses the derived score in the verdict. An optional interaction test (press Start, type one fixed phrase, press Submit; Enter or Space on either button also works) adds 15 checks of event order, click geometry, press length, key rhythm, focus and blur, and tab visibility, which stay warn-only until calibrated.

## API for scripts

Server-only quick check, useful from Node or curl:

```bash
curl https://tells.blowhorn.ai/api/check
```

| Route | Method | Returns |
|---|---|---|
| `/api/check` | GET | Server-side signals and a verdict |
| `/api/ping` | GET | Latency sample (the page calls it while it collects) |
| `/api/report` | POST | Full verdict for a client report the page collected |

`GET /api/check` and `POST /api/report` success bodies include `schema_version` (integer `1`). The report schema is `schemas/report.schema.json` and the check schema is `schemas/check.schema.json` (draft 2020-12, `$id` under `https://tells.blowhorn.ai/schemas/v1/`). The check body is the report body without `client` and `detections`. Download JSON and Copy JSON serialize that response, including `schema_version`. Check rows, `server.cloudflareBotManagement`, the interaction report, fingerprint stability and the in-browser report comparison have their own schemas in `schemas/`; unit tests validate the real Worker output against them.

## Methodology

[/methodology/](https://tells.blowhorn.ai/methodology/) explains the 0-100 score, the pass, warning, and fail verdict, and which version a number belongs to. Scoring happens on the server. `schema_version` is on the success bodies above. The check catalog's `catalog_version` and [/checks/changelog/](https://tells.blowhorn.ai/checks/changelog/) name the checks. Scores are only comparable across the same `schema_version`, and across the same catalog when you cite a check.

## Compare two saved reports

Open [/compare/](https://tells.blowhorn.ai/compare/) and paste or drop two files from Download JSON. The diff runs in the browser: verdict label, score and reasons, each check row's status and summary, and the flag groups the result page shows. Nothing is posted and nothing is stored. If `schema_version` is missing or the two versions differ, the page warns that scores are only comparable across the same version, and still diffs overlapping fields. A file that is not a Tells report is named as such. IP addresses, WebRTC candidates, history length, extension probe results, fingerprint hashes, GPU vendor and renderer, and font lists are omitted even when an older download still has them.

The open check catalog is [`schemas/check-catalog.json`](schemas/check-catalog.json) (schema [`schemas/check-catalog.schema.json`](schemas/check-catalog.schema.json)). `catalog_version` is **1.0.2**. It lists every check row and every scored reason that already ships, including not-available rows and the 0-point `fingerprint_randomized` reason. The [/checks/changelog/](https://tells.blowhorn.ai/checks/changelog/) page records that version. `node scripts/generate-check-pages.mjs` writes the [/checks/](https://tells.blowhorn.ai/checks/) index and each catalog check page from that file. `tests/generate-check-pages.test.js` fails if a catalog check has no page, if a page drifts from the catalog, or if the index omits a check. `/checks/changelog/` and `/checks/platforms/` stay hand-written. The catalog is not a field on `/api/report`.

API routes are rate limited at the Worker edge by route and client IP (30 calls a minute by default).

## CLI

Install once, then run `tells`:

```bash
npm i -g blowhorn-tells
tells
tells --server-only
```

or with Homebrew (it pulls in `node`):

```bash
brew install blowhorn-ai/tap/tells
tells
```

The npm package is [`blowhorn-tells`](https://www.npmjs.com/package/blowhorn-tells); the command it puts on PATH is `tells`. The Homebrew formula lives in the [blowhorn-ai/homebrew-tap](https://github.com/blowhorn-ai/homebrew-tap) tap. To run the default branch once without a global install:

```bash
npx github:blowhorn-ai/tells
npx github:blowhorn-ai/tells --server-only
```

From a checkout, `bin/tells.js` is the same command (`package.json` `bin`):

```bash
node bin/tells.js
node bin/tells.js --url http://127.0.0.1:8787
node bin/tells.js --server-only
```

The command does not store the report. [`schemas/cli-release.json`](schemas/cli-release.json) (schema [`schemas/cli-release.schema.json`](schemas/cli-release.schema.json)) is the source of truth for the package, command, tap and formula names and the install commands above; `tells --help` prints its install lines.

Stdout is the JSON body and nothing else. The default run opens the page in headless Chromium with Playwright and prints the text of `[data-tells-report="raw"]`, which is the `POST /api/report` body (`schemas/report.schema.json`, `schema_version` 1). `--server-only` skips the browser and prints `GET /api/check` (`schemas/check.schema.json`, `schema_version` 1). `--compact` prints one JSON line. Stderr is a single line, `<classification> score=<n>`.

Playwright is optional. It is a dev dependency in this checkout so a local browser run can load it, and it is not a dependency of the `blowhorn-tells` package, so `npm i -g blowhorn-tells`, `brew install blowhorn-ai/tap/tells` and `npx github:blowhorn-ai/tells` do not install it. Chromium itself is not bundled. `--server-only` does not need a browser or anything else. For the browser run after an npm install, add Playwright globally next to `tells` (Node finds it there):

```bash
npm i -g playwright
npx playwright install chromium
tells
```

A Homebrew install keeps `tells` in its own prefix, where Node cannot find Playwright, so use the npm install for browser runs. A live browser pass from a checkout:

```bash
pnpm exec playwright install chromium
node bin/tells.js --url http://127.0.0.1:8787
```

Start `pnpm dev` first when the URL is local. If Playwright or Chromium is missing, the browser run exits 2 and prints the install step. CI that cannot install a browser should run the unit tests (`pnpm test`) and, if it wants a live request, `tells --server-only` (or `node bin/tells.js --server-only` from a checkout).

| Exit | Meaning |
|---|---|
| 0 | `likely_human`, or `--help` / `-h` or `--version` / `-V` (output on stdout) |
| 1 | Usage error |
| 2 | The run failed, or the body is not `schema_version` 1 |
| 3 | `suspicious` |
| 4 | `likely_bot` |

A stock headless browser is expected to exit 4. That means the check finished. `tells --help` prints the same codes.

## Privacy

This is not a "nothing leaves your browser" checker. Scoring happens on the server, so the readings have to get there. This is what happens on each run:

- The page runs its checks on load and posts the readings to `/api/report`. The Worker scores them and returns the report. Unless the visitor opts out, it also keeps a redacted copy of the report for 90 days (see below). Workers observability is off in `wrangler.json`, so there are no request logs.
- The Worker sends the visitor's IP address, and nothing else, to ipapi.is to check for datacenter, proxy, VPN and Tor addresses. `/api/check` and `/api/report` both do this; `/api/ping` does not. Set `IP_INTEL_PROVIDER=none` to turn it off.
- The WebRTC check asks Google's public STUN server (`stun.l.google.com`) for the browser's address, as any WebRTC page can.

### The reports catalog

Collection is on by default. For each run the Worker keeps one redacted row in Cloudflare D1 (`migrations/0001_reports.sql`): the verdict score and classification, the reason ids, the detection rows, the schema and check catalog versions, a browser and operating system family, the country, a datacenter flag and the time. It never keeps the IP address, headers, WebRTC addresses, fingerprint values, the page address or the referrer. The allow list in `src/report-catalog.js` is the whole record.

Once an hour a cron (`scheduled` in `src/worker.js`, `src/report-store.js`) turns the waiting rows into daily aggregates (`agg_counts`, kept forever) and writes one gzipped NDJSON object per hour of data to R2. R2 write operations therefore follow the clock, not traffic. At 03:xx UTC the same job deletes rows and objects past retention: 90 days, shortened when the budget fills. The total number of reports collected is a monotonic counter (the sum of `ledger.accepted`, never pruned), shown on the page and at `GET /api/stats`.

**No storage or network fee, ever.** Cloudflare has no hard spend cap, so the limits are in code (`src/report-budget.js`, design in issue #108). Every budget is 50% of a free allowance. A ledger counts what the Worker writes, and the mode below follows the fullest budget. If a counter cannot be read, or `COLLECT_DISABLED=1` is set, nothing is written.

| Budget used | Mode | What it does |
| --- | --- | --- |
| under 60% | normal | catalog row, aggregates, raw object, 90-day retention |
| 60% | tighten | raw and catalog retention drops to 30 days |
| 70% | sample | raw kept for 1 in 4 runs and every run with 3 or more reasons; retention 14 days |
| 85% | aggregate | catalog rows and aggregates only, no raw |
| 95% | count | only the daily counter |
| 100%, or unreadable | off | nothing is written |

Budgets: 5,000 accepted reports a day, 50,000 D1 rows written a day (an index row counts, and each report costs about 8 over its life), 5 GB of raw in R2, 500,000 R2 write operations a month. Visitors never read R2. Stay on the Workers Free plan, use Standard storage only, and add no other billable binding: a test fails if `wrangler.json` gains anything outside the D1 `REPORTS` and R2 `RAW` bindings.

A visitor opts out in the page footer ("Keep a redacted copy of my reports", kept in this browser only), with `?collect=off` on the page address, or with `tells --no-collect`. The Global Privacy Control signal is not treated as an opt-out. An opted-out run is not stored. Turning the footer setting off also removes the copy of the run already posted on that page (`POST /api/report/forget`). That removes the catalog row only: the run stays in the daily aggregates and in any hourly R2 object already written, until retention ends. The total collected does not go down, and the removal is counted separately.

Storage is off until the bindings exist. To turn it on (an account owner does this once):

```sh
wrangler d1 create blowhorn-tells-reports
wrangler r2 bucket create blowhorn-tells-raw
wrangler r2 bucket lifecycle add blowhorn-tells-raw expire-91d --expire-days 91
wrangler d1 migrations apply blowhorn-tells-reports --remote
```

Then add to `wrangler.json`: a `d1_databases` entry (`binding: "REPORTS"`, the database name and the id that `d1 create` printed) and an `r2_buckets` entry (`binding: "RAW"`, `bucket_name: "blowhorn-tells-raw"`). Turn on Cloudflare usage notifications at 50% and 80% of each allowance. Check the real usage against the ledger on the first of each month. These notifications warn; the ledger is what prevents a fee.

The page footer says the same thing. If any of this changes, update the footer and this section in the same change.

## Develop

Node 24 and corepack.

```bash
make setup   # corepack enable && pnpm install --frozen-lockfile
make dev     # wrangler dev
make test    # syntax check, unit tests, Worker end-to-end tests
```

Service Worker checks need a secure context; `localhost` counts as one in current browsers.

`pnpm contrast` prints the WCAG contrast of the pass, warn and fail colours on every surface, in the dark and light themes and inside the dispatch card. `tests/contrast.test.js` holds them to AA (4.5:1 for text, 3:1 for icons and borders), and `tests/e2e/checks-layout.spec.js` measures the rendered verdict, status words, icons, links and dispatch card in both themes. In the light theme, warn text and icons use `--warn-ink`; `--warn` is for borders and the gauge only.

The card variants (`card-paper`, `card-dispatch`, `card-stamp`, `card-field`, `card-plain`) come from the shared stylesheet at `https://blowhorn.ai/assets/brand/cards.css`, which `public/index.html` links rather than copies. The dispatch card is near-black in both themes, so `public/styles.css` gives it the dark token set. The end-to-end tests stub that stylesheet so they never depend on the network.

No two cards that sit next to each other share a variant. The result page's detail panels sit in a grid, one column and two above 900px. Their variants follow the markup order on a four-step cycle (stamp, field, plain, dispatch); adding or moving a panel means re-dealing the cycle from that point. `tests/e2e/card-neighbours.spec.js` checks the rendered layout of `/`, `/compare/`, `/methodology/` and the `/checks/` and `/agents/` pages at 320, 820 and 1280px in both themes. The e2e test server (`tests/e2e/support/worker-server.js`) serves `dir/` as `dir/index.html`, as Workers Assets does. Doc pages with five sections or fewer use each variant once. No card, panel, row, callout or quote draws a stripe on one edge; `tests/e2e/no-edge-stripes.spec.js` checks the computed styles of every card, panel, row, callout, quote and item element on `/`, `/compare/`, `/methodology/`, `/agents/`, `/checks/` and every `/checks/<name>/` page, in both themes. A code block on a doc page is one surface: `pre code` drops the inline code chip that the shared `cards.css` gives every `code` in a card, and a paragraph after a block keeps a 1em gap. `tests/e2e/doc-code-blocks.spec.js` checks both on every doc page, with the shared chip rule served in place of the empty stub.

## Known-good corpus

`tests/e2e/fixtures/captures/` holds real reports from privacy-hardened browsers and stock automation tools. `tests/e2e/known-good-browsers.spec.js` posts each one to `/api/report` again. A `human` capture must stay `likely_human` with none of `disallowedKnownGoodReasonIds`, and an `automation` capture must come out `likely_bot`. The synthetic reports in `tests/e2e/fixtures/known-good-browsers.js` stay alongside them.

To add one, run the checks in that browser, press Download JSON, then:

```bash
node scripts/capture-fixture.mjs report.json --id brave-1-73-macos-15 --kind human \
  --browser Brave --browser-version 1.73 --os macOS --os-version 15.1 \
  --privacy "Shields: block fingerprinting (strict)"
```

The script keeps only the headers a browser sends by itself and drops the rest, such as Cloudflare and proxy headers, cookies, origin and referer. From the readings it removes the history length, the extension probe results, the WebRTC candidates and addresses along with the Worker's comparison to the request IP, the page referrer, and the query and fragment of the page URL. Each fingerprint surface keeps only whether it worked (`supported` and any error). Hashes, the GPU vendor and renderer, font lists and the other values go. `fingerprints.stability` stays as it is, since it holds only counts and classes. A capture from a privacy browser (one with privacy settings listed) must also show at least one randomized or blocked surface and no context mismatch. It also removes the consistency keys the Worker adds. The Worker derives the header-based ones again from the kept headers, but the IP-based timezone check is lost. The script writes `captures/<id>.json` and an entry in `captures/manifest.json` (`schemas/fixture-manifest.schema.json`) that names everything it dropped. `tests/capture-fixture.test.js` fails if a fixture is missing from the manifest or still holds anything the script would remove.

## Deploy

`master` deploys through `.github/workflows/deploy.yml` when the repository has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Without them the workflow says so and deploys nothing. The Worker serves the `tells.blowhorn.ai` custom domain (`wrangler.json`).

On Cloudflare the client address always comes from `cf-connecting-ip`. Behind another proxy, set `TRUST_FORWARDED_CLIENT_IP_HEADERS=true` and `TRUSTED_PROXY_HOPS` to the number of proxies you run (default 1). The Worker then reads `X-Forwarded-For` from the right, so a client cannot choose its own rate-limit key.

## Release

Release Drafter keeps a draft `v<semver>` release on `master`. Publishing it runs `.github/workflows/publish-blowhorn-tells.yml`, which checks out that release tag, sets the package version from it (`v0.3.12` publishes `0.3.12`; a semver prerelease such as `v0.4.0-rc.1`, or a GitHub release marked prerelease, goes to the `next` dist-tag), runs `pnpm check` and `pnpm test`, and runs `npm publish --provenance --access public`. If npm already has that version, the run skips the publish and still succeeds. A tag that is not `v` plus semver fails the run before anything is published (`scripts/release-version.mjs`). The `version` in `package.json` tracks the latest tag but the tag wins at publish time.

The workflow authenticates with npm trusted publishing (OIDC), so there is no npm token in the repo or its secrets. npm offers the trusted publisher setting only once a package exists, so the first publish was done by hand: `blowhorn-tells` is on the public npm registry, and that first cut went out as 0.3.11, built from commit `baf90de` because `package.json` had not been bumped. Until trusted publishing is set up, a release run fails at `npm publish`. A maintainer still needs to:

1. On npmjs.com open Packages > blowhorn-tells > Settings > Trusted publishing and add GitHub Actions with organization `blowhorn-ai`, repository `tells`, workflow filename `publish-blowhorn-tells.yml`, and no environment. Allow `npm publish` (new configurations only allow `npm stage publish` unless you tick it). A new configuration expires unless a publish uses it within 2 days, so add it shortly before the next release, or delete and re-add it if it lapses.
2. Optionally set the package's publishing access to require 2FA and disallow tokens, so only the workflow can publish.

The Homebrew tap does not need a token from this repo. Its own workflow polls the public npm registry and rewrites `Formula/tells.rb` with `scripts/render-homebrew-formula.mjs`. The tap's files, including that workflow, start in [`packaging/homebrew-tap/`](packaging/homebrew-tap/); its README has the steps to create `blowhorn-ai/homebrew-tap` from them.

## IP intelligence providers

The default provider is `ipapi.is`, called from the Worker. Anonymous use covers light traffic; for more, set a Worker secret:

```bash
pnpm wrangler secret put IPAPI_IS_KEY
```

| `IP_INTEL_PROVIDER` | Secret | Notes |
|---|---|---|
| `ipapi` | optional `IPAPI_IS_KEY` | Default. Returns `is_datacenter`, `is_proxy`, `is_vpn`, `is_tor` |
| `ipinfo` | `IPINFO_TOKEN` | IPinfo privacy endpoint |
| `ipqs` | `IPQUALITYSCORE_KEY` | IPQualityScore proxy and VPN API |
| `none` | none | No external IP intelligence |

## License

Apache-2.0. See [LICENSE](LICENSE).
