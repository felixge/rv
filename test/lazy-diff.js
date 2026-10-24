// Full-stack lazy loading contracts, including delayed and failed file responses.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "rv-lazy-"));
const session = `lazy-${process.pid}`;
const git = async (...args) => (await exec("git", ["-C", root, ...args])).stdout.trim();
const browser = async (...args) => {
  const { stdout } = await exec("agent-browser", ["--session", session, "--json", ...args], { maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.success, true, stdout);
  return result.data;
};
const evaluate = async code => (await browser("eval", code)).result;
const wait = code => browser("wait", "--fn", `Boolean(${code})`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function capture(name) {
  if (!process.env.SCREENSHOTS) return;
  await mkdir(process.env.SCREENSHOTS, { recursive: true });
  await browser("screenshot", path.resolve(process.env.SCREENSHOTS, `${name}.png`));
}
const name = i => `many/${String(i).padStart(3, "0")}.ts`;
const source = (i, revision) => Array.from({ length: i === 79 ? 1 : 100 }, (_, line) =>
  `export const value${line} = "file ${i} ${line % 2 ? "context" : revision}${line === 0 && [10, 70].includes(i) && revision === "new" ? " needleOnly" : ""}";\n`,
).join("");
const heading = "document.querySelector('.diff-file-heading[data-current]')";
const pre = `${heading}?.closest('diffs-container')?.shadowRoot?.querySelector('pre')`;
const calls = [];
let active = 0, peak = 0, delay = 80, server;
let blocked;
const failures = new Set();
async function idle() {
  // The server can finish a pair before the browser receives it and starts
  // the next preload. A moment with no active requests is not yet idle.
  let quiet = 0;
  for (let i = 0; i < 100 && quiet < 6; i++) {
    const count = calls.length;
    await sleep(100);
    quiet = !active && calls.length === count ? quiet + 1 : 0;
  }
  assert.equal(quiet, 6, "File loading must reach sustained idle");
  assert.equal(active, 0, "File requests must settle");
  const count = calls.length;
  await sleep(600);
  assert.equal(calls.length, count, "Idle must not fetch the whole comparison");
}
async function shown(i, revision) {
  await wait(`${heading}?.dataset.path === ${JSON.stringify(name(i))} && ${pre}?.textContent.includes(${JSON.stringify(`file ${i} ${revision}`)}) && ${pre}?.querySelector('span[style]')`);
}
async function choose(i) {
  await browser("click", ".finder-trigger");
  await browser("fill", '[aria-label="Fuzzy find file"]', name(i));
  await wait(`document.querySelector('.finder-results .active .finder-path')?.textContent === ${JSON.stringify(name(i))}`);
  await browser("press", "Enter");
}
try {
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Lazy Diff Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await mkdir(path.join(root, "many"));
  for (let i = 0; i < 80; i++) await writeFile(path.join(root, name(i)), source(i, "old"));
  await git("add", ".");
  await git("commit", "-qm", "Old files");
  for (let i = 0; i < 80; i++) await writeFile(path.join(root, name(i)), source(i, "new"));
  await git("commit", "-qam", "New files");
  const target = await git("rev-parse", "HEAD");
  for (let i = 0; i < 80; i++) await writeFile(path.join(root, name(i)), source(i, "working"));
  const repo = await repository(root);
  server = createApp({ ...repo, file: async (name, ref) => {
    calls.push({ name, ref });
    peak = Math.max(peak, ++active);
    try {
      if (blocked && (!blocked.name || blocked.name === name)) await blocked.promise;
      await sleep(delay);
      if (failures.delete(`${name}:${ref}`)) throw new Error("Temporary file failure");
      return await repo.file(name, ref);
    } finally { active--; }
  } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await browser("open", `${url}/?mode=commit&to=${target}&path=${name(79)}`);
  await browser("set", "viewport", "1440", "900", "2");
  // A short last file must remain visible as preceding placeholders grow.
  await shown(79, "new");
  await idle();
  assert.ok(new Set(calls.map(call => call.name)).size < 30);
  assert.ok(peak <= 6, `At most six file requests, observed ${peak}`);
  await shown(79, "new");
  await capture("lazy-short-last-file");
  console.log(`PASS short last file stays visible; initial ${calls.length} requests, peak ${peak}; idle stops loading`);

  // Warm neighbors beyond the viewport, without letting a slow speculative
  // file occupy every slot needed by a distant selection.
  blocked = { name: name(42) };
  blocked.promise = new Promise(resolve => { blocked.release = resolve; });
  await choose(40);
  await shown(40, "new");
  for (let i = 0; i < 100 && !calls.some(call => call.name === name(42)); i++) await sleep(20);
  assert.ok(calls.some(call => call.name === name(42)), "The second neighbor must preload without scrolling");
  await choose(60);
  await shown(60, "new");
  assert.ok(active > 0, "Distant selection must finish while the neighbor is still held");
  blocked.release();
  blocked = undefined;
  await idle();
  console.log("PASS bounded neighbor look-ahead leaves capacity for distant foreground navigation");

  await choose(40);
  await shown(40, "new");
  await browser("find", "role", "link", "click", "--name", "Split", "--exact");
  await shown(40, "new");
  await browser("fill", '[aria-label="Find a file"]', "");
  await browser("focus", ".code-view");
  await browser("press", "j");
  await shown(41, "new");
  await browser("press", "k");
  await shown(40, "new");
  await browser("eval", "document.querySelector('.code-view').dispatchEvent(new WheelEvent('wheel', { bubbles: true })); document.querySelector('.code-view').scrollTop += 6000");
  await wait(`${heading}?.dataset.path !== ${JSON.stringify(name(40))} && ${pre}?.querySelector('span[style]')`);
  await idle();
  console.log("PASS distant selection, split, j/k and scrolling load highlighted files");

  delay = 250;
  await choose(0);
  await shown(0, "new");
  await idle();
  for (const cancel of ["close", "empty"]) {
    await browser("focus", ".code-view");
    await browser("press", "Control+f");
    await browser("fill", '[aria-label="Find in viewed file"]', "needleOnly");
    await wait("document.querySelector('.text-search span').textContent.startsWith('Searching ')");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('path')"), name(0),
      "Incomplete Find results must not move the selection");
    if (cancel === "close") await capture("lazy-find-loading");
    if (cancel === "close") await browser("press", "Escape");
    else await browser("fill", '[aria-label="Find in viewed file"]', "");
    await idle();
    assert.ok(new Set(calls.map(call => call.name)).size < 80, "Cancelled Find must stop unstarted search work");
  }
  await browser("press", "Escape");
  await choose(40);
  await shown(40, "new");
  await browser("press", "Control+f");
  await browser("fill", '[aria-label="Find in viewed file"]', "needleOnly");
  await wait("document.querySelector('.text-search span').textContent === '2/2'");
  assert.equal(new Set(calls.map(call => call.name)).size, 80, "Find must search every file");
  assert.equal(active, 0, "Find must not report completion while files are still loading");
  await shown(70, "new");
  await capture("lazy-find-complete");
  await browser("press", "Enter");
  await shown(10, "new");
  await wait("document.querySelector('.text-search span').textContent === '1/2'");
  await browser("press", "Escape");
  assert.ok(peak <= 6, `Find must share the request bound, observed ${peak}`);
  console.log("PASS cross-file Find completes from the selected file, wraps between matches, and cancels on close or empty query");

  // Hold old-scope responses while the user changes scopes. None may replace
  // the new comparison, and old requests must still count toward the bound.
  await browser("open", `${url}/?mode=commit&to=${target}&path=${name(0)}`);
  await shown(0, "new");
  await idle();
  blocked = {};
  blocked.promise = new Promise(resolve => { blocked.release = resolve; });
  await choose(60);
  for (let i = 0; i < 100 && !active; i++) await sleep(20);
  assert.ok(active > 0);
  await wait(`${heading}?.dataset.path === ${JSON.stringify(name(60))} && ${heading}?.textContent.includes('Loading…')`);
  await capture("lazy-file-loading");
  await browser("click", '[aria-label="Review scope"]');
  await browser("find", "role", "option", "click", "--name", "Uncommitted changes");
  await wait("!document.querySelector('.review-popover')");
  blocked.release();
  blocked = undefined;
  await shown(60, "working");
  await idle();
  await shown(60, "working");
  assert.ok(peak <= 6);
  console.log("PASS scope switch discards late historical responses without exceeding the request bound");

  failures.add(`${name(30)}:`);
  await choose(30);
  await browser("wait", '[aria-label="Retry loading many/030.ts"]');
  await choose(31);
  await shown(31, "working");
  await choose(30);
  await idle();
  await capture("lazy-retry");
  await browser("click", '[aria-label="Retry loading many/030.ts"]');
  await shown(30, "working");
  await idle();
  failures.add(`${name(20)}:`);
  await browser("focus", ".code-view");
  await browser("press", "Control+f");
  await browser("fill", '[aria-label="Find in viewed file"]', "file 31 working");
  await wait("document.querySelector('.text-search span').textContent.includes('1 files could not be searched')");
  await choose(20);
  await idle();
  await browser("click", '[aria-label="Retry loading many/020.ts"]');
  await wait("document.querySelector('.text-search span').textContent === '1/50'");
  await shown(31, "working");
  await browser("press", "Escape");
  assert.equal((await browser("errors")).errors.length, 0);
  assert.ok(peak <= 6);
  console.log("PASS per-file retry and Find report failures honestly, recover, and leave unrelated files usable; no browser errors");
} catch (error) {
  console.error(await evaluate(`({ url: location.href, selected: ${heading}?.dataset.path, headers: [...document.querySelectorAll('.diff-file-heading')].map(h => ({path:h.dataset.path, top:h.getBoundingClientRect().top})), text: document.body.innerText })`).catch(() => null));
  console.error({ active, peak, calls: calls.slice(-20) });
  throw error;
} finally {
  blocked?.release();
  await browser("close").catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
