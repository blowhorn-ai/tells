import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  probePrototypeLies,
  prototypeLieMismatches,
  prototypeLieProbeSource
} from "../public/collect-tells.js";
import { scoreRemoteControlTells, scoreReport } from "../src/report-verdict.js";

function nativeGetter() {
  return Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
}

function realm({ toStringNative = true, getters = {} }) {
  const proto = {};
  for (const [prop, native] of Object.entries(getters)) {
    const get = native ? nativeGetter() : function spoofed() { return prop; };
    Object.defineProperty(proto, prop, { configurable: true, enumerable: true, get });
  }
  return {
    functionToString: toStringNative,
    getters: {
      webdriver: Object.prototype.hasOwnProperty.call(getters, "webdriver") ? getters.webdriver : null,
      languages: Object.prototype.hasOwnProperty.call(getters, "languages") ? getters.languages : null,
      plugins: Object.prototype.hasOwnProperty.call(getters, "plugins") ? getters.plugins : null
    },
    nav: Object.create(proto)
  };
}

const cleanGetters = { webdriver: true, languages: true, plugins: true };

function cleanProbe() {
  return realm({ getters: cleanGetters });
}

const cleanTells = {
  webdriver: { definedOn: "Navigator.prototype", getterNative: true },
  nativeFunctions: { functionToString: true, permissionsQuery: true },
  documentAutomationKeys: [],
  input: { count: 0, untrusted: 0, trustedWhileHidden: 0, trustedWithoutFocus: 0 }
};

function reasonIds(tells) {
  const reasons = [];
  scoreRemoteControlTells({ browser: {}, tells }, {}, (points, id) => reasons.push({ id, points }));
  return reasons;
}

describe("prototype lie probe", () => {
  it("reads a native toString and a native getter, and a script getter as not native", () => {
    const native = nativeGetter();
    const proto = {};
    Object.defineProperty(proto, "languages", { configurable: true, get: native });
    Object.defineProperty(proto, "webdriver", { configurable: true, get() { return false; } });
    const reading = probePrototypeLies(Object.create(proto));
    expect(reading.functionToString).toBe(true);
    expect(reading.getters.languages).toBe(true);
    expect(reading.getters.webdriver).toBe(false);
    expect(reading.getters.plugins).toBeNull();
  });

  it("revives to the same function the Worker and iframe evaluate", () => {
    const proto = {};
    Object.defineProperty(proto, "plugins", { configurable: true, get() { return []; } });
    const nav = Object.create(proto);
    const revived = new Function(`return ${prototypeLieProbeSource()}`)();
    expect(revived(nav)).toEqual(probePrototypeLies(nav));
    expect(prototypeLieProbeSource()).toContain("[native code]");
    expect(prototypeLieProbeSource()).toContain("webdriver");
  });
});

