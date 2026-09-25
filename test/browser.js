// Run after npm run build. Requires agent-browser and its Chromium installation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";
import { loadState, saveState } from "../server/state.js";
import { fixture } from "./fixture.js";

const exec = promisify(execFile);
const session = (
  await exec("agent-browser", [
    "session",
    "id",
    "--scope",
    "worktree",
    "--prefix",
    "rv-test",
  ])
).stdout.trim();
const rvRoot = path.resolve(import.meta.dirname, "..");
let rvVersion;
try {
  rvVersion = (
    await exec("git", ["-C", rvRoot, "describe", "--tags", "--exact-match", "HEAD"])
  ).stdout.trim();
} catch {
  rvVersion = (
    await exec("git", ["-C", rvRoot, "rev-parse", "--short", "HEAD"])
  ).stdout.trim();
}
const f = await fixture();
const server = createApp(await repository(f.root));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
// The app persists state to the cache file debounced; poll it from Node.
async function waitState(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await loadState(f.root);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Expected review state was never saved to the disk cache.");
}
const browser = async (...args) => {
  const { stdout } = await exec(
    "agent-browser",
    ["--session", session, "--json", ...args],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const response = JSON.parse(stdout);
  assert.equal(response.success, true, stdout);
  return response.data;
};
const evaluate = async (code) => (await browser("eval", code)).result;
const wait = (code) => browser("wait", "--fn", `Boolean(${code})`);
const click = (name) =>
  browser("find", "role", "button", "click", "--name", name, "--exact");
const tree = (name) =>
  browser("find", "role", "treeitem", "click", "--name", name, "--exact");
async function reviewScope(name) {
  if (!await evaluate("Boolean(document.querySelector('.review-popover'))"))
    await click("Review scope");
  if (await evaluate("Boolean(document.querySelector('.review-range'))"))
    await click("← Review scopes");
  await browser("find", "role", "option", "click", "--name", name);
}
async function reviewCommit(query) {
  if (!await evaluate("Boolean(document.querySelector('.review-popover'))"))
    await click("Review scope");
  if (await evaluate("Boolean(document.querySelector('.review-range'))"))
    await click("← Review scopes");
  await browser("fill", '[aria-label="Search review scopes"]', query);
  await browser("press", "Enter");
}
async function reviewRange() {
  if (await evaluate("Boolean(document.querySelector('.review-range'))")) return;
  await click("Review scope");
  if (!await evaluate("Boolean(document.querySelector('.review-range'))"))
    await browser("find", "role", "option", "click", "--name", "Compare a range");
}
async function hoverTree(name, section = "Unreviewed") {
  const item = `document.querySelector('section[aria-label="${section}"] file-tree-container')?.shadowRoot?.querySelector('[role=treeitem][aria-label=${JSON.stringify(name)}]')`;
  await wait(item);
  const point = await evaluate(`(() => {
    const rect = ${item}.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  await browser("mouse", "move", String(point.x), String(point.y));
}
const shadow = "document.querySelector('diffs-container')?.shadowRoot";
const lineStats = (section = "Unreviewed") =>
  evaluate(
    section === "Unreviewed"
      ? "document.querySelector('.sidebar-header .line-stats')?.getAttribute('aria-label')"
      : `document.querySelector('section[aria-label="${section}"] .line-stats')?.getAttribute('aria-label')`,
  );
async function resizePanel(side, delta) {
  const point = await evaluate(
    `(() => { const r = document.querySelector('.resize-handle.${side}').getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 100)}; })()`,
  );
  await browser("mouse", "move", String(point.x), String(point.y));
  await browser("mouse", "down", "left");
  await browser("mouse", "move", String(point.x + delta), String(point.y + 30));
  await browser("mouse", "up", "left");
}
async function line(number, type = "", end = number) {
  const selector = `[data-column-number="${number}"]${type ? `[data-line-type="${type}"]` : ""}`;
  await wait(`${shadow}?.querySelector(${JSON.stringify(selector)})`);
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const point = await evaluate(
    `(() => { const r = ${shadow}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await browser(
    "mouse",
    "move",
    String(Math.round(point.x)),
    String(Math.round(point.y)),
  );
  await browser("mouse", "down", "left");
  if (end !== number) {
    const endSelector = `[data-column-number="${end}"]${type ? `[data-line-type="${type}"]` : ""}`;
    const point = await evaluate(
      `(() => { const r = ${shadow}.querySelector(${JSON.stringify(endSelector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    await browser("mouse", "move", String(point.x), String(point.y));
  }
  await browser("mouse", "up", "left");
  await browser("wait", "#comment-text");
}
const codeText = () => evaluate(`${shadow}?.querySelector('pre')?.textContent`);
const highlightedLines = () =>
  evaluate(
    `Array.from(new Set(Array.from(${shadow}.querySelectorAll('[data-column-number][data-selected-line]')).map(e => Number(e.dataset.columnNumber))))`,
  );
async function activeSearchHighlight() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await evaluate(`(() => {
      const ranges = Array.from(CSS.highlights.get('rv-text-search') || []);
      if (ranges.length !== 1) return null;
      const range = ranges[0];
      const line = range.startContainer.parentElement.closest('[data-line]');
      if (!line?.isConnected) return null;
      return {
        text: range.toString(),
        line: Number(line.dataset.line),
        side: line.closest('[data-additions]') ? 'additions' :
          line.closest('[data-deletions]') ? 'deletions' :
          line.dataset.lineType?.includes('addition') ? 'additions' :
          line.dataset.lineType?.includes('deletion') ? 'deletions' : undefined,
        acrossTokens: range.startContainer.parentElement !== range.endContainer.parentElement,
        left: Math.round(range.getBoundingClientRect().left),
      };
    })()`);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Expected one connected occurrence search highlight");
}
const otherSearchHighlights = () =>
  evaluate(`Array.from(CSS.highlights.get('rv-text-search-matches') || [])
    .filter(range => range.startContainer.isConnected)
    .map(range => ({ text: range.toString(), left: Math.round(range.getBoundingClientRect().left) }))`);
async function selectCodeText(text, occurrence = 0) {
  const points = await evaluate(`(() => {
    const root = ${shadow};
    const matches = [];
    for (const line of root.querySelectorAll('[data-line]')) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        let start = node.data.indexOf(${JSON.stringify(text)});
        while (start !== -1) {
          matches.push({ node, start });
          start = node.data.indexOf(${JSON.stringify(text)}, start + 1);
        }
      }
    }
    const match = matches[${occurrence}];
    if (!match) throw new Error('Could not select code text');
    const firstCharacter = document.createRange();
    firstCharacter.setStart(match.node, match.start);
    firstCharacter.setEnd(match.node, match.start + 1);
    const selectedText = document.createRange();
    selectedText.setStart(match.node, match.start);
    selectedText.setEnd(match.node, match.start + ${JSON.stringify(text)}.length);
    const start = firstCharacter.getBoundingClientRect();
    const end = selectedText.getBoundingClientRect();
    return {
      startX: Math.round(start.left + 1),
      endX: Math.round(end.right - 1),
      y: Math.round(end.top + end.height / 2),
    };
  })()`);
  await browser("mouse", "move", String(points.startX), String(points.y));
  await browser("mouse", "down", "left");
  await browser("mouse", "move", String(points.endX), String(points.y));
  await browser("mouse", "up", "left");
}
async function expectHintAfter(number, text) {
  assert.equal(
    await evaluate(`(() => {
    const hint = Array.from(document.querySelectorAll('.comment-marker')).find(e => e.textContent.includes(${JSON.stringify(text)}));
    const last = ${shadow}.querySelector('[data-column-number="${number}"]');
    const next = ${shadow}.querySelector('[data-column-number="${number + 1}"]');
    if (!hint || !last || !next) return false;
    const rect = hint.getBoundingClientRect();
    return rect.height > 0 && rect.top >= last.getBoundingClientRect().bottom - 1 && rect.bottom <= next.getBoundingClientRect().top + 1;
  })()`),
    true,
    `Comment hint must sit between lines ${number} and ${number + 1}`,
  );
}
const comments = () =>
  evaluate(
    "Array.from(document.querySelectorAll('.comment')).map(e => ({ reference: e.querySelector('code').textContent, text: e.querySelector('p')?.textContent }))",
  );
async function capture(name) {
  if (!process.env.SCREENSHOTS) return;
  const directory = path.resolve(process.env.SCREENSHOTS);
  await mkdir(directory, { recursive: true });
  await browser("screenshot", path.join(directory, `${name}.png`));
}

try {
  // A killed or timed-out previous run may not have reached finally. Start from
  // a fresh browser instead of inheriting that session's page and input state.
  await browser("close").catch(() => {});
  await browser("open", url);
  await browser("set", "viewport", "1440", "900", "2");
  await wait("document.querySelector('.file-tree')");

  // A modified click opens the exact file/scope without navigating its source.
  // Check actual tabs and rendered contents, not just a mocked window.open.
  const originalTab = (await browser("tab", "list")).tabs[0].tabId;
  for (const [scope, gesture, expectedText] of [
    ["mode=files&path=README.md", "Meta", "THRESHOLD = 75"],
    ["mode=working&path=README.md", "Control", "THRESHOLD = 75"],
    [`mode=commit&to=${f.second}`, "middle", "const baseRate = 5"],
    [`mode=range&from=${f.first}&to=${f.third}`, "Meta", "THRESHOLD = 100"],
  ]) {
    await browser("open", `${url}/?${scope}`);
    await wait("document.querySelector('.file-tree') && !document.querySelector('.loading')");
    await hoverTree("shipping.ts");
    const originalURL = await evaluate("location.href");
    const originalPath = await evaluate("document.querySelector('.file-path').textContent");
    if (gesture === "middle") {
      await browser("mouse", "down", "middle");
      await browser("mouse", "up", "middle");
    } else {
      // agent-browser's mouse commands do not carry held keyboard modifiers.
      // Dispatch the modified event through the real tree, without mocking open.
      await evaluate(`document.querySelector('file-tree-container').shadowRoot
        .querySelector('[data-item-path="src/shipping.ts"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true,
          cancelable: true, ${gesture === "Meta" ? "metaKey" : "ctrlKey"}: true }))`);
    }
    const tabs = (await browser("tab", "list")).tabs;
    assert.equal(tabs.length, 2, `${gesture}-click should open one tab`);
    const opened = tabs.find((tab) => tab.tabId !== originalTab);
    await browser("tab", opened.tabId);
    await wait(`${shadow}?.querySelector('pre')?.textContent.includes(${JSON.stringify(expectedText)})`);
    assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('mode')"), new URLSearchParams(scope).get("mode"));
    await browser("reload");
    await wait(`${shadow}?.querySelector('pre')?.textContent.includes(${JSON.stringify(expectedText)})`);
    const headerHref = await evaluate("document.querySelector('a.file-path').href");
    assert.equal(headerHref, await evaluate("location.href"));
    await browser("click", "a.file-path", "--new-tab");
    const headerTabs = (await browser("tab", "list")).tabs;
    assert.equal(headerTabs.length, 3);
    const headerTab = headerTabs.find((tab) => tab.tabId !== originalTab && tab.tabId !== opened.tabId);
    await browser("tab", headerTab.tabId);
    await wait(`${shadow}?.querySelector('pre')?.textContent.includes(${JSON.stringify(expectedText)})`);
    assert.equal(await evaluate("location.href"), headerHref);
    await browser("tab", "close", headerTab.tabId);
    await browser("tab", "close", opened.tabId);
    await browser("tab", originalTab);
    assert.equal(await evaluate("location.href"), originalURL);
    assert.equal(await evaluate("document.querySelector('.file-path').textContent"), originalPath);
  }
  await browser("open", `${url}/?mode=files&path=README.md`);
  await wait("document.querySelector('.file-tree')");
  await tree("shipping.ts");
  await wait("new URLSearchParams(location.search).get('path') === 'src/shipping.ts'");
  await browser("back");
  await wait("document.querySelector('.file-path')?.textContent === 'README.md'");
  await browser("forward");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`);
  await browser("press", "f");
  await browser("wait", ".finder-results a");
  const finderHref = await evaluate("Array.from(document.querySelectorAll('.finder-results a')).find(a => a.textContent.includes('README.md')).href");
  assert.equal(new URL(finderHref).searchParams.get("path"), "README.md");
  assert.equal(new URL(finderHref).searchParams.get("mode"), "files");
  await browser("click", '.finder-results a[href*="README.md"]', "--new-tab");
  const finderTab = (await browser("tab", "list")).tabs.find((tab) => tab.tabId !== originalTab);
  await browser("tab", finderTab.tabId);
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('A small, predictable shipping calculator.')`);
  await browser("tab", "close", finderTab.tabId);
  await browser("tab", originalTab);
  await browser("open", url);
  await wait("document.querySelector('.file-tree')");
  assert.equal(await evaluate("document.querySelector('.file-path').hasAttribute('href')"), false);
  console.log("PASS Cmd/Ctrl/middle-click preserves the source tab; new tabs and reload retain files, working/commit/range scopes; Back/Forward, finder and viewer header links work");

  await browser("open", `${url}/?mode=commit&to=${f.second}&path=src%2Fshipping.ts`);
  await wait(`${shadow}?.querySelector('[data-line-type="change-deletion"]')`);
  assert.equal(
    await evaluate("document.querySelector('.file-diff-stats')?.getAttribute('aria-label')"),
    "1 lines added, 1 lines removed",
  );
  await browser("click", '[aria-label="View old"]');
  assert.equal(await evaluate("Boolean(document.querySelector('.file-diff-stats'))"), false);
  const modeSourceURL = await evaluate("location.href");
  for (const mode of ["diff", "new", "old"]) {
    const selector = `[aria-label="View ${mode}"]`;
    // Modified primary clicks must reach the browser's native link handling.
    // Cancel at document only after observing the app's handler, so this also
    // catches regressions where a modifier switches the source tab's mode.
    for (const modifier of ["metaKey", "ctrlKey"]) {
      assert.equal(await evaluate(`(() => {
        let prevented;
        document.addEventListener('click', event => {
          prevented = event.defaultPrevented;
          event.preventDefault();
        }, { once: true });
        document.querySelector(${JSON.stringify(selector)}).dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, ${modifier}: true }));
        return prevented;
      })()`), false);
    }
    await browser("hover", selector);
    await browser("mouse", "down", "middle");
    await browser("mouse", "up", "middle");
    const tabs = (await browser("tab", "list")).tabs;
    assert.equal(tabs.length, 2);
    const modeTab = tabs.find((tab) => tab.tabId !== originalTab);
    await browser("tab", modeTab.tabId);
    await wait(`${shadow}?.querySelector('pre')`);
    assert.equal(await evaluate("new URLSearchParams(location.search).get('view')"), mode);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-current')`), "true");
    assert.equal(await evaluate("new URLSearchParams(location.search).get('to')"), "HEAD~1");
    assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
    await browser("tab", "close", modeTab.tabId);
    await browser("tab", originalTab);
    assert.equal(await evaluate("location.href"), modeSourceURL);
    assert.equal(await evaluate("document.querySelector('[aria-label=\"View old\"]').getAttribute('aria-current')"), "true");
  }
  console.log("PASS Diff/Old/New links allow Cmd/Ctrl-click defaults and real middle-click opens the requested mode without changing the source tab");
  for (const mode of ["old", "new"]) {
    await browser("find", "role", "link", "click", "--name", `View ${mode}`, "--exact");
    const expected = mode === "old" ? "const baseRate = 5" : 'order.country === "DE" ? 5 : 12';
    await wait(`${shadow}?.querySelector('pre')?.textContent.includes(${JSON.stringify(expected)})`);
    const text = await codeText();
    assert.doesNotMatch(text, /THRESHOLD/); // Neither side is the current working file.
    if (mode === "old") assert.doesNotMatch(text, /order.country ===/);
    else assert.doesNotMatch(text, /const baseRate = 5/);
    assert.equal(await evaluate(`Boolean(${shadow}?.querySelector('[data-line-type="change-deletion"], [data-line-type="change-addition"]'))`), false);
    assert.equal(await evaluate("Boolean(document.querySelector('[aria-label=\"Diff layout\"]'))"), false);
    const href = await evaluate("document.querySelector('a.file-path').href");
    assert.equal(new URL(href).searchParams.get("view"), mode);
    assert.equal(new URL(href).searchParams.get("to"), "HEAD~1");
    await browser("click", "a.file-path", "--new-tab");
    const sideTab = (await browser("tab", "list")).tabs.find((tab) => tab.tabId !== originalTab);
    await browser("tab", sideTab.tabId);
    await wait(`${shadow}?.querySelector('pre')?.textContent.includes(${JSON.stringify(expected)})`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="View ${mode}"]').getAttribute('aria-current')`), "true");
    await browser("reload");
    await wait(`${shadow}?.querySelector('pre')?.textContent.includes(${JSON.stringify(expected)})`);
    await browser("tab", "close", sideTab.tabId);
    await browser("tab", originalTab);
    if (mode === "old") await line(7);
    else {
      await browser("press", "l");
      await browser("fill", "#line-target", "7");
      assert.equal(await evaluate("Boolean(document.querySelector('.line-side'))"), false);
      await click("Start comment");
    }
    await browser("fill", "#comment-text", `Comment on the ${mode} revision.`);
    await click("Add comment");
    const state = await waitState((state) => state.comments.some((comment) => comment.text === `Comment on the ${mode} revision.`));
    const comment = state.comments.find((comment) => comment.text === `Comment on the ${mode} revision.`);
    assert.equal(comment.side, mode === "old" ? "deletions" : "additions");
    assert.equal(comment.start, 7);
    assert.equal(await evaluate("document.querySelectorAll('.comment-marker').length"), 1);
  }
  // Opening an opposite-side comment must reveal that side, not highlight the
  // same line number in the wrong revision.
  await browser("click", ".comment:first-child");
  await wait("document.querySelector('[aria-label=\"View old\"]').getAttribute('aria-current') === 'true'");
  await wait(`${shadow}?.querySelector('[data-selected-line]')`);
  assert.deepEqual(await highlightedLines(), [7]);
  assert.match(await codeText(), /const baseRate = 5/);
  await browser("click", '[aria-label="View diff"]');
  await wait(`${shadow}?.querySelector('[data-line-type="change-deletion"]')`);
  assert.equal(await evaluate("document.querySelectorAll('.comment-marker').length"), 2);
  assert.equal(await evaluate("new URL(document.querySelector('.file-path').href).searchParams.get('view')"), "diff");
  await browser("back");
  await wait("document.querySelector('[aria-label=\"View old\"]')?.getAttribute('aria-current') === 'true'");
  await browser("forward");
  await wait(`${shadow}?.querySelector('[data-line-type="change-deletion"]')`);
  await click("Clear");
  await browser("dialog", "accept");
  await waitState((state) => state.comments.length === 0);
  await browser("open", `${url}/?mode=working&path=src%2Fdiscount.ts&view=old`);
  await wait("document.querySelector('.code-pane').textContent.includes('File does not exist in the old revision')");
  await browser("click", '[aria-label="View new"]');
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('export function discount')`);
  await browser("open", `${url}/?mode=working&path=src%2Flegacy.ts&view=new`);
  await wait("document.querySelector('.code-pane').textContent.includes('File does not exist in the new revision')");
  await browser("click", '[aria-label="View old"]');
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('freeShipping = false')`);
  await browser("open", `${url}/?mode=working&path=src%2Fshipping.ts&view=unknown&split=invalid&expanded=invalid`);
  await wait(`${shadow}?.querySelector('[data-line-type="change-deletion"]')`);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"View diff\"]').getAttribute('aria-current')"), "true");
  assert.equal(await evaluate("document.querySelector('.segmented a:first-child').getAttribute('aria-current')"), "true");
  assert.ok(await evaluate(`Boolean(${shadow}.querySelector('[data-unmodified-lines]'))`));
  await browser("open", url);
  await wait("document.querySelector('.file-tree')");
  assert.equal(await evaluate("Boolean(document.querySelector('.viewer-modes'))"), false);
  console.log("PASS Diff/Old/New show exact revisions, preserve mode in header links/reloads/history, keep comments on their side and handle added/deleted files");

  assert.equal(
    await evaluate(
      `document.querySelector('.status-right').textContent.trim().endsWith(${JSON.stringify(`rv ${rvVersion}`)})`,
    ),
    true,
  );
  console.log("PASS status bar shows the rv version");
  await hoverTree("README.md");
  await wait(
    "document.querySelector('section[aria-label=Unreviewed] file-tree-container').hasAttribute('data-file-review-action') && document.querySelector('section[aria-label=Unreviewed] file-tree-container').shadowRoot.querySelector('[aria-label=\"Mark reviewed\"][data-visible=true]')",
  );
  await browser("find", "role", "button", "click", "--name", "Mark reviewed", "--exact");
  await wait(
    "document.querySelector('section[aria-label=Reviewed] file-tree-container')?.shadowRoot?.querySelector('[role=treeitem][aria-label=\"README.md\"]')",
  );
  await hoverTree("README.md", "Reviewed");
  await wait(
    "document.querySelector('section[aria-label=Reviewed] file-tree-container').hasAttribute('data-file-review-action') && document.querySelector('section[aria-label=Reviewed] file-tree-container').shadowRoot.querySelector('[aria-label=\"Mark unreviewed\"][data-visible=true]')",
  );
  await capture("file-review-hover-action");
  await evaluate(
    "document.querySelector('section[aria-label=Reviewed] file-tree-container').shadowRoot.querySelector('[aria-label=\"Mark unreviewed\"]').click()",
  );
  await wait(
    "document.querySelector('section[aria-label=Unreviewed] file-tree-container')?.shadowRoot?.querySelector('[role=treeitem][aria-label=\"README.md\"]')",
  );
  const srcDirectory = "document.querySelector('section[aria-label=Unreviewed] file-tree-container').shadowRoot.querySelector('[role=treeitem][aria-label=src]')";
  await click("Collapse all directories");
  await wait(`${srcDirectory}.getAttribute('aria-expanded') === 'false'`);
  await click("Expand all directories");
  await wait(`${srcDirectory}.getAttribute('aria-expanded') === 'true'`);
  console.log("PASS file tree controls collapse and expand all directories");
  await hoverTree("src");
  await wait(
    "document.querySelector('section[aria-label=Unreviewed] file-tree-container').hasAttribute('data-file-review-action') && document.querySelector('section[aria-label=Unreviewed] file-tree-container').shadowRoot.querySelector('[aria-label=\"Mark reviewed\"][data-visible=true]')",
  );
  await evaluate(
    "document.querySelector('section[aria-label=Unreviewed] file-tree-container').shadowRoot.querySelector('[aria-label=\"Mark reviewed\"]').click()",
  );
  await wait(
    "['discount.ts','shipping.ts'].every(p => document.querySelector('section[aria-label=Reviewed] file-tree-container')?.shadowRoot?.querySelector(`[role=treeitem][aria-label=\"${p}\"]`))",
  );
  await hoverTree("src", "Reviewed");
  await wait(
    "document.querySelector('section[aria-label=Reviewed] file-tree-container').hasAttribute('data-file-review-action') && document.querySelector('section[aria-label=Reviewed] file-tree-container').shadowRoot.querySelector('[aria-label=\"Mark unreviewed\"][data-visible=true]')",
  );
  await evaluate(
    "document.querySelector('section[aria-label=Reviewed] file-tree-container').shadowRoot.querySelector('[aria-label=\"Mark unreviewed\"]').click()",
  );
  await wait(
    "['discount.ts','shipping.ts'].every(p => document.querySelector('section[aria-label=Unreviewed] file-tree-container')?.shadowRoot?.querySelector(`[role=treeitem][aria-label=\"${p}\"]`))",
  );
  console.log("PASS directory review action toggles files recursively");
  await browser("press", "Meta+k");
  await browser("wait", '[aria-label="Search commands and keyboard shortcuts"]');
  await browser("fill", '[aria-label="Search commands and keyboard shortcuts"]', "find a file");
  await browser("press", "Enter");
  await browser("wait", '[aria-label="Fuzzy find file"]');
  await browser("press", "Escape");
  await browser("press", "?");
  await browser("wait", '[aria-label="Search commands and keyboard shortcuts"]');
  assert.equal(
    await evaluate("document.querySelector('[role=dialog]').getAttribute('aria-labelledby')"),
    "shortcut-title",
  );
  await browser("fill", '[aria-label="Search commands and keyboard shortcuts"]', "copy");
  assert.deepEqual(
    await evaluate("Array.from(document.querySelectorAll('.shortcut-row')).map(e => e.textContent.trim())"),
    ["Copy review promptReviewY"],
  );
  await capture("keyboard-shortcuts-search");
  await browser("press", "Escape");
  await wait("!document.querySelector('.shortcut-dialog')");
  await browser("press", "g");
  await browser("press", "r");
  await wait("document.activeElement.getAttribute('aria-label') === 'Search review scopes'");
  await browser("press", "Escape");
  await wait("!document.querySelector('.review-popover')");
  assert.equal(await lineStats(), "33 total lines of code");
  assert.equal(
    await evaluate(
      "document.querySelector('.topbar [aria-controls=\"file-browser\"]')",
    ),
    null,
  );
  assert.doesNotMatch(
    await evaluate("document.body.textContent"),
    /Read-only\. Your files stay untouched\.|Saved in this browser|Nothing extra\./,
  );
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('[role=treeitem]')).some(e => e.textContent.includes('legacy.ts'))",
    ),
    false,
  );
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "No file selected");
  await browser("press", "j");
  await wait("document.querySelector('.file-path').textContent === 'src/discount.ts'");
  await capture("files-empty");
  await browser("focus", '[aria-label="Find a file"]');
  assert.deepEqual(
    await evaluate(`(() => {
    const field = document.querySelector('.search');
    return { outer: getComputedStyle(field).outlineStyle, inner: getComputedStyle(field.querySelector('input')).outlineStyle };
  })()`),
    { outer: "none", inner: "none" },
  );
  await browser("fill", '[aria-label="Find a file"]', "shipping");
  assert.equal(await lineStats(), "26 total lines of code");
  await tree("shipping.ts");
  await wait("document.querySelector('.file-path').textContent === 'src/shipping.ts'");
  await tree("shipping.ts");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(
    await evaluate(`Array.from(document.querySelectorAll('file-tree-container')).every(tree => !Array.from(tree.shadowRoot.querySelectorAll('[role=treeitem]')).some(item => item.getAttribute('aria-label') === 'README.md'))`),
    true,
  );
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Find a file\"]').value"),
    "shipping",
  );
  await browser("press", "j");
  await wait("document.querySelector('.file-path').textContent === 'test/shipping.test.ts'");
  await browser("press", "j");
  await wait("document.querySelector('.file-path').textContent === 'src/shipping.ts'");
  await browser("press", "k");
  await wait("document.querySelector('.file-path').textContent === 'test/shipping.test.ts'");
  await browser("fill", '[aria-label="Find a file"]', "");
  await capture("search-focus");
  await tree("shipping.ts");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`);
  assert.equal(
    await evaluate(`${shadow}.querySelector('pre').dataset.overflow`),
    "scroll",
  );
  await click("Wrap long lines");
  await wait(`${shadow}.querySelector('pre').dataset.overflow === 'wrap'`);
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Wrap long lines\"]').getAttribute('aria-pressed')"),
    "true",
  );
  await browser("press", "w");
  await wait(`${shadow}.querySelector('pre').dataset.overflow === 'scroll'`);
  await browser("press", "w");
  await wait(`${shadow}.querySelector('pre').dataset.overflow === 'wrap'`);
  console.log("PASS long line wrapping toggles from the UI and W shortcut");
  await browser("press", "l");
  await browser("wait", "#line-target");
  await capture("keyboard-line-picker");
  await browser("fill", "#line-target", "6");
  await browser("press", "Enter");
  await browser("wait", "#comment-text");
  assert.equal(
    await evaluate("document.querySelector('.composer code').textContent"),
    "src/shipping.ts:6",
  );
  await browser("press", "Escape");
  await wait("!document.querySelector('.composer')");
  await browser("press", "j");
  await wait("document.querySelector('.file-path').textContent !== 'src/shipping.ts'");
  await browser("press", "k");
  await wait("document.querySelector('.file-path').textContent === 'src/shipping.ts'");
  await browser("press", "r");
  await wait("document.querySelector('.file-path').textContent === 'test/shipping.test.ts'");
  await browser("press", "u");
  await wait("document.querySelector('.file-path').textContent === 'src/shipping.ts'");
  await wait("document.querySelector('.review-toggle').getAttribute('aria-pressed') === 'false'");
  await browser("press", "r");
  await wait("document.querySelector('.file-path').textContent === 'test/shipping.test.ts'");
  await tree("shipping.ts");
  await wait("document.querySelector('.review-toggle').getAttribute('aria-pressed') === 'true'");
  await browser("press", "r");
  await wait("document.querySelector('.review-toggle').getAttribute('aria-pressed') === 'false'");
  await browser("press", "u");
  await wait("document.querySelector('.review-toggle').getAttribute('aria-pressed') === 'true'");
  await browser("press", "u");
  await wait("document.querySelector('.review-toggle').getAttribute('aria-pressed') === 'false'");
  await browser("press", "b");
  assert.equal(await evaluate("document.querySelector('#file-browser').hidden"), true);
  await browser("press", "b");
  assert.equal(await evaluate("document.querySelector('#file-browser').hidden"), false);
  await browser("press", "m");
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), true);
  await browser("press", "m");
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), false);
  await browser("press", "g");
  await browser("press", "u");
  await wait("document.querySelector('[aria-label=\"Review scope\"]').textContent.includes('Uncommitted changes')");
  await tree("shipping.ts");
  await wait(`${shadow}?.querySelector('[data-unmodified-lines]')`);
  await browser("press", "e");
  await wait(`!${shadow}.querySelector('[data-unmodified-lines]')`);
  assert.equal(
    await evaluate("document.querySelector('.expand-all').getAttribute('aria-current')"),
    "true",
  );
  assert.equal(await evaluate("new URL(location.href).searchParams.get('expanded')"), "true");
  await browser("press", "c");
  await wait(`${shadow}.querySelector('[data-unmodified-lines]')`);
  await browser("press", "e");
  await wait(`!${shadow}.querySelector('[data-unmodified-lines]')`);
  await browser("reload");
  await wait(`document.querySelector('.expand-all')?.textContent === 'Collapse all' && !${shadow}?.querySelector('[data-unmodified-lines]')`);
  await browser("find", "role", "link", "click", "--name", "Collapse all", "--exact");
  await wait(`${shadow}.querySelector('[data-unmodified-lines]')`);
  assert.equal(
    await evaluate("document.querySelector('.expand-all').hasAttribute('aria-current')"),
    false,
  );
  assert.equal(await evaluate("new URL(location.href).searchParams.has('expanded')"), false);
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), false);
  console.log("PASS E/C expand and collapse the viewed file diff; M toggles comments");
  await browser("press", "v");
  assert.equal(
    await evaluate("document.querySelector('.segmented a:last-child').getAttribute('aria-current')"),
    "true",
  );
  assert.equal(await evaluate("new URL(location.href).searchParams.get('split')"), "true");
  const urlOwnedView = await waitState((state) => state.view && !("split" in state.view));
  assert.equal("expanded" in urlOwnedView.view, false);
  await browser("press", "v");
  assert.equal(await evaluate("new URL(location.href).searchParams.has('split')"), false);
  await browser("press", "g");
  await browser("press", "f");
  await wait("document.querySelector('[aria-label=\"Review scope\"]').textContent.includes('File Browser')");
  await tree("README.md");
  await wait("document.querySelector('.file-path').textContent === 'README.md'");
  await browser("press", "j");
  await wait("document.querySelector('.file-path').textContent === 'src/discount.ts'");
  await browser("press", "k");
  await wait("document.querySelector('.file-path').textContent === 'README.md'");
  await browser("press", "r");
  await wait("document.querySelector('.file-path').textContent === 'src/discount.ts'");
  assert.equal(
    await evaluate(
      "Array.from(document.querySelector('section[aria-label=Reviewed] file-tree-container').shadowRoot.querySelectorAll('[role=treeitem]')).some(item => item.getAttribute('aria-label') === 'README.md')",
    ),
    true,
  );
  await browser("press", "f");
  await browser("wait", '[aria-label="Fuzzy find file"]');
  assert.deepEqual(
    await evaluate("Array.from(document.querySelectorAll('.finder-results a')).map(e => ({ path: e.querySelector('.finder-path').textContent, state: e.querySelector('.finder-state').textContent.trim() }))"),
    [
      { path: "src/discount.ts", state: "Unreviewed" },
      { path: "src/shipping.ts", state: "Unreviewed" },
      { path: "test/shipping.test.ts", state: "Unreviewed" },
      { path: ".gitignore", state: "Unreviewed" },
      { path: "README.md", state: "✓ Reviewed" },
    ],
  );
  await browser("fill", '[aria-label="Fuzzy find file"]', "sht");
  assert.deepEqual(
    await evaluate("Array.from(document.querySelectorAll('.finder-path')).map(e => e.textContent)"),
    ["src/shipping.ts", "test/shipping.test.ts"],
  );
  await browser("press", "Enter");
  await wait("document.querySelector('.file-path').textContent === 'src/shipping.ts'");
  await browser("find", "role", "button", "click", "--name", "Find file F", "--exact");
  await browser("wait", '[aria-label="Fuzzy find file"]');
  await browser("press", "Escape");
  await wait("!document.querySelector('.file-finder')");
  await tree(".gitignore");
  await wait("document.querySelector('.file-path').textContent === '.gitignore'");
  await browser("press", "j");
  await wait("document.querySelector('.file-path').textContent === 'README.md'");
  await browser("press", "j");
  await wait("document.querySelector('.file-path').textContent === 'src/discount.ts'");
  await browser("press", "k");
  await wait("document.querySelector('.file-path').textContent === 'README.md'");
  await browser("press", "r");
  await tree("shipping.ts");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`);
  await line(6);
  assert.equal(
    await evaluate("document.querySelector('.composer code').textContent"),
    "src/shipping.ts:6",
  );
  await browser("fill", "#comment-text", "Keep the threshold at 100.");
  await click("Add comment");
  assert.deepEqual(await comments(), [
    { reference: "src/shipping.ts:6", text: "Keep the threshold at 100." },
  ]);
  await browser("reload");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`);
  assert.equal(
    await evaluate(`${shadow}.querySelector('pre').dataset.overflow`),
    "wrap",
  );
  assert.match(await evaluate("document.querySelector('[aria-label=\"Review scope\"]').textContent"), /File Browser/);
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
  await tree("src");
  await browser("press", "ArrowLeft");
  await waitState((state) => state.view.collapsed.includes("src/"));
  await browser("reload");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`);
  const srcFolder = "document.querySelector('file-tree-container').shadowRoot.querySelector('[role=treeitem][aria-label=src]')";
  assert.equal(await evaluate(`${srcFolder}.getAttribute('aria-expanded')`), "false");
  await browser("fill", '[aria-label="Find a file"]', "shipping.ts");
  assert.equal(await lineStats(), "21 total lines of code");
  await browser("press", "Control+a");
  await browser("press", "Backspace");
  assert.equal(await evaluate(`${srcFolder}.getAttribute('aria-expanded')`), "false");
  await tree("src");
  await browser("press", "ArrowRight");
  console.log("PASS long line wrapping survives refresh");
  console.log("PASS Files selection and collapsed folders survive refresh; search does not overwrite expansion");
  console.log("PASS file tree → real line click → exact file:line comment");
  console.log("PASS J selects the first file when none is selected; U undoes review toggles");
  console.log("PASS J/K navigation only considers files matching the search filter");
  console.log("PASS marking reviewed opens the same next file as J");
  console.log("PASS shortcuts follow sidebar tree order across unreviewed/reviewed sections and wrap");

  await browser("hover", ".comment");
  assert.deepEqual(await highlightedLines(), [6]);
  assert.equal(
    await evaluate("Boolean(document.querySelector('.composer'))"),
    false,
  );
  await capture("comment-hover");
  await browser("click", ".comment-marker");
  await wait("document.activeElement.classList.contains('comment')");
  await tree("README.md");
  await browser("click", ".comment p");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`,
  );
  assert.deepEqual(await highlightedLines(), [6]);
  console.log(
    "PASS Files excludes deleted files; comment hover highlights line 6, marker focuses comment, click opens its file",
  );

  // Embedded pages may deny the async Clipboard API. The click must still copy.
  await evaluate(
    "window.originalWriteText = navigator.clipboard.writeText; navigator.clipboard.writeText = () => Promise.reject(new Error('Blocked by policy'))",
  );
  await click("Copy Prompt 1");
  assert.equal(
    await evaluate("document.querySelector('[role=dialog] h2').textContent"),
    "Prompt copied to clipboard",
  );
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Copied prompt\"]').value"),
    "src/shipping.ts:6\nKeep the threshold at 100.",
  );
  await click("Keep Comments");
  await line(8);
  await browser("focus", "#comment-text");
  await browser("clipboard", "paste");
  assert.equal(
    await evaluate("document.querySelector('#comment-text').value"),
    "src/shipping.ts:6\nKeep the threshold at 100.",
  );
  await click("Cancel");
  await evaluate(
    "navigator.clipboard.writeText = window.originalWriteText; delete window.originalWriteText",
  );
  console.log(
    "PASS real Copy Prompt clipboard contents, verified by paste-back",
  );

  await reviewScope("Uncommitted changes");
  await wait(`${shadow}?.querySelector('[data-line-type="change-addition"]')`);
  assert.equal(await lineStats(), "6 lines added, 4 lines removed");
  await browser("fill", '[aria-label="Find a file"]', "shipping.ts");
  assert.equal(await lineStats(), "3 lines added, 3 lines removed");
  await capture("filtered-file-stats");
  await browser("focus", '[aria-label="Find a file"]');
  await browser("press", "Control+a");
  await browser("press", "Backspace");
  let text = await codeText();
  assert.match(text, /THRESHOLD = 100/);
  assert.match(text, /THRESHOLD = 75/);
  assert.match(text, /\? 6 : 14/);
  assert.match(text, /\? 5 : 12/);
  const initialWidth = await evaluate(
    "document.querySelector('main').getBoundingClientRect().width",
  );
  await click("Hide file browser");
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('#file-browser')).display",
    ),
    "none",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('main').getBoundingClientRect().width",
    ),
    initialWidth + 232 - 28,
  );
  await capture("files-hidden");
  await click("Hide comments");
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('#review-comments')).display",
    ),
    "none",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('main').getBoundingClientRect().width",
    ),
    1440 - 56,
  );
  await capture("diff-only");
  await line(14, "change-addition");
  assert.equal(
    await evaluate("document.querySelector('#review-comments').hidden"),
    false,
  );
  assert.equal(
    await evaluate("document.querySelector('#file-browser').hidden"),
    true,
  );
  await browser(
    "fill",
    "#comment-text",
    "Keep cents precise; round only when displaying the price.",
  );
  await click("Hide comments");
  await click("Show comments");
  assert.equal(
    await evaluate("document.querySelector('#comment-text').value"),
    "Keep cents precise; round only when displaying the price.",
  );
  await click("Add comment");
  await click("Show file browser");
  await click("Hide comments");
  await capture("comments-hidden");
  await click("Open comment on src/shipping.ts:14");
  await wait(
    "document.activeElement.getAttribute('aria-label') === 'Comment on src/shipping.ts:14'",
  );
  assert.equal(
    await evaluate("document.querySelector('#review-comments').hidden"),
    false,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('main').getBoundingClientRect().width",
    ),
    initialWidth,
  );
  await capture("comments-reopened");
  console.log(
    "PASS independent sidebars collapse, full-width diff, comments reopen on selection/marker, drafts preserved",
  );
  await resizePanel("files", 80);
  await wait(
    "document.querySelector('#file-browser').getBoundingClientRect().width === 312",
  );
  await resizePanel("comments", -50);
  await wait(
    "document.querySelector('#review-comments').getBoundingClientRect().width === 360",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('main').getBoundingClientRect().width",
    ),
    768,
  );
  await browser("hover", ".resize-handle.comments");
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.resize-handle.comments')).cursor",
    ),
    "col-resize",
  );
  await capture("panels-resized");
  await click("Hide file browser");
  await click("Hide comments");
  await browser("reload");
  await wait(`${shadow}?.querySelector('[data-line-type="change-addition"]')`);
  assert.equal(await evaluate("document.querySelector('#file-browser').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), true);
  assert.match(await evaluate("document.querySelector('[aria-label=\"Review scope\"]').textContent"), /Uncommitted changes/);
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
  await click("Show file browser");
  await click("Open comment on src/shipping.ts:14");
  await wait(
    "document.querySelector('#review-comments').getBoundingClientRect().width === 360",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#file-browser').getBoundingClientRect().width",
    ),
    312,
  );
  await browser("focus", ".resize-handle.comments");
  await browser("press", "ArrowRight");
  await wait(
    "document.querySelector('#review-comments').getBoundingClientRect().width === 340",
  );
  await browser("press", "Home");
  await wait(
    "document.querySelector('#review-comments').getBoundingClientRect().width === 220",
  );
  await browser("press", "End");
  await wait(
    "document.querySelector('#review-comments').getBoundingClientRect().width === 504",
  );
  await resizePanel("files", 1000);
  await wait(
    "document.querySelector('#file-browser').getBoundingClientRect().width === 504",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('main').getBoundingClientRect().width",
    ),
    432,
  );
  await browser("set", "viewport", "1000", "800", "2");
  await wait(
    "document.querySelector('#file-browser').getBoundingClientRect().width === 350 && document.querySelector('#review-comments').getBoundingClientRect().width === 350",
  );
  await browser("set", "viewport", "1440", "900", "2");
  await wait(
    "document.querySelector('#file-browser').getBoundingClientRect().width === 504",
  );
  await browser("focus", ".resize-handle.files");
  await browser("press", "Home");
  await wait(
    "document.querySelector('#file-browser').getBoundingClientRect().width === 160",
  );
  // Restore the initial widths before the remaining regression checks.
  await resizePanel("files", 72);
  await resizePanel("comments", 194);
  await wait(
    "document.querySelector('main').getBoundingClientRect().width === 898",
  );
  console.log(
    "PASS real edge drags resize both panels; widths survive hide/reopen; keyboard, limits and viewport clamps work",
  );
  await line(13, "change-deletion");
  await browser("fill", "#comment-text", "Document why these rates changed.");
  await click("Add comment");
  assert.equal((await comments())[2].reference, "src/shipping.ts:13");
  assert.match(
    await evaluate(
      "document.querySelectorAll('.comment-bottom')[2].textContent",
    ),
    /old side/,
  );
  await capture("working-unified");
  await browser("hover", ".comment:nth-child(3)");
  assert.deepEqual(await highlightedLines(), [13]);
  assert.equal(
    await evaluate(
      `${shadow}.querySelector('[data-column-number="13"][data-selected-line]').dataset.lineType`,
    ),
    "change-deletion",
  );
  await browser("find", "role", "link", "click", "--name", "Split", "--exact");
  await wait(`${shadow}?.querySelector('[data-diff-type="split"]')`);
  const splitContentWidths = await evaluate(
    `Array.from(${shadow}.querySelectorAll('[data-content]')).slice(0, 2).map(element => element.getBoundingClientRect().width)`,
  );
  assert.ok(
    Math.abs(splitContentWidths[0] - splitContentWidths[1]) < 1,
    `Comment annotations must not collapse a wrapped split diff column: ${splitContentWidths}`,
  );
  await capture("working-split");
  await browser("hover", ".comment:nth-child(2)");
  assert.deepEqual(await highlightedLines(), [14]);
  await click("Preview");
  assert.equal(
    await evaluate(
      "document.querySelector('[aria-label=\"Prompt text\"]').value",
    ),
    "src/shipping.ts:6\nKeep the threshold at 100.\n\nsrc/shipping.ts:14\nKeep cents precise; round only when displaying the price.\n\nsrc/shipping.ts:13\nDocument why these rates changed.",
  );
  await capture("prompt");
  await click("Close preview");
  console.log(
    "PASS unified + split, staged + unstaged, old/new line coordinates, exact multi-comment prompt",
  );

  await tree("legacy.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('freeShipping')`,
  );
  await tree("discount.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('percent / 100')`,
  );
  await click("Review scope");
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.review-options time')).map(e => e.textContent)",
    ),
    ["10m ago", "3h ago", "2d ago"],
  );
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.review-options time')).map(e => ({date:e.dateTime, title:e.title}))",
    ),
    [...f.dates]
      .reverse()
      .map((date) => ({ date, title: date.replace("T", " ") })),
  );
  await browser("hover", ".review-options button:nth-of-type(5) time");
  await capture("commit-timestamps");
  await browser("fill", '[aria-label="Search review scopes"]', f.second);
  await browser("press", "Enter");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Charge 12 for international orders.')`,
  );
  await tree("shipping.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('const baseRate = 5')`,
  );
  assert.doesNotMatch(await codeText(), /THRESHOLD/);
  await browser("reload");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('const baseRate = 5')`);
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
  assert.match(await evaluate("document.querySelector('[aria-label=\"Review scope\"]').textContent"), /Add international shipping rates/);
  await wait(`${shadow}?.querySelector('[data-diff-type="split"]')`);
  console.log("PASS reload restores a non-default commit, its selected file and split layout");
  await reviewCommit(f.first);
  await wait(
    "document.querySelector('.code-footer').textContent.includes('Commit " +
      f.first.slice(0, 7) +
      "')",
  );
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Add shipping calculator')`,
  );
  await tree("shipping.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('const baseRate = 5')`,
  );
  assert.match(await codeText(), /const baseRate = 5/);
  console.log("PASS deleted/untracked files, recent commit and root commit");

  await reviewRange();
  await click("Base revision");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.commit-options [role=option]').length",
    ),
    3,
  );
  await capture("commit-picker-open");
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.commit-options time')).map(e => e.textContent)",
    ),
    ["10m ago", "3h ago", "2d ago"],
  );
  await browser("fill", '[aria-label="Search base commits"]', "calculator");
  await browser(
    "find",
    "role",
    "option",
    "click",
    "--name",
    `Add shipping calculator ${f.first.slice(0, 7)} 2d ago`,
    "--exact",
  );
  assert.match(
    await evaluate(
      "document.querySelector('[aria-label=\"Base revision\"]').textContent",
    ),
    /Add shipping calculator/,
  );
  await click("Target revision");
  assert.equal(
    await evaluate("document.querySelectorAll('.commit-options time').length"),
    3,
  );
  await browser(
    "fill",
    '[aria-label="Search target commits"]',
    f.third.slice(0, 7),
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.commit-options [role=option]').length",
    ),
    1,
  );
  await browser("press", "Enter");
  assert.match(
    await evaluate(
      "document.querySelector('[aria-label=\"Target revision\"]').textContent",
    ),
    /Introduce free shipping threshold/,
  );
  // Reopening starts unfiltered; Escape, Tab and outside click do not commit a choice.
  await click("Base revision");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.commit-options [role=option]').length",
    ),
    3,
  );
  await browser("press", "ArrowDown");
  assert.match(
    await evaluate(
      "document.getElementById(document.querySelector('[role=combobox][aria-autocomplete]').getAttribute('aria-activedescendant')).textContent",
    ),
    /international/,
  );
  await browser("press", "Escape");
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-label')"),
    "Base revision",
  );
  assert.match(
    await evaluate(
      "document.querySelector('[aria-label=\"Base revision\"]').textContent",
    ),
    /Add shipping calculator/,
  );
  await click("Base revision");
  await browser("press", "Tab");
  assert.equal(
    await evaluate("Boolean(document.querySelector('.commit-popover'))"),
    false,
  );
  await reviewRange();
  await click("Target revision");
  await browser("click", ".brand");
  assert.equal(
    await evaluate("Boolean(document.querySelector('.commit-popover'))"),
    false,
  );
  assert.equal(
    await evaluate("document.querySelector('.code-footer').textContent.trim()"),
    `Commit ${f.first.slice(0, 7)}`,
  );
  await browser("set", "viewport", "1000", "800", "2");
  await reviewRange();
  await click("Target revision");
  assert.equal(
    await evaluate(
      "(() => { const r = document.querySelector('.commit-popover').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()",
    ),
    true,
  );
  await capture("commit-picker-narrow");
  await browser("press", "Escape");
  await browser("set", "viewport", "1440", "900", "2");
  await browser("reload");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('const baseRate = 5')`);
  assert.equal(await evaluate("document.querySelector('.code-footer').textContent.trim()"), `Commit ${f.first.slice(0, 7)}`);
  assert.match(await evaluate("document.querySelector('[aria-label=\"Review scope\"]').textContent"), /Add shipping calculator/);
  await reviewRange();
  assert.match(await evaluate("document.querySelector('[aria-label=\"Target revision\"]').textContent"), /Add shipping calculator/);
  console.log("PASS reload uses the applied comparison from the URL, not unsubmitted range pickers");
  await click("Base revision");
  await browser("fill", '[aria-label="Search base commits"]', f.first);
  await browser("press", "Enter");
  await click("Target revision");
  await browser("fill", '[aria-label="Search target commits"]', f.third);
  await browser("press", "Enter");
  await click("Compare");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 100')`,
  );
  text = await codeText();
  assert.match(text, /const baseRate = 5/);
  assert.doesNotMatch(text, /THRESHOLD = 75/);
  await browser("fill", '[aria-label="Find a file"]', "shipping.ts");
  await browser("reload");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 100')`);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Find a file\"]').value"), "shipping.ts");
  assert.equal(await evaluate("document.querySelector('.code-footer').textContent.trim()"), `${f.first.slice(0, 7)} → ${f.third.slice(0, 7)}`);
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
  assert.doesNotMatch(await codeText(), /THRESHOLD = 75/);
  await browser("focus", '[aria-label="Find a file"]');
  await browser("press", "Control+a");
  await browser("press", "Backspace");
  await capture("commit-range");
  // Custom refs remain supported, without relying on native datalist behavior.
  await reviewRange();
  await click("Base revision");
  await browser("fill", '[aria-label="Search base commits"]', "HEAD~2");
  await capture("commit-picker-ref");
  assert.equal(
    await evaluate("document.querySelectorAll('.commit-options time').length"),
    0,
  );
  await browser("press", "Enter");
  await click("Target revision");
  await browser("fill", '[aria-label="Search target commits"]', "HEAD");
  await browser("press", "Enter");
  await click("Compare");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 100')`,
  );
  assert.match(await codeText(), /const baseRate = 5/);
  console.log(
    "PASS borderless file filter focus; range pickers browse/search by message/hash, keyboard and custom Git refs",
  );
  await line(7, "change-deletion");
  assert.equal(
    await evaluate("document.querySelector('.composer code').textContent"),
    "src/shipping.ts:7",
  );
  await click("Cancel");
  await line(13, "change-addition");
  assert.equal(
    await evaluate("document.querySelector('.composer code').textContent"),
    "src/shipping.ts:13",
  );
  await click("Cancel");
  await line(3, "", 1);
  assert.equal(
    await evaluate("document.querySelector('.composer code').textContent"),
    "src/shipping.ts:1-3",
  );
  await capture("line-range");
  await browser(
    "fill",
    "#comment-text",
    "Explain the shape of the shipping input.",
  );
  await click("Add comment");
  await expectHintAfter(3, "Explain the shape of the shipping input.");
  await browser("hover", ".comment:nth-child(4)");
  assert.ok((await highlightedLines()).includes(1));
  assert.ok((await highlightedLines()).includes(2));
  assert.ok((await highlightedLines()).includes(3));
  assert.ok(!(await highlightedLines()).includes(4));
  await reviewScope("Uncommitted changes");
  await browser("click", ".comment:nth-child(4) p");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 100')`,
  );
  assert.doesNotMatch(await codeText(), /THRESHOLD = 75/);
  assert.equal(
    await evaluate(
      "document.querySelector('[aria-label=\"Review scope\"]').textContent.includes('→') ? 'range' : ''",
    ),
    "range",
  );
  await capture("range-comment-navigation");
  await click("Delete comment 4");
  console.log(
    "PASS old/new-side hover highlights and comment click restores historical range (not working tree)",
  );
  console.log(
    "PASS asymmetric old line 7 / new line 13 anchors and real drag-select range 1–3",
  );
  await reviewRange();
  await click("Base revision");
  await browser(
    "fill",
    '[aria-label="Search base commits"]',
    "nonexistent-ref",
  );
  await browser("press", "Enter");
  await click("Compare");
  await wait(
    "document.querySelector('[role=alert]')?.textContent.includes('Unknown commit')",
  );
  await capture("invalid-range");
  console.log(
    "PASS commit range shows historical (not working) contents; invalid refs show an error",
  );

  await browser("reload");
  await wait("document.querySelectorAll('.comment').length === 3");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 100')`);
  await reviewRange();
  assert.match(await evaluate("document.querySelector('[aria-label=\"Base revision\"]').textContent"), /Add shipping calculator/);
  // Refresh restores the successful comparison, not the failed draft ref.
  await reviewScope("Uncommitted changes");
  await reviewScope("File Browser");
  // Edit an existing comment while a different file is selected: preserve its anchor.
  await tree("README.md");
  await browser("click", ".comment:first-child .comment-bottom button");
  await browser("focus", '[aria-label="Edit comment"]');
  await browser("press", "Control+a");
  await browser("press", "Backspace");
  await browser(
    "type",
    '[aria-label="Edit comment"]',
    "Make the threshold configurable.",
  );
  await capture("edit-comment");
  await click("Save comment");
  assert.deepEqual((await comments())[0], {
    reference: "src/shipping.ts:6",
    text: "Make the threshold configurable.",
  });
  await click("Delete comment 3");
  assert.equal((await comments()).length, 2);
  console.log("PASS refresh persistence, cross-file comment edit, delete");

  await f.write(
    "long.ts",
    Array.from(
      { length: 240 },
      (_, i) => `export const line${i + 1} = ${i + 1};`,
    ).join("\n") + "\n",
  );
  await Promise.all(Array.from({ length: 60 }, (_, i) =>
    f.write(`tree/file-${String(i + 1).padStart(2, "0")}.ts`, `export const value = ${i + 1};\n`),
  ));
  f.git("add", ".");
  f.git("commit", "-qm", "Clean checkpoint");
  await browser("reload");
  await wait(
    "document.querySelector('.sidebar-header')?.textContent.includes('Repository files')",
  );
  await browser("press", "f");
  await browser("fill", '[aria-label="Fuzzy find file"]', "long.ts");
  await browser("press", "Enter");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('export const line1 = 1;')`);
  await wait("document.activeElement === document.querySelector('.code-view')");
  await browser("press", "ArrowDown");
  await wait("document.querySelector('.code-view').scrollTop > 0");
  console.log("PASS selecting a file focuses its viewer for arrow-key scrolling");
  // Chromium animates native keyboard scrolling across a variable number of
  // frames. Wait for it to stop so it cannot overwrite the position below.
  await evaluate(`new Promise(resolve => {
    const scroller = document.querySelector('.code-view');
    let previous = scroller.scrollTop;
    let stableFrames = 0;
    function settle() {
      const current = scroller.scrollTop;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 5) resolve();
      else requestAnimationFrame(settle);
    }
    requestAnimationFrame(settle);
  })`);
  const explorerScroller = "document.querySelector('section[aria-label=\"Unreviewed\"] file-tree-container').shadowRoot.querySelector('[data-file-tree-virtualized-scroll=\"true\"]')";
  await evaluate(`${explorerScroller}.scrollTop = ${explorerScroller}.scrollHeight`);
  await evaluate("document.querySelector('.code-view').scrollTop = 1200");
  await wait(`${explorerScroller}.scrollTop > 0 && document.querySelector('.code-view').scrollTop === 1200`);
  const longURL = await evaluate("location.href");
  assert.equal(new URL(longURL).searchParams.has("scroll"), false);
  await browser("click", "a.file-path", "--new-tab");
  const scrollTab = (await browser("tab", "list")).tabs.find((tab) => tab.tabId !== originalTab);
  await browser("tab", scrollTab.tabId);
  await wait("document.querySelector('.file-path')?.textContent === 'long.ts' && document.querySelector('.code-view')?.scrollTop === 1200");
  assert.ok(await evaluate(`${explorerScroller}.scrollTop > 0`));
  assert.equal(await evaluate("location.href"), longURL);
  await browser("tab", "close", scrollTab.tabId);
  await browser("tab", originalTab);
  await tree("README.md");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('A small, predictable shipping calculator.')`);
  await browser("press", "f");
  await browser("fill", '[aria-label="Fuzzy find file"]', "long.ts");
  await browser("press", "Enter");
  await wait("document.querySelector('.code-view').scrollTop === 1200");
  console.log("PASS each file and the file explorer restore scroll positions; a same-view new tab inherits them without URL state");

  await evaluate("document.querySelector('.code-view').scrollTop = 150 * 23");
  await line(160, "", 162);
  await browser("fill", "#comment-text", "Review this off-screen range.");
  await click("Add comment");
  await evaluate("document.querySelector('.code-view').scrollTop = 0");
  await browser("click", ".comment:nth-child(3) p");
  await wait(
    `(() => { const line = ${shadow}?.querySelector('[data-column-number="160"]'); if (!line) return false; const r = line.getBoundingClientRect(); return r.y > 160 && r.bottom < 820; })()`,
  );
  assert.deepEqual(await highlightedLines(), [160, 161, 162]);
  await expectHintAfter(162, "Review this off-screen range.");
  await tree("README.md");
  await browser("click", ".comment:nth-child(3) p");
  await wait(
    `(() => { const line = ${shadow}?.querySelector('[data-column-number="160"]'); if (!line) return false; const r = line.getBoundingClientRect(); return r.y > 160 && r.bottom < 820; })()`,
  );
  assert.deepEqual(await highlightedLines(), [160, 161, 162]);
  await capture("offscreen-comment-navigation");
  await click("Delete comment 3");
  console.log(
    "PASS comment click scrolls to lines 160–162, including navigation from another file",
  );
  await f.write(
    "long.ts",
    Array.from(
      { length: 240 },
      (_, i) => `export const changedLine${i + 1} = ${i + 1};`,
    ).join("\n") + "\n",
  );
  await browser("click", ".refresh");
  await wait("document.querySelector('[aria-label=\"Review scope\"]')");
  await reviewScope("Uncommitted changes");
  await browser("press", "f");
  await browser("fill", '[aria-label="Fuzzy find file"]', "long.ts");
  await browser("press", "Enter");
  await wait(`${shadow}?.querySelector('[data-line-type="change-deletion"]')`);
  await evaluate("document.querySelector('.code-view').scrollTop = 700");
  await browser("click", '[aria-label="View old"]');
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('export const line1 = 1;')`);
  await evaluate("document.querySelector('.code-view').scrollTop = 1000");
  await browser("click", '[aria-label="View new"]');
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('export const changedLine1 = 1;')`);
  await evaluate("document.querySelector('.code-view').scrollTop = 1300");
  await browser("click", '[aria-label="View old"]');
  await wait("document.querySelector('.code-view').scrollTop === 1000");
  await browser("click", '[aria-label="View diff"]');
  await wait("document.querySelector('.code-view').scrollTop === 700");
  await browser("click", '[aria-label="View new"]');
  await wait("document.querySelector('.code-view').scrollTop === 1300");
  await browser("click", '[aria-label="View new"]', "--new-tab");
  const modeScrollTab = (await browser("tab", "list")).tabs.find((tab) => tab.tabId !== originalTab);
  await browser("tab", modeScrollTab.tabId);
  await wait("document.querySelector('.file-path')?.textContent === 'long.ts' && document.querySelector('[aria-label=\"View new\"]')?.getAttribute('aria-current') === 'true'");
  await wait("document.querySelector('.code-view').scrollTop === 1300");
  assert.deepEqual(
    await evaluate("Array.from(new URL(location.href).searchParams.keys()).sort()"),
    ["mode", "path", "split", "view"],
  );
  await browser("tab", "close", modeScrollTab.tabId);
  await browser("tab", originalTab);
  await browser("click", '[aria-label="View diff"]');
  await wait("document.querySelector('[aria-label=\"View diff\"]')?.getAttribute('aria-current') === 'true'");
  console.log("PASS Diff, Old and New keep independent scroll positions; the active view carries its position into a new tab");
  f.git("checkout", "--", "long.ts");
  await browser("click", ".refresh");
  await wait("document.querySelector('[aria-label=\"Review scope\"]')");
  await reviewScope("File Browser");
  await reviewScope("Uncommitted changes");
  await wait(
    "document.querySelector('main').textContent.includes('No changes to review')",
  );
  await capture("clean-tree");
  const before = await evaluate(
    "performance.getEntriesByType('resource').filter(e => e.name.includes('/api/')).length",
  );
  await f.write("new-after-load.ts", "export const afterRefresh = true;\n");
  f.git("add", ".");
  f.git("commit", "-qm", "Commit created after page load");
  await f.write("pending-after-load.ts", "export const pending = true;\n");
  await browser(
    "eval",
    "window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))",
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(
    await evaluate(
      "performance.getEntriesByType('resource').filter(e => e.name.includes('/api/')).length",
    ),
    before,
  );
  assert.match(
    await evaluate("document.querySelector('main').textContent"),
    /No changes to review/,
  );
  // Re-selecting the current mode is still an explicit refresh.
  await reviewScope("Uncommitted changes");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('pending = true')`,
  );
  await reviewScope("File Browser");
  await browser("press", "f");
  await browser("fill", '[aria-label="Fuzzy find file"]', "long.ts");
  await browser("press", "Enter");
  await wait("document.querySelector('.file-path')?.textContent === 'long.ts'");
  await browser("focus", '[aria-label="Review scope"]');
  const infoBeforeGf = await evaluate(
    "performance.getEntriesByType('resource').filter(e => e.name.includes('/api/info?')).length",
  );
  await browser("press", "g");
  await browser("press", "f");
  await wait(
    `performance.getEntriesByType('resource').filter(e => e.name.includes('/api/info?')).length > ${infoBeforeGf}`,
  );
  await wait("document.activeElement === document.querySelector('.code-view')");
  await evaluate("document.querySelector('.code-view').scrollTop = 0");
  await browser("press", "ArrowDown");
  await wait("document.querySelector('.code-view').scrollTop > 0");
  console.log("PASS G F focuses the file viewer for arrow-key scrolling");
  await evaluate(`(() => {
    window.gcInfoRequests = 0;
    window.fetchBeforeGc = window.fetch;
    window.fetch = (...args) => {
      if (String(args[0]).startsWith('/api/info?')) window.gcInfoRequests++;
      return window.fetchBeforeGc(...args);
    };
    for (const key of ['g', 'c', 'g', 'c'])
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  })()`);
  await wait("document.querySelector('[aria-label=\"Review scope\"]')?.textContent.includes('Commit created after page load')");
  assert.equal(await evaluate("window.gcInfoRequests"), 1);
  await evaluate("new Promise(resolve => setTimeout(resolve, 200))");
  await browser("press", "g");
  await browser("press", "c");
  await wait("window.gcInfoRequests === 2");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('Commit created after page load')`);
  await evaluate("window.fetch = window.fetchBeforeGc");
  assert.equal((await comments()).length, 2);
  console.log(
    "PASS focus causes zero background API calls; selecting or jumping to a view mode refreshes repository data; overlapping and sequential G C open the newest commit safely",
  );
  await reviewCommit(f.second);
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Charge 12 for international orders.')`,
  );
  await click("Hide comments");
  await line(3, "", 4);
  assert.equal(
    await evaluate("document.querySelector('#review-comments').hidden"),
    false,
  );
  assert.equal(
    await evaluate("document.querySelector('.composer code').textContent"),
    `commit:${f.second}:message:3-4`,
  );
  await browser(
    "fill",
    "#comment-text",
    "Explain why international shipping costs more.",
  );
  await click("Add comment");
  await expectHintAfter(4, "Explain why international shipping costs more.");
  await browser("hover", ".comment:last-child");
  assert.deepEqual(await highlightedLines(), [3, 4]);
  // Screenshots move the pointer away; keyboard focus keeps the range visible.
  await browser("mouse", "move", "800", "35");
  await browser("focus", ".comment:last-child");
  await capture("commit-message-review");
  assert.deepEqual(await highlightedLines(), [3, 4]);
  await click("Hide comments");
  await browser("click", ".comment-marker");
  await wait("document.activeElement.classList.contains('comment')");
  assert.equal(
    await evaluate("document.querySelector('#review-comments').hidden"),
    false,
  );
  await click("Copy Prompt 3");
  assert.equal(
    await evaluate("document.activeElement.textContent"),
    "Clear",
  );
  assert.equal(
    await evaluate("document.querySelector('[aria-label=\"Copied prompt\"]').value"),
    `src/shipping.ts:6\nMake the threshold configurable.\n\nsrc/shipping.ts:14\nKeep cents precise; round only when displaying the price.\n\ncommit:${f.second}:message:3-4\nExplain why international shipping costs more.`,
  );
  await click("Keep Comments");
  await line(1);
  await browser("clipboard", "paste");
  assert.equal(
    await evaluate("document.querySelector('#comment-text').value"),
    `src/shipping.ts:6\nMake the threshold configurable.\n\nsrc/shipping.ts:14\nKeep cents precise; round only when displaying the price.\n\ncommit:${f.second}:message:3-4\nExplain why international shipping costs more.`,
  );
  await click("Cancel");
  await browser("reload");
  await wait("document.querySelectorAll('.comment').length === 3");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('Charge 12 for international orders.')`);
  assert.match(await evaluate("document.querySelector('.file-path').textContent"), /Commit message/);
  await browser("click", ".comment:last-child p");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Charge 12 for international orders.')`,
  );
  assert.deepEqual(await highlightedLines(), [3, 4]);
  await tree("shipping.ts");
  await wait(`${shadow}?.querySelector('[data-line-type="change-addition"]')`);
  await capture("commit-message-unselected");
  await click("Commit message");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Keep domestic shipping at 5.')`,
  );
  console.log(
    "PASS full commit message, real range selection 3–4, hover, marker reopen, exact mixed clipboard, reload navigation",
  );

  await click("Mark reviewed");
  await resizePanel("files", 60);
  await click("Hide comments");
  const beforeClearFilesWidth = await evaluate("document.querySelector('#file-browser').getBoundingClientRect().width");
  const beforeClearCommentsWidth = await evaluate("document.querySelector('#review-comments').getBoundingClientRect().width");
  await evaluate("localStorage.setItem('rv:comments:/another-repo', 'keep me')");
  const beforeClear = await evaluate("JSON.stringify({...localStorage})");
  await click("Clear");
  assert.match(JSON.stringify(await browser("dialog", "status")), /Clear all comments and review progress/);
  await browser("dialog", "dismiss");
  assert.equal(await evaluate("JSON.stringify({...localStorage})"), beforeClear);
  assert.equal((await comments()).length, 3);
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), true);
  await capture("clear-cancelled");
  await click("Clear");
  await browser("dialog", "accept");
  await wait("document.querySelectorAll('.comment').length === 0");
  assert.deepEqual(await comments(), []);
  assert.equal(
    await evaluate("document.querySelector('.copy').disabled"),
    true,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.comment-marker').length"),
    0,
  );
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#file-browser').getBoundingClientRect().width"), beforeClearFilesWidth);
  assert.equal(await evaluate("document.querySelector('#review-comments').getBoundingClientRect().width"), beforeClearCommentsWidth);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Mark reviewed')"), true);
  // Clear updates comments and review progress while preserving the view.
  await waitState((state) => !state.comments.length && !Object.keys(state.reviewed).length && !("selected" in state.view) && state.view.showComments === false);
  assert.equal(await evaluate("localStorage.getItem('rv:comments:/another-repo')"), "keep me");
  assert.doesNotMatch(await evaluate("document.body.textContent"), /Clear Comments|Undo/);
  await capture("comments-cleared");
  await browser("reload");
  await wait("document.querySelector('.file-path')?.textContent === 'src/shipping.ts'");
  assert.deepEqual(await comments(), []);
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#file-browser').getBoundingClientRect().width"), beforeClearFilesWidth);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Mark reviewed')"), true);
  console.log(
    "PASS Clear confirmation cancels without changes; confirmed clear removes comments and review progress while preserving view state across reload",
  );

  f.git(
    "commit",
    "--allow-empty",
    "-qm",
    "Document the decision",
    "-m",
    "No files changed.",
  );
  await browser("reload");
  await wait("document.querySelector('[aria-label=\"Review scope\"]')");
  await reviewCommit("Document the decision");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('No files changed.')`,
  );
  assert.match(
    await evaluate("document.querySelector('.sidebar-header').textContent"),
    /Changed files\s*1/,
  );
  await line(3);
  await browser("fill", "#comment-text", "Explain the decision.");
  await click("Add comment");
  assert.equal(
    (await comments())[0].reference,
    `commit:${f.git("rev-parse", "HEAD")}:message:3`,
  );
  await capture("empty-commit-message");
  console.log(
    "PASS commit with zero file changes still supports message review and comments",
  );
  const sectionText = (name) =>
    evaluate(`(() => {
    const section = document.querySelector('section[aria-label="${name}"]');
    const items = section?.querySelector('file-tree-container')?.shadowRoot?.querySelectorAll('[role=treeitem]') || [];
    return (section?.textContent || '') + Array.from(items).map(e => e.getAttribute('aria-label')).join(' ');
  })()`);
  const reviewedText = () => sectionText("Reviewed");
  await click("Mark reviewed");
  assert.match(await reviewedText(), /Commit message/);
  assert.match(
    await evaluate(
      "document.querySelector('section[aria-label=Unreviewed]').textContent",
    ),
    /All reviewed/,
  );
  await capture("all-reviewed");
  await browser("reload");
  await wait("document.querySelector('.comment')");
  await browser("click", ".comment p");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('No files changed.')`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.review-toggle').getAttribute('aria-pressed')",
    ),
    "true",
  );
  await reviewCommit(f.second);
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Charge 12 for international orders.')`,
  );
  assert.equal(await reviewedText(), "");
  assert.equal(await lineStats(), "6 lines added, 1 lines removed");
  await click("Mark reviewed");
  assert.equal(await lineStats(), "6 lines added, 1 lines removed");
  assert.equal(await lineStats("Reviewed"), "0 lines added, 0 lines removed");
  await tree("shipping.ts");
  await wait(`${shadow}?.querySelector('[data-line-type="change-addition"]')`);
  await click("Mark reviewed");
  assert.match(await reviewedText(), /Commit message/);
  assert.match(await reviewedText(), /shipping.ts/);
  assert.equal(await lineStats(), "6 lines added, 1 lines removed");
  assert.equal(await lineStats("Reviewed"), "1 lines added, 1 lines removed");
  await browser("fill", '[aria-label="Find a file"]', "test/");
  assert.equal(await lineStats(), "5 lines added, 0 lines removed");
  assert.equal(await lineStats("Reviewed"), "0 lines added, 0 lines removed");
  await browser("focus", '[aria-label="Find a file"]');
  await browser("press", "Control+a");
  await browser("press", "Backspace");
  assert.doesNotMatch(
    await sectionText("Unreviewed"),
    /Commit message|shipping\.ts/,
  );
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('file-tree-container')).reduce((n, e) => n + e.shadowRoot.querySelectorAll('[role=treeitem][aria-selected=true]').length, 0)",
    ),
    1,
  );
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('file-tree-container')).map(e => Array.from(e.shadowRoot.querySelectorAll('[data-item-focused=true]')).some(row => getComputedStyle(row, '::before').outlineColor !== 'rgba(0, 0, 0, 0)'))",
    ),
    [true, false],
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.file-heading').lastElementChild.classList.contains('review-toggle')",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.segmented').getBoundingClientRect().right < document.querySelector('.review-toggle').getBoundingClientRect().left",
    ),
    true,
  );
  await capture("reviewed-files");
  await browser("focus", ".resize-handle.files");
  await browser("press", "Home");
  await capture("line-stats-narrow");
  await resizePanel("files", 72);
  await tree("shipping.test.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('console.assert')`,
  );
  await click("Mark reviewed");
  await tree("shipping.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('const baseRate')`,
  );
  await tree("shipping.test.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('console.assert')`,
  );
  await click("Mark unreviewed");
  await browser("fill", '[aria-label="Find a file"]', "shipping.ts");
  await wait(
    "document.querySelector('section[aria-label=Reviewed] file-tree-container')?.shadowRoot?.querySelector('[role=treeitem]')",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.message-nav').length"),
    0,
  );
  await tree("shipping.ts");
  await browser("focus", '[aria-label="Find a file"]');
  await browser("press", "Control+a");
  await browser("press", "Backspace");
  await wait("document.querySelector('.message-nav')");
  await click("Commit message");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Charge 12 for international orders.')`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.review-toggle').getAttribute('aria-pressed')",
    ),
    "true",
  );
  await tree("shipping.ts");
  await wait(`${shadow}?.querySelector('[data-line-type="change-addition"]')`);
  await click("Mark unreviewed");
  assert.doesNotMatch(await reviewedText(), /shipping\.ts/);
  assert.match(await sectionText("Unreviewed"), /shipping\.ts/);
  assert.equal(await lineStats(), "6 lines added, 1 lines removed");
  assert.equal(await lineStats("Reviewed"), "0 lines added, 0 lines removed");
  console.log(
    "PASS exact scope and reviewed line totals for File Browser, uncommitted changes and commits; message adds no lines",
  );
  await reviewRange();
  await click("Base revision");
  await browser("fill", '[aria-label="Search base commits"]', f.first);
  await browser("press", "Enter");
  await click("Target revision");
  await browser("fill", '[aria-label="Search target commits"]', f.second);
  await browser("press", "Enter");
  await click("Compare");
  await wait(
    "!document.querySelector('.message-nav') && !document.querySelector('.review-toggle').disabled",
  );
  assert.equal(await reviewedText(), "");
  await click("Mark reviewed");
  assert.match(await reviewedText(), /shipping\.ts/);
  await reviewCommit(f.second);
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Charge 12 for international orders.')`,
  );
  assert.match(await reviewedText(), /Commit message/);
  assert.doesNotMatch(await reviewedText(), /shipping\.ts/);
  await reviewScope("File Browser");
  await tree("shipping.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`,
  );
  await click("Mark reviewed");
  assert.match(await reviewedText(), /shipping\.ts/);
  await reviewScope("Uncommitted changes");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('pending = true')`,
  );
  assert.equal(await reviewedText(), "");
  await click("Mark reviewed");
  assert.match(await reviewedText(), /pending-after-load\.ts/);
  await browser("reload");
  await wait("document.querySelector('[aria-label=\"Review scope\"]')");
  assert.equal(await reviewedText(), "");
  await reviewScope("Uncommitted changes");
  assert.equal(await reviewedText(), "");
  await reviewCommit("Document the decision");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('No files changed.')`,
  );
  assert.match(await reviewedText(), /Commit message/);
  console.log(
    "PASS Reviewed moves files and messages without duplicates; search, selection, undo, per-comparison isolation, historical persistence and mutable-view refresh reset",
  );
  // Old/corrupt UI state must not prevent opening or clearing comments.
  // State now lives in the disk cache; corrupt it there while no page is open,
  // so the app's unload flush cannot overwrite the tampered file.
  const withComment = await loadState(f.root);
  await browser("open", "about:blank");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await saveState(f.root, { ...withComment, view: "{broken" });
  await browser("open", url);
  await wait("document.querySelector('[aria-label=\"Review scope\"]')?.textContent.includes('File Browser')");
  assert.equal((await comments()).length, 1);
  await browser("open", "about:blank");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await saveState(f.root, { ...withComment, view: { tab: "obsolete", split: "wrong-type", collapsed: null, selected: "deleted-file.ts", futureField: "unused" } });
  await browser("open", url);
  await wait("document.querySelector('[aria-label=\"Review scope\"]')?.textContent.includes('File Browser')");
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "No file selected");
  // The app re-saves its validated view, dropping unknown fields and values.
  await waitState((state) => state.view && !("futureField" in state.view) && !("tab" in state.view));
  await browser("open", "about:blank");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await saveState(f.root, { ...withComment, view: { tab: "changes", mode: "commit", appliedMode: "commit", target: "missing-commit", selected: "src/shipping.ts" } });
  await browser("open", `${url}/?mode=commit&to=missing-commit&path=src%2Fshipping.ts`);
  await wait("document.querySelector('[role=alert]')?.textContent.includes('Unknown commit')");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const beforeInvalidViewClear = await loadState(f.root);
  assert.equal(beforeInvalidViewClear.comments.length, 1);
  await click("Clear");
  await browser("dialog", "accept");
  const afterInvalidViewClear = await waitState((state) => !state.comments.length);
  assert.deepEqual(afterInvalidViewClear.view, beforeInvalidViewClear.view);
  assert.deepEqual(afterInvalidViewClear.reviewed, {});
  assert.deepEqual(await comments(), []);
  assert.match(await evaluate("document.querySelector('[role=alert]').textContent"), /Unknown commit/);
  console.log("PASS corrupt/obsolete view state falls back safely; Clear removes comments without changing an invalid saved view");

  const unusualPath = "src/space #?&+% ü.ts";
  await f.write(unusualPath, "export const unusual = true;\n");
  await browser("open", url);
  await wait("document.querySelector('file-tree-container')?.shadowRoot?.querySelector('[data-item-path=\"src/space #?&+% ü.ts\"]')");
  await tree("space #?&+% ü.ts");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('unusual = true')`);
  const unusualURL = await evaluate("location.href");
  assert.equal(new URL(unusualURL).searchParams.get("path"), unusualPath);
  await browser("tab", "new", unusualURL);
  const commentTab = (await browser("tab", "list")).tabs.find((tab) => tab.tabId !== originalTab);
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('unusual = true')`);
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), unusualPath);
  await line(1);
  await browser("fill", "#comment-text", "Keep this comment from the other tab.");
  await click("Add comment");
  await waitState((state) => state.comments.length === 1);
  await browser("tab", originalTab);
  assert.deepEqual(await comments(), []); // This tab still has its older snapshot.
  await browser("press", "f");
  await browser("fill", '[aria-label="Fuzzy find file"]', "README.md");
  await browser("press", "Enter");
  await click("Wrap long lines");
  const savedWrap = await evaluate("document.querySelector('[aria-label=\"Wrap long lines\"]').getAttribute('aria-pressed') === 'true'");
  const preserved = await waitState((state) => state.view.wrap === savedWrap);
  assert.equal(preserved.comments[0].text, "Keep this comment from the other tab.");
  await browser("tab", "close", commentTab.tabId);
  console.log("PASS URLs round-trip reserved characters and Unicode; navigation and preference saves preserve another tab's newer comments");

  // Native browser find cannot see lines which CodeView has virtualized out of
  // the DOM. Cmd/Ctrl+F must navigate to every source occurrence, then create
  // an exact range after the tokenized line appears in the shadow DOM.
  const longLines = Array.from({ length: 650 }, (_, index) =>
    index === 419 || index === 579
      ? `const distantSearchTarget${index + 1} = "const distantSearchTarget";`
      : `const value${index + 1} = ${index + 1};`,
  );
  await f.write("src/long.ts", `${longLines.join("\n")}\n`);
  await browser("open", `${url}/?mode=files&path=src%2Flong.ts`);
  await wait("document.querySelector('.file-path')?.textContent === 'src/long.ts'");
  assert.equal(
    await evaluate(`${shadow}.textContent.includes('distantSearchTarget')`),
    false,
    "The regression fixture must begin outside the virtualized DOM window",
  );
  await browser("press", "Control+f");
  await browser("fill", '[aria-label="Find in viewed file"]', "const distantSearchTarget");
  await wait("document.querySelector('.text-search span')?.textContent === '1/4'");
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.startContainer.isConnected");
  const firstOccurrence = await activeSearchHighlight();
  assert.deepEqual(
    { text: firstOccurrence.text, line: firstOccurrence.line },
    { text: "const distantSearchTarget", line: 420 },
  );
  const otherOccurrences = await otherSearchHighlights();
  assert.deepEqual(otherOccurrences.map(({ text }) => text), ["const distantSearchTarget"]);
  assert.notEqual(otherOccurrences[0].left, firstOccurrence.left);
  await browser("press", "Meta+g");
  await wait("document.querySelector('.text-search span')?.textContent === '2/4'");
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.startContainer.isConnected");
  const secondOccurrence = await activeSearchHighlight();
  assert.equal(secondOccurrence.line, 420);
  assert.equal(secondOccurrence.text, "const distantSearchTarget");
  assert.notEqual(secondOccurrence.left, firstOccurrence.left);
  await browser("press", "Meta+Shift+g");
  await wait("document.querySelector('.text-search span')?.textContent === '1/4'");
  await browser("press", "Control+g");
  await wait("document.querySelector('.text-search span')?.textContent === '2/4'");
  await browser("press", "Enter");
  await wait("document.querySelector('.text-search span')?.textContent === '3/4'");
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.toString() === 'const distantSearchTarget' && Array.from(CSS.highlights.get('rv-text-search'))[0].startContainer.isConnected");
  assert.equal((await activeSearchHighlight()).line, 580);
  await browser("press", "Shift+Enter");
  await wait("document.querySelector('.text-search span')?.textContent === '2/4'");
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.toString() === 'const distantSearchTarget' && Array.from(CSS.highlights.get('rv-text-search'))[0].startContainer.isConnected");
  assert.equal((await activeSearchHighlight()).line, 420);
  await browser("fill", '[aria-label="Find in viewed file"]', '= "const');
  await wait("document.querySelector('.text-search span')?.textContent === '1/2'");
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.toString() === '= \"const' && Array.from(CSS.highlights.get('rv-text-search'))[0].startContainer.isConnected");
  await wait(`${shadow}.querySelector('[data-line="420"]')?.querySelectorAll('span').length > 1`);
  const tokenSpanningOccurrence = await activeSearchHighlight();
  assert.deepEqual(
    {
      text: tokenSpanningOccurrence.text,
      line: tokenSpanningOccurrence.line,
      acrossTokens: tokenSpanningOccurrence.acrossTokens,
    },
    { text: '= "const', line: 420, acrossTokens: true },
  );
  await capture("occurrence-search");
  await browser("press", "Escape");
  assert.equal(await evaluate("Boolean(document.querySelector('.text-search'))"), false);
  assert.equal(await evaluate("CSS.highlights.has('rv-text-search')"), false);
  assert.equal(await evaluate("CSS.highlights.has('rv-text-search-matches')"), false);
  console.log("PASS Cmd/Ctrl+F highlights occurrences; Cmd/Ctrl+G navigates forward, Shift reverses, and matches span tokens and virtualized lines");

  // Diffs can use the same line number on both sides. Preserve the source
  // match's side when locating its rendered range.
  await f.write("src/search-sides.ts", 'const value = "sideTarget old";\n');
  f.git("add", "src/search-sides.ts");
  f.git("commit", "-qm", "Add occurrence search side fixture");
  await f.write("src/search-sides.ts", 'const value = "sideTarget new";\n');
  await browser("open", `${url}/?mode=working&path=src%2Fsearch-sides.ts`);
  await wait("document.querySelector('.file-tree') && !document.querySelector('.loading')");
  await tree("search-sides.ts");
  await wait(`${shadow}?.querySelector('[data-diff]')`);
  await browser("press", "Control+f");
  await browser("fill", '[aria-label="Find in viewed file"]', "sideTarget");
  await wait("document.querySelector('.text-search span')?.textContent === '1/2'");
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.startContainer.isConnected");
  assert.equal((await activeSearchHighlight()).side, "deletions");
  assert.deepEqual((await otherSearchHighlights()).map(({ text }) => text), ["sideTarget"]);
  await browser("press", "Enter");
  await wait("document.querySelector('.text-search span')?.textContent === '2/2'");
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.startContainer.isConnected");
  assert.equal((await activeSearchHighlight()).side, "additions");
  await browser("press", "Escape");
  console.log("PASS occurrence search preserves deletion/addition sides in split diffs");

  // Selecting code uses occurrence highlighting without opening the find UI.
  // The selected occurrence, rather than the first source occurrence, stays active.
  await f.write(
    "src/selection.ts",
    "const first = 'selectionTarget';\nconst second = 'selectionTarget';\n",
  );
  await browser("open", `${url}/?mode=files&path=src%2Fselection.ts`);
  await wait(`${shadow}?.querySelector('[data-line="2"]')?.textContent.includes('selectionTarget')`);
  await selectCodeText("selectionTarget", 1);
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.startContainer.isConnected");
  assert.equal(await evaluate("Boolean(document.querySelector('.text-search'))"), false);
  assert.deepEqual(
    { text: (await activeSearchHighlight()).text, line: (await activeSearchHighlight()).line },
    { text: "selectionTarget", line: 2 },
  );
  assert.deepEqual((await otherSearchHighlights()).map(({ text }) => text), ["selectionTarget"]);
  await capture("text-selection-file");
  console.log("PASS selecting text in a file highlights the selection and other matches without opening find");

  await browser("open", `${url}/?mode=working&path=src%2Fsearch-sides.ts`);
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('sideTarget new')`);
  await selectCodeText("sideTarget", 1);
  await wait("Array.from(CSS.highlights.get('rv-text-search') || [])[0]?.startContainer.isConnected");
  assert.equal(await evaluate("Boolean(document.querySelector('.text-search'))"), false);
  assert.equal((await activeSearchHighlight()).side, "additions");
  assert.deepEqual((await otherSearchHighlights()).map(({ text }) => text), ["sideTarget"]);
  await capture("text-selection-diff");
  console.log("PASS selecting text in a diff highlights the selected side and the other match without opening find");

  await browser("fill", 'textarea[placeholder="Add feedback not tied to a file…"]', "Verify the copied prompt modal.");
  await click("Add general comment");
  await browser("click", ".copy");
  await wait("document.querySelector('[role=dialog] h2')?.textContent === 'Prompt copied to clipboard'");
  assert.equal(await evaluate("document.activeElement.textContent"), "Clear");
  assert.match(
    await evaluate("document.querySelector('[aria-label=\"Copied prompt\"]').value"),
    /Verify the copied prompt modal\./,
  );
  await browser("press", "Enter");
  await wait("!document.querySelector('[role=dialog]') && document.querySelector('.copy').disabled");
  assert.equal(await evaluate("document.querySelectorAll('.comment').length"), 0);
  console.log("PASS copied prompt modal shows the prompt; Keep Comments preserves review state; Enter defaults to Clear");

  const errors = await browser("errors");
  assert.deepEqual(errors.errors, []);
  console.log("PASS no browser errors\nBrowser verification complete.");
} catch (error) {
  console.error(
    "Browser state at failure:",
    await evaluate("document.body.innerText"),
  );
  console.error("Browser errors:", await browser("errors"));
  throw error;
} finally {
  await browser("close").catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await f.cleanup();
}
