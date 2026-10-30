// Run after npm run build. Requires agent-browser and its Chromium installation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";
import { fixture } from "./fixture.js";

const exec = promisify(execFile);
const session = `rv-commit-navigation-${process.pid}`;
const f = await fixture();
const server = createApp(await repository(f.root));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = async (...args) => {
  const { stdout } = await exec("agent-browser", ["--session", session, "--json", ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  assert.equal(response.success, true, stdout);
  return response.data;
};
const evaluate = async (code) => (await browser("eval", code)).result;
const wait = (code) => browser("wait", "--fn", `Boolean(${code})`);
const current = () => evaluate("document.querySelector('.review-trigger strong')?.textContent");
const compareRequests = () => evaluate("performance.getEntriesByType('resource').filter(e => e.name.includes('/api/compare?')).length");
const rendered = (subject) => wait(`document.querySelector('.review-trigger strong')?.textContent === ${JSON.stringify(subject)} &&
  [...document.querySelectorAll('diffs-container')].some(c => c.shadowRoot?.querySelector('pre')?.textContent.includes(${JSON.stringify(subject)}))`);
async function open(scope, subject) {
  await browser("open", `${url}/?${scope}`);
  await wait("document.querySelector('.file-tree') && !document.querySelector('.loading')");
  if (subject) await rendered(subject);
}
async function unchanged(...keys) {
  const before = await evaluate("location.href");
  const requests = await compareRequests();
  for (const key of keys) await browser("press", key);
  await evaluate("new Promise(resolve => setTimeout(resolve, 150))");
  assert.equal(await evaluate("location.href"), before);
  assert.equal(await compareRequests(), requests);
}

try {
  const first = "Add shipping calculator";
  const second = "Add international shipping rates";
  const third = "Introduce free shipping threshold";
  await open(`mode=commit&to=${f.second}`, second);
  assert.equal(await evaluate("performance.getEntriesByType('resource').some(e => e.name.includes('/api/commits?'))"), false);
  await browser("press", "p");
  await rendered(first);
  await unchanged("p");
  await browser("press", "n");
  await rendered(second);
  assert.equal(await evaluate("new URLSearchParams(location.search).get('to')"), "HEAD~1");
  await browser("press", "n");
  await rendered(third);
  await unchanged("n");
  assert.equal(await evaluate("performance.getEntriesByType('resource').filter(e => e.name.includes('/api/commits?')).length"), 1);
  await browser("back");
  await rendered(second);
  await browser("forward");
  await rendered(third);
  await browser("reload");
  await rendered(third);
  console.log("PASS P/N navigate older/newer commits without opening Review; stop at boundaries; URLs, history and reload work");

  await browser("fill", '[aria-label="Find a file"]', "");
  await unchanged("p", "n");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Find a file\"]').value"), "pn");
  await browser("fill", '[aria-label="Find a file"]', "");
  await browser("focus", '[aria-label="Review scope"]');
  await browser("press", "?");
  await browser("fill", '[aria-label="Search commands and keyboard shortcuts"]', "commit");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.shortcut-row')].map(e => e.textContent.trim())"), [
    "Review most recent commitNavigateGC", "Next commit (newer)NavigateN", "Previous commit (older)NavigateP",
    "Review uncommitted changesNavigateGU",
  ]);
  await browser("find", "role", "option", "click", "--name", "Previous commit (older)");
  await rendered(second);
  await browser("press", "?");
  await browser("fill", '[aria-label="Search commands and keyboard shortcuts"]', "np");
  await unchanged("p", "n");
  await browser("fill", '[aria-label="Search commands and keyboard shortcuts"]', "preview");
  assert.equal(await evaluate("document.querySelectorAll('.shortcut-row').length"), 0);
  await browser("press", "Escape");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Preview')"), false);
  await browser("fill", "#general-comment-text", "Keep this review feedback.");
  await browser("find", "role", "button", "click", "--name", "Add general comment", "--exact");
  await browser("press", "Escape");
  await browser("press", "y");
  await browser("wait", ".copied-prompt-dialog");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Copied prompt\"]').value"), "Keep this review feedback.");
  await unchanged("p", "n");
  await browser("find", "role", "button", "click", "--name", "Keep Comments", "--exact");
  console.log("PASS Y copies and shows the full prompt; the standalone preview button and command are gone");

  await evaluate(`(() => {
    window.originalExecCommand = document.execCommand;
    window.originalWriteText = navigator.clipboard.writeText;
    document.execCommand = () => false;
    navigator.clipboard.writeText = () => Promise.reject(new Error('Clipboard blocked'));
  })()`);
  await browser("press", "y");
  await browser("wait", '[aria-label="Manual copy"]');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Prompt text\"]').value"), "Keep this review feedback.");
  assert.equal(await evaluate("document.querySelector('.prompt-dialog h2').textContent"), "Copy prompt manually");
  assert.equal(await evaluate("[...document.querySelectorAll('.prompt-dialog button')].some(b => b.textContent.trim() === 'Clear')"), false);
  await evaluate(`(() => {
    document.execCommand = window.originalExecCommand;
    navigator.clipboard.writeText = window.originalWriteText;
    delete window.originalExecCommand;
    delete window.originalWriteText;
  })()`);
  await browser("find", "role", "button", "click", "--name", "Try again", "--exact");
  await browser("wait", ".copied-prompt-dialog");
  await browser("find", "role", "button", "click", "--name", "Keep Comments", "--exact");
  await browser("press", "p");
  await rendered(first);
  assert.equal(await evaluate("Boolean(document.querySelector('.prompt-dialog'))"), false);
  assert.equal(await evaluate("document.querySelector('.comment p').textContent"), "Keep this review feedback.");
  console.log("PASS clipboard failures allow manual copy and retry without offering Clear; P navigates, not previews, and preserves comments");

  for (const scope of ["mode=files", "mode=working", `mode=range&from=${f.first}&to=${f.third}`]) {
    await open(scope);
    await unchanged("p", "n");
  }
  const custom = f.git("commit-tree", "HEAD^{tree}", "-p", f.first, "-m", "Custom commit");
  await open(`mode=commit&to=${custom}`, "Custom commit");
  await unchanged("p", "n");
  console.log("PASS other scopes and commits outside recent history remain unchanged");

  await open(`mode=commit&to=${f.second}`, second);
  await evaluate(`(() => {
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]).startsWith('/api/commits?')) {
        await new Promise(resolve => { window.releaseCommits = resolve; });
      }
      return fetch(...args);
    };
  })()`);
  await browser("press", "p");
  await wait("window.releaseCommits");
  await browser("press", "g");
  await browser("press", "u");
  await wait("document.querySelector('.review-trigger strong')?.textContent === 'Uncommitted changes'");
  await evaluate("window.releaseCommits()");
  await wait("performance.getEntriesByType('resource').some(e => e.name.includes('/api/commits?'))");
  assert.equal(await current(), "Uncommitted changes");
  assert.equal((await browser("errors")).errors?.length || 0, 0);
  console.log("PASS a delayed commit-list response cannot overwrite a newer review scope");
} finally {
  await browser("close").catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await f.cleanup();
}