describe("prototype lie mismatches", () => {
  it("stays quiet when the page, iframe, and worker agree, including a worker with no plugins", () => {
    const page = cleanProbe();
    const iframe = cleanProbe();
    const worker = realm({ getters: { webdriver: true, languages: true } });
    expect(prototypeLieMismatches({
      page,
      iframe,
      worker
    })).toEqual([]);
    expect(reasonIds({ ...cleanTells, prototypeLies: { page, iframe, worker } })).toEqual([]);
  });

  it("stays quiet when every context is patched the same way", () => {
    const patched = realm({ toStringNative: false, getters: { webdriver: false, languages: false, plugins: false } });
    expect(prototypeLieMismatches({ page: patched, iframe: patched, worker: patched })).toEqual([]);
  });

  it("flags a toString that is native on the page and spoofed in the iframe", () => {
    const page = cleanProbe();
    const iframe = realm({ toStringNative: false, getters: cleanGetters });
    const worker = realm({ getters: { webdriver: true, languages: true } });
    const mismatches = prototypeLieMismatches({ page, iframe, worker });
    expect(mismatches).toEqual([{
      surface: "Function.prototype.toString",
      values: { page: true, iframe: false, worker: true }
    }]);
    const scored = scoreReport({
      server: { userAgent: "Mozilla/5.0" },
      client: { browser: { userAgent: "Mozilla/5.0", plugins: [{}], webdriver: false }, tells: { ...cleanTells, prototypeLies: { page, iframe, worker } } }
    });
    const reason = scored.reasons.find((item) => item.id === "prototype_lie_mismatch");
    expect(reason).toMatchObject({ points: 15, severity: "medium" });
    expect(scored.reasons.map((item) => item.id)).not.toContain("native_function_patched");
  });

  it("flags a languages getter spoofed only in the worker", () => {
    const page = cleanProbe();
    const iframe = cleanProbe();
    const worker = realm({ getters: { webdriver: true, languages: false } });
    expect(prototypeLieMismatches({ page, iframe, worker })).toEqual([{
      surface: "navigator.languages",
      values: { page: true, iframe: true, worker: false }
    }]);
  });

  it("ignores a context that failed to collect", () => {
    const page = cleanProbe();
    expect(prototypeLieMismatches({
      page,
      iframe: { error: "blocked" },
      worker: null
    })).toEqual([]);
  });

  it("stays quiet for a clean page, iframe, worker, and service worker, including workers with no plugins", () => {
    const page = cleanProbe();
    const iframe = cleanProbe();
    const worker = realm({ getters: { webdriver: true, languages: true } });
    const serviceWorker = realm({ getters: { webdriver: true, languages: true } });
    expect(prototypeLieMismatches({ page, iframe, worker, serviceWorker })).toEqual([]);
    expect(reasonIds({ ...cleanTells, prototypeLies: { page, iframe, worker, serviceWorker } })).toEqual([]);
  });

  it("flags a toString that is native everywhere except the service worker", () => {
    const page = cleanProbe();
    const iframe = cleanProbe();
    const worker = realm({ getters: { webdriver: true, languages: true } });
    const serviceWorker = realm({ toStringNative: false, getters: { webdriver: true, languages: true } });
    expect(prototypeLieMismatches({ page, iframe, worker, serviceWorker })).toEqual([{
      surface: "Function.prototype.toString",
      values: { page: true, iframe: true, worker: true, serviceWorker: false }
    }]);
    const scored = scoreReport({
      server: { userAgent: "Mozilla/5.0" },
      client: {
        browser: { userAgent: "Mozilla/5.0", plugins: [{}], webdriver: false },
        tells: { ...cleanTells, prototypeLies: { page, iframe, worker, serviceWorker } }
      }
    });
    const reason = scored.reasons.find((item) => item.id === "prototype_lie_mismatch");
    expect(reason).toMatchObject({
      points: 15,
      severity: "medium",
      message: "Function.prototype.toString or a navigator getter disagrees across the page, an iframe, a worker, and a service worker."
    });
    expect(scored.reasons.map((item) => item.id)).not.toContain("native_function_patched");
  });

  it("does not treat a missing or failed service worker as a lie", () => {
    const page = cleanProbe();
    const iframe = cleanProbe();
    const worker = realm({ getters: { webdriver: true, languages: true } });
    for (const serviceWorker of [null, undefined, { error: "Service Worker registration timeout" }, { supported: false }]) {
      expect(prototypeLieMismatches({ page, iframe, worker, serviceWorker })).toEqual([]);
    }
    const spoofedIframe = realm({ toStringNative: false, getters: cleanGetters });
    expect(prototypeLieMismatches({
      page,
      iframe: spoofedIframe,
      worker,
      serviceWorker: { error: "Service Worker activation timeout" }
    })).toEqual([{
      surface: "Function.prototype.toString",
      values: { page: true, iframe: false, worker: true }
    }]);
  });

  it("keeps a uniform patch on the existing reason when the service worker matches", () => {
    const patched = realm({ toStringNative: false, getters: { webdriver: false, languages: false, plugins: false } });
    const workerPatched = realm({ toStringNative: false, getters: { webdriver: false, languages: false } });
    const probes = { page: patched, iframe: patched, worker: workerPatched, serviceWorker: workerPatched };
    expect(prototypeLieMismatches(probes)).toEqual([]);
    expect(reasonIds({
      ...cleanTells,
      nativeFunctions: { functionToString: false, permissionsQuery: true },
      prototypeLies: probes
    })).toEqual([{ id: "native_function_patched", points: 15 }]);
  });
});

describe("service worker probe wiring", () => {
  it("imports the shared probe instead of copying it", () => {
    const source = readFileSync(new URL("../public/sw-detector.js", import.meta.url), "utf8");
    const registration = readFileSync(new URL("../public/collect-workers.js", import.meta.url), "utf8");
    expect(source).toContain('import { probePrototypeLies } from "./collect-tells.js"');
    expect(source).toContain("probePrototypeLies(navigator)");
    expect(source).not.toContain("[native code]");
    expect(registration).toContain('navigator.serviceWorker.register("/sw-detector.js", { scope: "/", type: "module" })');
  });
});
