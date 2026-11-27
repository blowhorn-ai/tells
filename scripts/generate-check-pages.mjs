// Writes public/checks/index.html and each catalog check page from schemas/check-catalog.json.
// Run with `node scripts/generate-check-pages.mjs`. The HTML is committed.
// tests/generate-check-pages.test.js fails if a page is missing or drifts from the catalog.
// /checks/changelog/ and /checks/platforms/ are not catalog checks and are left alone.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const REPO = "https://github.com/blowhorn-ai/tells";
const CATALOG_HREF = `${REPO}/blob/master/schemas/check-catalog.json`;

// Same labels as CHECK_GROUPS in public/checks-view-model.js, in display order.
export const GUIDE_GROUPS = [
  { key: "automation", label: "Automation flags" },
  { key: "behavior", label: "Behavior" },
  { key: "fingerprint", label: "Fingerprint consistency" }
];

const RULES = [
  ["pass", "Pass"],
  ["warn", "Warning"],
  ["fail", "Fail"],
  ["na", "Not available"]
];

const OUTCOMES = { fail: "Fail", warn: "Warning" };

export function loadCatalog(repoRoot = root) {
  return JSON.parse(readFileSync(join(repoRoot, "schemas/check-catalog.json"), "utf8"));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function head(title, description) {
  return `<!doctype html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#1E2117" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/assets/fonts/BricolageGrotesque-Variable.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/assets/fonts/InstrumentSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="https://blowhorn.ai/assets/brand/cards.css">
  <link rel="stylesheet" href="/styles.css">
  <!-- Google Analytics: the same GA4 property as blowhorn.ai. No consent banner on this tool. -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-2ZLYGVE3HN"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    gtag('js', new Date());
    gtag('config', 'G-2ZLYGVE3HN');
  </script>
</head>`;
}

function header() {
  return `  <header class="site-header">
    <div class="wrap header-bar">
      <a class="brand" href="https://blowhorn.ai/" aria-label="Blowhorn home">
        <img class="logo-dark" src="/assets/brand/blowhorn-lockup-horizontal-on-dark.svg" alt="Blowhorn" width="176" height="44">
        <img class="logo-light" src="/assets/brand/blowhorn-lockup-horizontal.svg" alt="" width="176" height="44">
      </a>
      <a class="product-name" href="/" aria-label="Tells, the bot detection test">Tells</a>
      <nav class="site-nav" aria-label="Blowhorn">
        <ul>
          <li><a href="https://blowhorn.ai/">What is Blowhorn</a></li>
          <li><a href="https://blowhorn.ai/pricing/">Pricing</a></li>
          <li><a href="https://blowhorn.ai/docs/">Docs</a></li>
          <li><a href="/insights/">Insights</a></li>
        </ul>
      </nav>
      <a class="button-primary site-cta" href="https://blowhorn.ai/download/">Get Blowhorn</a>
    </div>
  </header>`;
}

function footer() {
  return `  <footer class="site-footer">
    <div class="wrap">
      <div class="footer-panel card card-plain">
        <div class="footer-top">
          <div class="footer-brand">
            <a class="footer-logo" href="https://blowhorn.ai/" aria-label="Blowhorn home">
              <img class="logo-dark" src="/assets/brand/blowhorn-lockup-horizontal-on-dark.svg" alt="Blowhorn" width="200" height="50">
              <img class="logo-light" src="/assets/brand/blowhorn-lockup-horizontal.svg" alt="" width="200" height="50">
            </a>
            <p class="footer-tagline">Your voice, at full volume.</p>
            <p class="footer-about">Tells is a free check from the Blowhorn team. It shows what websites can read about your browser.</p>
          </div>
        </div>
        <nav class="footer-cols" aria-label="Footer">
          <div class="footer-col">
            <h2 class="footer-title">Tells</h2>
            <ul>
              <li><a href="/#checks">Checks performed</a></li>
              <li><a href="/checks/">What each check means</a></li>
              <li><a href="/checks/changelog/">Check catalog changelog</a></li>
              <li><a href="/agents/">For AI agents</a></li>
              <li><a href="${REPO}">Source code</a></li>
            </ul>
          </div>
          <div class="footer-col">
            <h2 class="footer-title">Blowhorn</h2>
            <ul>
              <li><a href="https://blowhorn.ai/">What is Blowhorn</a></li>
              <li><a href="https://blowhorn.ai/download/">Download</a></li>
              <li><a href="https://blowhorn.ai/pricing/">Pricing</a></li>
              <li><a href="https://blowhorn.ai/docs/">Docs</a></li>
            </ul>
          </div>
        </nav>
      </div>
      <div class="footer-bottom">
        <span>&copy; 2026 Layer5, Inc.</span>
      </div>
    </div>
  </footer>`;
}

function page(title, description, main) {
  return `${head(title, description)}

<body>
  <div class="ambient-grid" aria-hidden="true"></div>
  <a class="skip-link" href="#main">Skip to the content</a>
${header()}

${main}

${footer()}
</body>

</html>
`;
}

function groupLabel(key) {
  const group = GUIDE_GROUPS.find((item) => item.key === key);
  if (!group) throw new Error(`Unknown check group: ${key}`);
  return group.label;
}

function reasonText(reason) {
  const bits = [];
  if (reason.outcomes) {
    bits.push(reason.outcomes.map((outcome) => `${OUTCOMES[outcome.status]}: ${outcome.severity}, ${outcome.points} points`).join("; "));
  } else {
    bits.push(`${reason.severity}, ${reason.points} points`);
  }
  bits.push(`since ${reason.since}`);
  if (reason.affects_row === false) bits.push("does not change the check row");
  if (reason.provisional === true) bits.push("provisional");
  let text = bits.join(". ");
  if (reason.note) text += `. ${reason.note}`;
  return text;
}

export function renderCheckPage(catalog, check) {
  const label = groupLabel(check.group);
  const ruleItems = RULES
    .filter(([key]) => check.rules[key])
    .map(([key, name]) => `          <li><strong>${name}:</strong> ${escapeHtml(check.rules[key])}</li>`)
    .join("\n");
  const sections = [
    `    <section class="panel card card-field">
      <h2>What Tells reads</h2>
      <ul>
${check.reads.map((read) => `          <li>${escapeHtml(read)}</li>`).join("\n")}
      </ul>
    </section>`,
    `    <section class="panel card card-stamp">
      <h2>How the result is decided</h2>
      <ul>
${ruleItems}
      </ul>
    </section>`
  ];
  if (check.reasons.length) {
    sections.push(`    <section class="panel card card-dispatch">
      <h2>Findings</h2>
      <ul>
${check.reasons.map((reason) => `          <li><code>${escapeHtml(reason.id)}</code>: ${escapeHtml(reasonText(reason))}</li>`).join("\n")}
      </ul>
    </section>`);
  }
  if (check.note) {
    sections.push(`    <section class="panel card card-paper">
      <h2>Note</h2>
      <p>${escapeHtml(check.note)}</p>
    </section>`);
  }
  // Last main card is never card-plain: the footer panel is card-plain, and neighbours must differ.
  const main = `  <main id="main" class="wrap doc-page">
    <p class="eyebrow"><a href="/checks/">Check guide</a> · ${escapeHtml(label)}</p>
    <h1>${escapeHtml(check.name)}</h1>
    <p class="lede">Group: ${escapeHtml(check.group)}. Since ${escapeHtml(check.since)}. Catalog ${escapeHtml(catalog.catalog_version)}.</p>
${sections.join("\n\n")}
  </main>`;
  return page(
    `${check.name} check | Blowhorn Tells`,
    `What the ${check.name} check reads, how Pass, Warning, Fail and Not available are decided, and the points it can subtract. Catalog ${catalog.catalog_version}.`,
    main
  );
}

export function renderIndex(catalog) {
  const groups = GUIDE_GROUPS.map((group, index) => {
    const variant = ["card-stamp", "card-plain", "card-dispatch"][index];
    const items = catalog.checks
      .filter((check) => check.group === group.key)
      .map((check) => {
        const blurb = check.rules.pass ? `: ${escapeHtml(check.rules.pass)}` : "";
        return `          <li><a href="${escapeHtml(check.page)}"><strong>${escapeHtml(check.name)}</strong></a>${blurb}</li>`;
      });
    return `    <section class="panel card ${variant}">
      <h2>${escapeHtml(group.label)}</h2>
      <ul>
${items.join("\n")}
      </ul>
    </section>`;
  });
  const main = `  <main id="main" class="wrap doc-page">
    <p class="eyebrow">Blowhorn Tells</p>
    <h1>What each check means</h1>
    <p class="lede">Each check has a page here: what it reads, how Pass, Warning, Fail and Not available are decided, and the points a finding subtracts.
      The same list is the machine-readable catalog
      <a href="${CATALOG_HREF}"><code>schemas/check-catalog.json</code></a>,
      catalog version ${escapeHtml(catalog.catalog_version)}. <a href="/checks/changelog/">Changelog</a>.</p>
    <section class="panel card card-field">
      <h2>How a result is decided</h2>
      <p>Every check ends in one of four states. <strong>Pass</strong>: the readings were
        collected and nothing in them matched a known tell. <strong>Warning</strong>: a
        medium or low severity finding matched. <strong>Fail</strong>: a high severity
        finding matched, the kind a real gate would act on. <strong>Not available</strong>:
        the readings never arrived (the browser does not expose them, this site's plan does
        not include them, or a drill was not taken). Not available is a statement about
        coverage, never a failure.</p>
      <p>Findings also carry points. The verdict starts at 100 and each finding subtracts
        its weight, so one page's Fail on a heavyweight check can cost more than three
        Warnings elsewhere. Each check page lists the findings that move its row.</p>
    </section>
${groups.join("\n")}
    <section class="panel card card-paper">
      <h2>Which checks does a platform care about?</h2>
      <p>Not every site weighs these equally. The <a href="/checks/platforms/">platform
        guide</a> ranks the platforms Blowhorn works with by how hard their defences lean on
        each family of tells, and explains why an IP finding can end the conversation on one
        platform while behaviour decides it on another.</p>
    </section>
  </main>`;
  return page(
    "What each check means: the Tells check guide | Blowhorn Tells",
    "Every check Blowhorn Tells runs, explained from the open check catalog: what it reads, how Pass, Warning, Fail and Not available are decided, and the points it subtracts.",
    main
  );
}

export function generatedPages(catalog) {
  return [
    { path: "public/checks/index.html", html: renderIndex(catalog) },
    ...catalog.checks.map((check) => ({
      path: `public/checks/${check.slug}/index.html`,
      html: renderCheckPage(catalog, check)
    }))
  ];
}

export function writeGeneratedPages(repoRoot = root, catalog = loadCatalog(repoRoot)) {
  const written = [];
  for (const { path, html } of generatedPages(catalog)) {
    const file = join(repoRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
    written.push(path);
  }
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const written = writeGeneratedPages();
  console.log(written.join("\n"));
}
