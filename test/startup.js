// Run after npm run build. Measures navigation-to-UI and syntax-highlighted code
// on a 10 Mbps / 40 ms connection, with cold and warm browser caches.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../server/http.js";
import { repository } from "../server/repository.js";
import { fixture } from "./fixture.js";

const exec = promisify(execFile);
const session = `startup-${process.pid}`;
const browser = async (...args) => {
  const { stdout } = await exec("agent-browser", ["--session", session, "--json", ...args]);
  const response = JSON.parse(stdout);
  assert.equal(response.success, true, stdout);
  return response.data;
};
const evaluate = async (code) => (await browser("eval", code)).result;
const f = await fixture();
const server = createApp(await repository(f.root));
let socket;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await browser("open", "about:blank");
  await browser("set", "viewport", "1280", "720", "2");
  // Use Chromium's network emulation; browser interactions still go through
  // agent-browser. No Playwright dependency or wall-clock CLI timing involved.
  const { stdout } = await exec("agent-browser", ["--session", session, "get", "cdp-url"]);
  socket = new WebSocket(stdout.trim());
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetInfos } = await cdp("Target.getTargets");
  const { sessionId } = await cdp("Target.attachToTarget", {
    targetId: targetInfos.find(target => target.type === "page" && target.url === "about:blank").targetId,
    flatten: true,
  });
  const page = (method, params) => cdp(method, params, sessionId);
  await page("Page.enable");
  await page("Network.enable");
  await page("Network.emulateNetworkConditions", {
    offline: false, latency: 40,
    downloadThroughput: 10 * 1000 * 1000 / 8,
    uploadThroughput: 10 * 1000 * 1000 / 8,
  });
  await page("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.startup = {};
    function measure() {
      if (!startup.ui && document.querySelector('[aria-label="Find a file"]'))
        startup.ui = performance.now();
      const pre = document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
      if (pre?.textContent.includes('percent / 100') && pre.querySelector('span[style]'))
        startup.highlighted = performance.now();
      else requestAnimationFrame(measure);
    }
    requestAnimationFrame(measure);
  ` });
  const samples = [];
  for (const cache of ["cold", "warm", "reload"]) {
    if (cache === "cold") await page("Network.clearBrowserCache");
    if (cache === "reload") await browser("reload");
    else await browser("open", `http://127.0.0.1:${server.address().port}/?mode=working`);
    await browser("wait", "--fn", "Boolean(window.startup.highlighted)");
    const result = await evaluate(`({
      ...startup,
      assetBytes: performance.getEntriesByType('resource')
        .filter(e => e.name.includes('/assets/')).reduce((n, e) => n + e.transferSize, 0),
      errors: document.querySelector('[role=alert]')?.textContent || '',
    })`);
    assert.equal(result.errors, "");
    samples.push(result);
    console.log(`${cache}: UI ${Math.round(result.ui)} ms; highlighted diff ${Math.round(result.highlighted)} ms; assets ${result.assetBytes} bytes`);
    assert.equal((await browser("errors")).errors.length, 0);
    if (cache === "cold") await browser("open", "about:blank");
  }
  // Budgets catch uncompressed entrypoints and no-store on hashed assets.
  assert.ok(samples[0].assetBytes < 500_000, "Cold startup assets must be compressed");
  assert.ok(samples[0].ui < 1200, "Cold UI must appear within 1.2 seconds at 10 Mbps");
  assert.ok(samples[0].highlighted < 1600, "Cold highlighted diff must appear within 1.6 seconds");
  for (const sample of samples.slice(1)) {
    assert.ok(sample.assetBytes < 10_000, "Repeat loads must reuse cached assets");
    assert.ok(sample.ui < 600, "Warm UI must appear within 600 ms");
    assert.ok(sample.highlighted < 900, "Warm highlighted diff must appear within 900 ms");
  }
  console.log("PASS cold, warm and reload startup budgets, with syntax-highlighted diff");
} catch (error) {
  console.error(await evaluate(`({ startup: window.startup, text: document.body.innerText,
    code: document.querySelector('diffs-container')?.shadowRoot?.innerHTML.slice(-4000) })`));
  console.error(await browser("errors"));
  throw error;
} finally {
  socket?.close();
  await browser("close").catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await f.cleanup();
}
