// Tells Blowhorn's own release checks look for: what a remote-controlled Chrome gives away
// that the generic fingerprint collectors do not read.

import { inputEvents } from "./runtime.js";

export const AUTOMATION_GLOBAL_PATTERN = /^(cdc_|\$cdc_|__playwright|__pw_|__pwInitScripts|__puppeteer|_selenium|callSelenium|__webdriver|__driver|__fxdriver|__nightmare|_phantom|__\$webdriverAsyncExecutor|__lastWatirAlert|__chromiumoxide|__rod|__headless)/i;

export function matchAutomationGlobals(names) {
  return [...new Set(names.filter((name) => AUTOMATION_GLOBAL_PATTERN.test(name)))].sort();
}

export function collectTells(state) {
  return {
    webdriver: collectWebdriverDescriptor(),
    nativeFunctions: {
      functionToString: isNative(Function.prototype.toString),
      permissionsQuery: navigator.permissions?.query ? isNative(navigator.permissions.query) : null
    },
    // Page half of the cross-context probe. The iframe, Web Worker, and Service Worker
    // readings are attached after collectWorkers, because those realms are not available synchronously.
    prototypeLies: { page: probePrototypeLies(navigator) },
    documentAutomationKeys: matchAutomationGlobals(Object.keys(document)),
    chromeMajor: chromeMajor(navigator.userAgent),
    input: summarizeInput(inputEvents(state))
  };
}

// Documented slice of CreepJS-style lie depth. The page, iframe, and Web Worker each run this
// function in their own realm (the iframe and Worker evaluate its source). The Service Worker
// imports it. A hooked Function.prototype.toString on the page cannot vouch for the others.
// Getter surfaces: navigator.webdriver, navigator.languages, navigator.plugins.
// plugins is absent in a Worker and a Service Worker (null) and is compared only where two contexts both read it.
export const PROTOTYPE_LIE_GETTERS = Object.freeze(["webdriver", "languages", "plugins"]);

export function probePrototypeLies(nav) {
  function nativeSource(fn) {
    try {
      if (typeof fn !== "function") return null;
      return Function.prototype.toString.call(fn).includes("[native code]");
    } catch (_) {
      return null;
    }
  }

  function getterNative(proto, target, prop) {
    try {
      const desc = (proto && Object.getOwnPropertyDescriptor(proto, prop)) || Object.getOwnPropertyDescriptor(target, prop);
      if (!desc) return null;
      if (typeof desc.get === "function") return nativeSource(desc.get);
      return false;
    } catch (_) {
      return null;
    }
  }

  const target = nav || navigator;
  let proto = null;
  try {
    proto = Object.getPrototypeOf(target);
  } catch (_) {
    proto = null;
  }
  // Literal list, not the exported constant: this function's source is evaluated in an iframe and a Worker.
  const getters = {};
  for (const prop of ["webdriver", "languages", "plugins"]) getters[prop] = getterNative(proto, target, prop);
  return { functionToString: nativeSource(Function.prototype.toString), getters };
}

// Source the iframe and Worker evaluate inside their own realm. Nested helpers travel with it.
export function prototypeLieProbeSource() {
  return `(${probePrototypeLies.toString()})`;
}

const PROTOTYPE_LIE_CONTEXTS = ["page", "iframe", "worker", "serviceWorker"];

// A lie here is a disagreement, not a uniform patch. A function that is patched in every
// context is already scored by native_function_patched or prototype_getter_not_native.
// A context that produced no reading (a failed Service Worker registration, a null plugins
// getter) is skipped. At least two readings have to disagree.
export function prototypeLieMismatches(probes) {
  if (!probes || typeof probes !== "object") return [];
  const contexts = {};
  for (const name of PROTOTYPE_LIE_CONTEXTS) {
    const probe = probes[name];
    if (!probe || probe.error || typeof probe.functionToString !== "boolean" || !probe.getters) continue;
    contexts[name] = probe;
  }
  const names = Object.keys(contexts);
  if (names.length < 2) return [];

  const mismatches = [];
  const fnValues = names.map((name) => contexts[name].functionToString);
  if (fnValues.includes(true) && fnValues.includes(false)) {
    mismatches.push({
      surface: "Function.prototype.toString",
      values: Object.fromEntries(names.map((name) => [name, contexts[name].functionToString]))
    });
  }

  const getterNames = [];
  for (const name of names) {
    for (const prop of Object.keys(contexts[name].getters)) {
      if (!getterNames.includes(prop)) getterNames.push(prop);
    }
  }
  for (const prop of getterNames) {
    const present = names.filter((name) => typeof contexts[name].getters[prop] === "boolean");
    if (present.length < 2) continue;
    const values = present.map((name) => contexts[name].getters[prop]);
    if (values.includes(true) && values.includes(false)) {
      mismatches.push({
        surface: `navigator.${prop}`,
        values: Object.fromEntries(present.map((name) => [name, contexts[name].getters[prop]]))
      });
    }
  }
  return mismatches;
}

function collectWebdriverDescriptor() {
  const own = Object.getOwnPropertyDescriptor(navigator, "webdriver");
  const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "webdriver");
  const desc = own || proto;
  return {
    definedOn: own ? "navigator" : proto ? "Navigator.prototype" : "absent",
    getterNative: desc?.get ? isNative(desc.get) : null
  };
}

export function isNative(fn) {
  try {
    return Function.prototype.toString.call(fn).includes("[native code]");
  } catch (_) {
    return null;
  }
}

export function chromeMajor(userAgent) {
  const match = /(?:Chrome|HeadlessChrome)\/(\d+)/.exec(String(userAgent || ""));
  return match ? Number(match[1]) : null;
}

// Every input-carrying event the page records: the state log (pointer, click, key) and the
// interaction test (mouse, key, text and paste events on its three targets). collectTells reads both,
// each event once, through inputEvents; buildInteractionReport reads the interaction test's alone.
const INPUT_TYPES = new Set([
  "pointerdown", "pointerup", "click", "keydown",
  "pointerover", "pointerenter", "mousedown", "mouseup", "keypress", "keyup", "beforeinput", "input", "paste"
]);

export function summarizeInput(events) {
  const input = events.filter((event) => INPUT_TYPES.has(event.type) && typeof event.isTrusted === "boolean");
  return {
    count: input.length,
    untrusted: input.filter((event) => event.isTrusted === false).length,
    trustedWhileHidden: input.filter((event) => event.isTrusted && event.hidden === true).length,
    trustedWithoutFocus: input.filter((event) => event.isTrusted && event.hasFocus === false).length
  };
}
