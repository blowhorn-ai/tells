#!/usr/bin/env node
// Release tag -> npm version. The publish workflow runs this on the GitHub release tag
// (Release Drafter tags look like v0.3.12) and the Homebrew formula renderer reuses
// assertVersion. Usage: node scripts/release-version.mjs v0.3.12
// Prints "version=0.3.12" and "dist_tag=latest" (or "next" for a prerelease) for $GITHUB_OUTPUT.

import { pathToFileURL } from "node:url";

// semver.org 2.0.0 grammar, without a leading v.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function assertVersion(version) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`Not a semver version: ${JSON.stringify(version)}`);
  }
  return version;
}

export function versionFromTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v") || !SEMVER.test(tag.slice(1))) {
    throw new Error(`Release tag must be v plus a semver version (for example v0.3.12), got ${JSON.stringify(tag)}`);
  }
  return tag.slice(1);
}

// A prerelease (0.4.0-rc.1) must not become what `npm i -g` installs by default.
export function distTagFor(version) {
  return SEMVER.exec(assertVersion(version))[4] === undefined ? "latest" : "next";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const version = versionFromTag(process.argv[2]);
    process.stdout.write(`version=${version}\ndist_tag=${distTagFor(version)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
