import { classifyStability, STABILITY_READS } from "./fingerprint-stability.js";
import { promiseWithTimeout, sleep } from "./utils.js";

// Measures client.fingerprints.stability (#44). Each surface is read STABILITY_READS times on the main
// thread and once in a same-origin iframe. Canvas and WebGL are also read once in a Web Worker. The
// values are compared here and never leave the page: only counts, booleans and the class do.
//
// The canvas read is its own control: a small solid-colour fill, which an honest browser returns
// exactly, on every read and in every context. Audio has a separate control, a constant signal.
// Both are fixed and cheap, so a mismatch can only mean the values were changed on the way out.

const CONTROL_SIZE = 32;
const CONTROL_FILL = "rgb(255, 102, 0)";
const CONTROL_PIXEL = [255, 102, 0, 255];
const AUDIO_CONSTANT = 0.5;
const WORKER_TIMEOUT_MS = 1800;
const VOICES_WAIT_MS = 800;

export async function collectFingerprintStability() {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:-9999px;border:0";
  document.body.appendChild(iframe);
  await sleep(0);
  try {
    const frame = iframe.contentWindow;
    const [worker, canvas, webgl, audio, fonts, voices] = await Promise.all([
      readInWorker(),
      measure(() => canvasValue(window), () => canvasValue(frame)),
      measure(() => webglValue(document.createElement("canvas")), () => webglValue(frame.document.createElement("canvas"))),
      measure(() => audioValue(window), () => audioValue(frame)),
      measure(() => fontsValue(window), () => fontsValue(frame)),
      voicesReady(window).then(() => voicesReady(frame)).then(() => measure(() => voicesValue(window), () => voicesValue(frame)))
    ]);
    const audioControl = await audioControlAltered(window);
    return {
      canvas: surface(canvas, worker?.canvas, canvas.values.some((value) => value != null && value !== expectedControl())),
      webgl: surface(webgl, worker?.webgl, null),
      audio: surface(audio, undefined, audioControl),
      fonts: surface(fonts, undefined, null),
      voices: surface(voices, undefined, null)
    };
  } finally {
    iframe.remove();
  }
}

// Main-thread reads one after another, so a value that changes on every read shows up, then one
// iframe read. A read that throws counts as failed (null).
async function measure(readMain, readFrame) {
  const values = [];
  for (let i = 0; i < STABILITY_READS; i += 1) values.push(await safeRead(readMain));
  return { values, frame: await safeRead(readFrame) };
}

async function safeRead(read) {
  try {
    const value = await read();
    return value == null || value === "" ? null : value;
  } catch (_) {
    return null;
  }
}

// workerValue is undefined for surfaces with no worker read, and null when the worker could not read.
export function surface({ values, frame }, workerValue, controlAltered) {
  const present = values.filter((value) => value != null);
  const distinct = new Set(present).size;
  const reference = distinct === 1 ? present[0] : null;
  const matches = (other) => (reference == null || other == null ? null : other === reference);
  const entry = {
    reads: values.length,
    distinct,
    workerMatch: workerValue === undefined ? null : matches(workerValue),
    iframeMatch: matches(frame),
    controlAltered: controlAltered ?? null
  };
  return { ...entry, classification: classifyStability(entry) };
}

function expectedControl() {
  return Array.from({ length: CONTROL_SIZE * CONTROL_SIZE }, () => CONTROL_PIXEL.join(",")).join(",");
}

// Shared with the worker through its source text, so every context paints and reads the same way.
function paintControl(ctx, size, fill) {
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size, size);
  return Array.prototype.join.call(ctx.getImageData(0, 0, size, size).data, ",");
}

function webglValue(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  } catch (_) {
    return null;
  }
  if (!gl) return null;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return JSON.stringify([
    gl.getParameter(gl.VENDOR),
    gl.getParameter(gl.RENDERER),
    debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    gl.getParameter(gl.VERSION),
    gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    gl.getParameter(gl.MAX_TEXTURE_SIZE),
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    (gl.getSupportedExtensions() || []).slice().sort()
  ]);
}

function canvasValue(win) {
  const canvas = win.document.createElement("canvas");
  canvas.width = CONTROL_SIZE;
  canvas.height = CONTROL_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return ctx ? paintControl(ctx, CONTROL_SIZE, CONTROL_FILL) : null;
}

