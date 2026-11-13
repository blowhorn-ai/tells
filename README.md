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

**Behavior.** A transparent score from pointer, key, scroll, focus and frame timing. The Worker derives that score from the evidence the page posts and uses the derived score in the verdict. An optional interaction test — press Start, type one fixed phrase, press Submit (Enter or Space on either button also works) — adds 15 checks of event order, click geometry, press length, key rhythm, focus and blur, and tab visibility, which stay warn-only until calibrated.

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

Check rows and `server.cloudflareBotManagement` have JSON Schemas (draft 2020-12) in `schemas/`; unit tests validate the real output against them.

API routes are rate limited at the Worker edge by route and client IP (30 calls a minute by default).

## Privacy

This is not a "nothing leaves your browser" checker. Scoring happens on the server, so the readings have to get there. This is what happens on each run:

- The page runs its checks on load and posts the readings to `/api/report`. The Worker scores them and returns the report. It writes nothing to storage, and Workers observability is off in `wrangler.json`.
- The Worker sends the visitor's IP address, and nothing else, to ipapi.is to check for datacenter, proxy, VPN and Tor addresses. `/api/check` and `/api/report` both do this; `/api/ping` does not. Set `IP_INTEL_PROVIDER=none` to turn it off.
- The WebRTC check asks Google's public STUN server (`stun.l.google.com`) for the browser's address, as any WebRTC page can.

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

No two cards that sit next to each other share a variant. The result page's detail panels sit in a grid, one column and two above 900px. Their variants follow the markup order on a four-step cycle (stamp, field, plain, dispatch); adding or moving a panel means re-dealing the cycle from that point. `tests/e2e/card-neighbours.spec.js` checks the rendered layout of `/` and the `/checks/` and `/agents/` pages at 320, 820 and 1280px in both themes. The e2e test server (`tests/e2e/support/worker-server.js`) serves `dir/` as `dir/index.html`, as Workers Assets does. Doc pages with five sections or fewer use each variant once. No card, panel, row, callout or quote draws a stripe on one edge; `tests/e2e/no-edge-stripes.spec.js` checks the computed styles of every card, panel, row, callout, quote and item element on `/`, `/agents/`, `/checks/` and every `/checks/<name>/` page, in both themes.

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

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
