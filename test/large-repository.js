// Opt-in full-stack benchmark: npm run build && node test/large-repository.js
// RV_BENCH_ROOT reuses a fixture (or a real Git checkout with 20 modified text
// files) for before/after runs. Existing checkouts are never modified here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";

const exec = promisify(execFile);
const root = process.env.RV_BENCH_ROOT || await mkdtemp(path.join(tmpdir(), "rv-large-"));
const session = `large-${process.pid}`;
const git = (...args) => exec("git", ["-C", root, ...args]);
const browser = async (...args) => {
  const { stdout } = await exec("agent-browser", ["--session", session, "--json", ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  assert.equal(response.success, true, stdout);
  return response.data;
};
const evaluate = async (code) => (await browser("eval", code)).result;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const count = 100_000;
const filename = (i) => `packages/pkg-${String(Math.floor(i / 1000)).padStart(3, "0")}/file-${String(i).padStart(6, "0")}.ts`;
const source = (i, changed = false) =>
  `export const value = ${i + (changed ? 1 : 0)};\n` +
  Array.from({ length: 100 }, (_, n) => `// Module ${i}: documented behavior for case ${n}.\n`).join("");
let server;
try {
  if (!process.env.RV_BENCH_ROOT) {
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Large Repository Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "commit.gpgsign", "false");
    for (let start = 0; start < count; start += 1000) {
      await mkdir(path.dirname(path.join(root, filename(start))), { recursive: true });
      for (let i = start; i < start + 1000; i++)
        await writeFile(path.join(root, filename(i)), source(i));
    }
    await git("add", ".");
    await git("commit", "-qm", "100,000 source files");
    for (let i = 0; i < 20; i++)
      await writeFile(path.join(root, filename(i)), source(i, true));
  }
  const { stdout: tracked } = await exec("git", ["-C", root, "ls-files", "-z"], { maxBuffer: Infinity });
  const expectedFiles = tracked.split("\0").filter(Boolean).length;
  console.log(`Fixture: ${root}; ${expectedFiles} tracked files, 20 modified files; ${process.version}`);
  const repo = await repository(root);
  server = createApp(repo);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (route) => {
    const start = performance.now();
    const response = await fetch(`${url}/api/${route}`, { headers: { "X-Rv": "1" } });
    assert.equal(response.status, 200);
    return { data: await response.json(), ms: performance.now() - start };
  };
  const samples = [];
  let selected;
  for (let run = 0; run < 3; run++) {
    const info = await request("info");
    assert.equal(info.data.files.length, expectedFiles);
    assert.equal(info.data.working.entries.length, 20);
    selected = info.data.working.entries[0].path;
    const start = performance.now();
    await Promise.all(info.data.working.entries.map(async (entry) => {
      const query = new URLSearchParams({ path: entry.path, ref: info.data.working.base });
      const old = await request(`file?${query}`);
      query.set("ref", "");
      const current = await request(`file?${query}`);
      assert.notEqual(old.data.contents, current.data.contents);
      assert.ok(old.data.contents.length > 0);
      assert.ok(current.data.contents.length > 0);
    }));
    samples.push({ info: info.ms, diffFiles: performance.now() - start });
    console.log(`API run ${run + 1}: ${JSON.stringify(samples.at(-1))}`);
  }
  // Broad budgets catch an accidental full-checkout content scan, without
  // depending on frame-time differences or a warm browser cache.
  assert.ok(median(samples.map(s => s.info)) < 2500, "Repository metadata must not wait for a full content scan (2.5 s budget)");
  await browser("open", "about:blank");
  await browser("set", "viewport", "1440", "900", "2");
  // Measure in-page time, not the browser CLI's process startup overhead.
  const { stdout } = await exec("agent-browser", ["--session", session, "get", "cdp-url"]);
  const socket = new WebSocket(stdout.trim());
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
  try {
    const { targetInfos } = await cdp("Target.getTargets");
    const { sessionId } = await cdp("Target.attachToTarget", {
      targetId: targetInfos.find(target => target.type === "page" && target.url === "about:blank").targetId, flatten: true,
    });
    await cdp("Page.enable", {}, sessionId);
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.timings = {};
      function measure() {
        if (!timings.ui && document.querySelector('[aria-label="Find a file"]')) timings.ui = performance.now();
        const pre = document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
        if (pre?.textContent.length > 20 && pre.querySelector('span[style]')) timings.code = performance.now();
        else requestAnimationFrame(measure);
      }
      requestAnimationFrame(measure);
    ` }, sessionId);
    for (const mode of ["working", "files"]) {
      const runs = [];
      for (let run = 0; run < 3; run++) {
        await browser("open", `${url}/?mode=${mode}&path=${encodeURIComponent(selected)}`);
        await browser("wait", "--fn", "Boolean(window.timings.code)", "--timeout", "120000");
        const timings = await evaluate("window.timings");
        runs.push(timings);
        assert.equal((await browser("errors")).errors.length, 0);
        console.log(`${mode} browser run ${run + 1}: ${JSON.stringify(timings)}`);
      }
      console.log(`${mode} browser median: UI ${Math.round(median(runs.map(r => r.ui)))} ms; highlighted code ${Math.round(median(runs.map(r => r.code)))} ms`);
      assert.ok(median(runs.map(r => r.code)) < 5000, `${mode} highlighted code exceeds the 5 s budget`);
    }
  } finally {
    socket.close();
  }
  console.log(`API median: info ${Math.round(median(samples.map(s => s.info)))} ms; 20 diff file pairs ${Math.round(median(samples.map(s => s.diffFiles)))} ms`);
  console.log("PASS large-repository metadata and highlighted-code budgets");
} finally {
  await browser("close").catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (!process.env.RV_BENCH_ROOT && !process.env.RV_BENCH_KEEP) await rm(root, { recursive: true, force: true });
}