async function readInWorker() {
  if (!window.Worker) return null;
  const source = `
    ${paintControl.toString()}
    ${webglValue.toString()}
    function read(fn) { try { return fn(); } catch (_) { return null; } }
    const hasOffscreen = typeof OffscreenCanvas !== "undefined";
    postMessage({
      canvas: hasOffscreen ? read(() => {
        const ctx = new OffscreenCanvas(${CONTROL_SIZE}, ${CONTROL_SIZE}).getContext("2d", { willReadFrequently: true });
        return ctx ? paintControl(ctx, ${CONTROL_SIZE}, ${JSON.stringify(CONTROL_FILL)}) : null;
      }) : null,
      webgl: hasOffscreen ? read(() => webglValue(new OffscreenCanvas(1, 1))) : null
    });
  `;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let worker = null;
  try {
    worker = new Worker(url);
    return await promiseWithTimeout(new Promise((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message || "Web Worker error"));
    }), WORKER_TIMEOUT_MS, "Stability worker timeout");
  } catch (_) {
    return null;
  } finally {
    worker?.terminate();
    URL.revokeObjectURL(url);
  }
}

// The same render the audio fingerprint uses: a triangle wave through a compressor.
async function audioValue(win) {
  const Ctx = win.OfflineAudioContext || win.webkitOfflineAudioContext;
  if (!Ctx) return null;
  const context = new Ctx(1, 5000, 44100);
  const oscillator = context.createOscillator();
  const compressor = context.createDynamicsCompressor();
  oscillator.type = "triangle";
  oscillator.frequency.value = 10000;
  compressor.threshold.value = -50;
  compressor.knee.value = 40;
  compressor.ratio.value = 12;
  compressor.attack.value = 0;
  compressor.release.value = 0.25;
  oscillator.connect(compressor);
  compressor.connect(context.destination);
  oscillator.start(0);
  const buffer = await promiseWithTimeout(context.startRendering(), 2000, "Audio render timeout");
  return Array.from(buffer.getChannelData(0).slice(4500, 5000), (value) => value.toFixed(8)).join(",");
}

// A constant signal renders to exactly AUDIO_CONSTANT in every frame. Anything else is added noise.
async function audioControlAltered(win) {
  try {
    const Ctx = win.OfflineAudioContext || win.webkitOfflineAudioContext;
    if (!Ctx) return null;
    const context = new Ctx(1, 128, 44100);
    if (!context.createConstantSource) return null;
    const source = context.createConstantSource();
    source.offset.value = AUDIO_CONSTANT;
    source.connect(context.destination);
    source.start(0);
    const buffer = await promiseWithTimeout(context.startRendering(), 2000, "Audio control timeout");
    return Array.prototype.some.call(buffer.getChannelData(0), (value) => value !== AUDIO_CONSTANT);
  } catch (_) {
    return null;
  }
}

const FONT_LIST = [
  "Arial", "Arial Black", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas", "Courier New",
  "Georgia", "Helvetica", "Impact", "Lucida Console", "Menlo", "Monaco", "Palatino", "Segoe UI",
  "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Wingdings", "Roboto", "Noto Sans", "San Francisco"
];

function fontsValue(win) {
  const ctx = win.document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  const text = "mmmmmmmmmmlliWW@@@12345";
  const widths = {};
  for (const base of ["monospace", "sans-serif", "serif"]) {
    ctx.font = `72px ${base}`;
    widths[base] = ctx.measureText(text).width;
  }
  return FONT_LIST.filter((font) => Object.keys(widths).some((base) => {
    ctx.font = `72px '${font}', ${base}`;
    return ctx.measureText(text).width !== widths[base];
  })).join("|");
}

// Voices often load after the page does. Wait for them first, so a list that is still filling in
// does not look like a value that changes on every read.
async function voicesReady(win) {
  const synth = win.speechSynthesis;
  if (!synth?.getVoices || synth.getVoices().length) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, VOICES_WAIT_MS);
    synth.addEventListener?.("voiceschanged", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function voicesValue(win) {
  const voices = win.speechSynthesis?.getVoices?.() || [];
  return voices.map((voice) => `${voice.name}|${voice.lang}`).join(";");
}
