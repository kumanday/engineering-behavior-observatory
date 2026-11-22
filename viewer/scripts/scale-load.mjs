// Scale check for the viewer: opens a served bundle in Chrome (headless unless HEADED=1), waits until the viewer is
// ready, and reports load time, WebGPU support, the cloud's row count and the browser's peak memory.
// Needs a served bundle (`ebo atlas serve --bundle <dir>`) and Playwright with an installed Chrome (channel "chrome").
// Usage: node scripts/scale-load.mjs [url]   Env: HEADED=1, TIMEOUT_MS (default 30 minutes).
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:13012/";
const browser = await chromium.launch({ channel: process.env.CHANNEL ?? "chrome", headless: !process.env.HEADED,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--js-flags=--max-old-space-size=16384"] });
// Peak resident memory of the whole browser: every process started with Playwright's temporary profile, sampled every
// half second.
let peak = 0;
const browserMemory = () => execFileSync("ps", ["-axww", "-o", "rss=,command="], { encoding: "utf8" }).split("\n")
  .filter((line) => line.includes("playwright_chromiumdev_profile")).reduce((sum, line) => sum + Number(line.trim().split(/\s+/u)[0]) * 1024, 0);
const sampler = setInterval(() => { try { peak = Math.max(peak, browserMemory()); } catch { /* ps unavailable */ } }, 500);
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  const started = Date.now();
  await page.goto(url);
  const gpu = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    return { available: Boolean(adapter), shaderF16: adapter?.features.has("shader-f16") ?? false };
  });
  const state = await page.waitForFunction(() => document.body.dataset.eboReady === "1" || document.querySelector(".status.error") ? (document.body.dataset.eboReady ?? "error") : null,
    null, { timeout: Number(process.env.TIMEOUT_MS ?? 30 * 60_000), polling: 1000 }).then((h) => h.jsonValue()).catch((e) => `timeout: ${e.message}`);
  const seconds = (Date.now() - started) / 1000;
  const status = await page.evaluate(() => document.getElementById("status")?.textContent ?? null);
  const units = state === "1" ? await page.evaluate(async () => (await window.ebo.describe()).bundle?.data?.units ?? null) : null;
  // The panels' first queries over the whole cloud: clusters by arm, one task's swimlanes, the matrix.
  const panels = state === "1" ? await page.evaluate(async () => {
    const timed = async (run) => { const t = performance.now(); const summary = await run(); return { seconds: Number(((performance.now() - t) / 1000).toFixed(2)), summary: String(summary).slice(0, 160) }; };
    return {
      clusters: await timed(async () => { await window.ebo.run("openTab", { tab: "clusters" }); return (await window.ebo.describe()).clusters?.summary; }),
      lanes: await timed(async () => { await window.ebo.run("openTab", { tab: "lanes" }); return (await window.ebo.describe()).lanes?.summary; }),
      assessments: await timed(async () => { await window.ebo.run("openTab", { tab: "assessments" }); return (await window.ebo.describe()).assessments?.summary; }),
    };
  }).catch((e) => ({ error: e.message })) : null;
  console.log(JSON.stringify({ url, ready: state === "1", state, status, seconds, units, gpu, panels, peakBrowserMemoryGB: Number((peak / 1e9).toFixed(2)), errors: errors.slice(0, 5) }, null, 1));
} finally {
  clearInterval(sampler);
  await browser.close();
}
