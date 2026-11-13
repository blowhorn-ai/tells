// Turns a report saved with Download JSON on the site into a known-good corpus fixture: the
// request headers and client readings POST /api/report needs to score it again, with
// identifying data removed, plus a manifest entry that says what was captured and redacted.
//
//   node scripts/capture-fixture.mjs report.json --id brave-1-73-macos-15 --kind human \
//     --browser Brave --browser-version 1.73 --os macOS --os-version 15.1 \
//     --privacy "Shields: block fingerprinting (strict)"
//
// Writes tests/e2e/fixtures/captures/<id>.json and adds or replaces its entry in
// tests/e2e/fixtures/captures/manifest.json. tests/capture-fixture.test.js checks the
// manifest against schemas/fixture-manifest.schema.json and that every fixture is redacted.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const root = fileURLToPath(new URL("..", import.meta.url));

export const MANIFEST_SCHEMA_PATH = "schemas/fixture-manifest.schema.json";
export const CAPTURES_DIR = "tests/e2e/fixtures/captures";
export const MANIFEST_PATH = `${CAPTURES_DIR}/manifest.json`;

// Headers a browser sends on its own. Everything else is dropped and named in the manifest:
// Cloudflare and proxy headers carry the client IP and location, and host, origin, referer,
// cookies and the body headers describe this request, not the browser.
const KEPT_HEADER = /^(user-agent|accept|accept-language|accept-encoding|dnt|sec-gpc|priority|cache-control|pragma|upgrade-insecure-requests|sec-ch-[a-z0-9-]+|sec-fetch-[a-z0-9-]+)$/;

// Keys enrichClientConsistency (src/report-verdict.js) adds to client.consistency. The Worker
// derives the header ones again from the kept headers. timezoneMismatch comes from the IP
// lookup, which a fixture no longer has.
const SERVER_CONSISTENCY_KEYS = [
  "userAgentMismatch",
  "acceptLanguageMismatch",
  "clientHintPlatformMismatch",
  "clientHintMobileMismatch",
  "clientHintHighEntropyMismatch",
  "userAgentDataHighEntropyMismatch",
  "mobileTouchMismatch",
  "timezoneMismatch"
];

// The WebRTC result keeps only whether it ran. Candidates, addresses and the Worker's
// comparison with the request IP all go.
const KEPT_WEBRTC_KEYS = ["supported", "error"];

export function redactReport(report) {
  if (!report || typeof report !== "object" || !isObject(report.client) || !isObject(report.server?.headers)) {
    throw new Error("Expected a report saved with Download JSON: an object with client and server.headers.");
  }

  const headers = {};
  const droppedHeaders = [];
  for (const [name, value] of Object.entries(report.server.headers)) {
    const key = name.toLowerCase();
    if (KEPT_HEADER.test(key) && typeof value === "string") headers[key] = value;
    else droppedHeaders.push(key);
  }

  const { client, removedFields } = redactClient(report.client);
  return {
    fixture: { headers: sortKeys(headers), client },
    redaction: { droppedHeaders: droppedHeaders.sort(), removedFields }
  };
}

export function redactClient(original) {
  const client = structuredClone(original);
  const removedFields = [];
  const remove = (parent, key, path) => {
    if (parent && Object.hasOwn(parent, key)) {
      delete parent[key];
      removedFields.push(path);
    }
  };

  remove(client.browser, "historyLength", "client.browser.historyLength");
  remove(client.surfaces, "extensions", "client.surfaces.extensions");
  remove(client.consistency, "webrtcPublicIps", "client.consistency.webrtcPublicIps");
  for (const key of SERVER_CONSISTENCY_KEYS) remove(client.consistency, key, `client.consistency.${key}`);

  const webrtc = client.network?.webrtc;
  if (isObject(webrtc)) {
    for (const key of Object.keys(webrtc).sort()) {
      if (!KEPT_WEBRTC_KEYS.includes(key)) remove(webrtc, key, `client.network.webrtc.${key}`);
    }
  }

  if (isObject(client.page)) {
    if (client.page.referrer == null) delete client.page.referrer;
    else remove(client.page, "referrer", "client.page.referrer");
    if (typeof client.page.url === "string") {
      const url = new URL(client.page.url);
      const bare = `${url.origin}${url.pathname}`;
      if (bare !== client.page.url) {
        client.page.url = bare;
        removedFields.push("client.page.url query and fragment");
      }
    }
  }

  return { client, removedFields };
}

export function buildManifestEntry({ id, kind, browser, browserVersion, os, osVersion, privacy = [], captured }, redaction) {
  return {
    id,
    file: `${id}.json`,
    kind,
    browser: { name: browser, version: browserVersion },
    os: { name: os, version: osVersion },
    privacySettings: privacy,
    capturedOn: captured,
    redaction
  };
}

export function compileManifestValidator(repoRoot = root) {
  const schema = JSON.parse(readFileSync(join(repoRoot, MANIFEST_SCHEMA_PATH), "utf8"));
  return new Ajv2020({ allErrors: true }).compile(schema);
}

export function addToManifest(manifest, entry) {
  const fixtures = manifest.fixtures.filter((existing) => existing.id !== entry.id);
  fixtures.push(entry);
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  return { ...manifest, fixtures };
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      id: { type: "string" },
      kind: { type: "string" },
      browser: { type: "string" },
      "browser-version": { type: "string" },
      os: { type: "string" },
      "os-version": { type: "string" },
      privacy: { type: "string", multiple: true },
      captured: { type: "string" }
    }
  });
  if (positionals.length !== 1) throw new Error("Usage: node scripts/capture-fixture.mjs <report.json> --id <id> --kind human|automation ...");

  const report = JSON.parse(readFileSync(positionals[0], "utf8"));
  const { fixture, redaction } = redactReport(report);
  const entry = buildManifestEntry({
    id: values.id,
    kind: values.kind,
    browser: values.browser,
    browserVersion: values["browser-version"],
    os: values.os,
    osVersion: values["os-version"],
    privacy: values.privacy || [],
    captured: values.captured || new Date().toISOString().slice(0, 10)
  }, redaction);

  const manifestFile = join(root, MANIFEST_PATH);
  const manifest = addToManifest(JSON.parse(readFileSync(manifestFile, "utf8")), entry);
  const validate = compileManifestValidator();
  if (!validate(manifest)) {
    throw new Error(`Manifest entry is not valid:\n${validate.errors.map((error) => `  ${error.instancePath || "/"} ${error.message}`).join("\n")}`);
  }

  writeFileSync(join(root, CAPTURES_DIR, entry.file), `${JSON.stringify(fixture, null, 2)}\n`);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${CAPTURES_DIR}/${entry.file}`);
  console.log(`dropped headers: ${redaction.droppedHeaders.join(", ") || "none"}`);
  console.log(`removed fields: ${redaction.removedFields.join(", ") || "none"}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
