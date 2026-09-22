// Run after npm run build. Requires agent-browser and its Chromium installation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";
import { fixture } from "./fixture.js";

const exec = promisify(execFile);
const f = await fixture();
const server = createApp(await repository(f.root));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const session = `rv-test-${process.pid}`;
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
async function hoverTree(name, section = "Unreviewed") {
  const point = await evaluate(`(() => {
    const tree = document.querySelector('section[aria-label="${section}"] file-tree-container');
    const item = Array.from(tree.shadowRoot.querySelectorAll('[role=treeitem]'))
      .find(item => item.getAttribute('aria-label') === ${JSON.stringify(name)});
    const rect = item.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  await browser("mouse", "move", String(point.x), String(point.y));
}
const shadow = "document.querySelector('diffs-container')?.shadowRoot";
const lineStats = (section = "Unreviewed") =>
  evaluate(
    `document.querySelector('section[aria-label="${section}"] .line-stats')?.getAttribute('aria-label')`,
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
  await browser("open", url);
  await browser("set", "viewport", "1440", "900", "2");
  await wait("document.querySelector('.file-tree')");
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
  await browser("press", "?");
  await browser("wait", '[aria-label="Search keyboard shortcuts"]');
  assert.equal(
    await evaluate("document.querySelector('[role=dialog]').getAttribute('aria-labelledby')"),
    "shortcut-title",
  );
  await browser("fill", '[aria-label="Search keyboard shortcuts"]', "copy");
  assert.deepEqual(
    await evaluate("Array.from(document.querySelectorAll('.shortcut-row')).map(e => e.textContent.trim())"),
    ["Copy review promptReviewY"],
  );
  await capture("keyboard-shortcuts-search");
  await browser("press", "Escape");
  await wait("!document.querySelector('.shortcut-dialog')");
  assert.equal(await lineStats(), "6 lines added, 3 lines removed");
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
    { outer: "solid", inner: "none" },
  );
  await browser("fill", '[aria-label="Find a file"]', "shipping");
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
  await browser("press", "c");
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), true);
  await browser("press", "c");
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), false);
  await browser("press", "g");
  await browser("press", "c");
  await wait("document.querySelector('.tabs .active').textContent.includes('Changes')");
  await browser("press", "v");
  assert.equal(
    await evaluate("document.querySelector('.segmented button:last-child').getAttribute('aria-pressed')"),
    "true",
  );
  await browser("press", "v");
  await browser("press", "g");
  await browser("press", "f");
  await wait("document.querySelector('.tabs .active').textContent.includes('Files')");
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
    await evaluate("Array.from(document.querySelectorAll('.finder-results button')).map(e => ({ path: e.querySelector('.finder-path').textContent, state: e.querySelector('.finder-state').textContent.trim() }))"),
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
  assert.match(await evaluate("document.querySelector('.tabs .active').textContent"), /Files/);
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "src/shipping.ts");
  await tree("src");
  await browser("press", "ArrowLeft");
  await wait(`JSON.parse(localStorage.getItem(${JSON.stringify(`rv:view:${f.root}`)})).collapsed.includes('src/')`);
  await browser("reload");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`);
  const srcFolder = "document.querySelector('file-tree-container').shadowRoot.querySelector('[role=treeitem][aria-label=src]')";
  assert.equal(await evaluate(`${srcFolder}.getAttribute('aria-expanded')`), "false");
  await browser("fill", '[aria-label="Find a file"]', "shipping.ts");
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
    await evaluate("Boolean(document.querySelector('[role=dialog]'))"),
    false,
  );
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

  await click("Changes 3");
  await wait(`${shadow}?.querySelector('[data-line-type="change-addition"]')`);
  assert.equal(await lineStats(), "6 lines added, 4 lines removed");
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
  assert.match(await evaluate("document.querySelector('.tabs .active').textContent"), /Changes/);
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
  await click("Split");
  await wait(`${shadow}?.querySelector('[data-diff-type="split"]')`);
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
  await browser("select", '[aria-label="Review source"]', "commit");
  await click("Commit revision");
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.commit-options time')).map(e => e.textContent)",
    ),
    ["10m ago", "3h ago", "2d ago"],
  );
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('.commit-options time')).map(e => ({date:e.dateTime, title:e.title}))",
    ),
    [...f.dates]
      .reverse()
      .map((date) => ({ date, title: date.replace("T", " ") })),
  );
  await browser("hover", ".commit-options button:nth-child(2) time");
  await capture("commit-timestamps");
  await browser("fill", '[aria-label="Search commits"]', f.second);
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
  assert.match(await evaluate("document.querySelector('[aria-label=\"Commit revision\"]').textContent"), /Add international shipping rates/);
  await wait(`${shadow}?.querySelector('[data-diff-type="split"]')`);
  console.log("PASS reload restores a non-default commit, its selected file and split layout");
  await click("Commit revision");
  await browser("fill", '[aria-label="Search commits"]', f.first);
  await browser("press", "Enter");
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

  await browser("select", '[aria-label="Review source"]', "range");
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
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Review source\"]').value"), "range");
  assert.match(await evaluate("document.querySelector('[aria-label=\"Target revision\"]').textContent"), /Introduce free shipping threshold/);
  console.log("PASS unsubmitted range pickers survive reload without changing the applied commit");
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
    "PASS full-field search focus ring; range pickers browse/search by message/hash, keyboard and custom Git refs",
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
  await browser("select", '[aria-label="Review source"]', "working");
  await browser("click", ".comment:nth-child(4) p");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 100')`,
  );
  assert.doesNotMatch(await codeText(), /THRESHOLD = 75/);
  assert.equal(
    await evaluate(
      "document.querySelector('[aria-label=\"Review source\"]').value",
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
  assert.match(await evaluate("document.querySelector('[aria-label=\"Base revision\"]').textContent"), /nonexistent-ref/);
  // Refresh restores the successful comparison, not the failed draft ref.
  await browser("select", '[aria-label="Review source"]', "working");
  await browser("click", ".tabs button:first-child");
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
  f.git("add", ".");
  f.git("commit", "-qm", "Clean checkpoint");
  await browser("reload");
  await wait(
    "document.querySelector('.tabs')?.textContent.includes('Changes 0')",
  );
  await tree("long.ts");
  await wait(`${shadow}?.querySelector('pre')?.textContent.includes('export const line1 = 1;')`);
  await evaluate(
    `document.querySelector('.code-view').scrollTop = 150 * parseFloat(getComputedStyle(${shadow}.querySelector('[data-column-number="1"]')).lineHeight)`,
  );
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
  await click("Changes 0");
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
  await click("↻ Refresh");
  await wait(
    "document.querySelector('.tabs')?.textContent.includes('Changes 1')",
  );
  await click("Changes 1");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('pending = true')`,
  );
  await browser("select", '[aria-label="Review source"]', "commit");
  await click("Commit revision");
  await browser("fill", '[aria-label="Search commits"]', "Commit created after page load");
  await browser("press", "Enter");
  await wait("document.querySelector('[aria-label=\"Commit revision\"]')?.textContent.includes('Commit created after page load')");
  assert.equal((await comments()).length, 2);
  console.log(
    "PASS clean state stays unchanged after a new commit + edit + focus; zero background API calls; refresh reveals both",
  );
  await click("Commit revision");
  await browser("fill", '[aria-label="Search commits"]', f.second);
  await browser("press", "Enter");
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
    await evaluate("Boolean(document.querySelector('[role=dialog]'))"),
    false,
  );
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
  await evaluate("localStorage.setItem('rv:comments:/another-repo', 'keep me')");
  const beforeReset = await evaluate("JSON.stringify({...localStorage})");
  await click("Reset");
  assert.match(JSON.stringify(await browser("dialog", "status")), /All comments, review progress and view settings/);
  await browser("dialog", "dismiss");
  assert.equal(await evaluate("JSON.stringify({...localStorage})"), beforeReset);
  assert.equal((await comments()).length, 3);
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), true);
  await capture("reset-cancelled");
  await click("Reset");
  await browser("dialog", "accept");
  await wait("document.querySelector('.toolbar-label')?.textContent === 'Repository files'");
  assert.deepEqual(await comments(), []);
  assert.equal(
    await evaluate("document.querySelector('.copy').disabled"),
    true,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.comment-marker').length"),
    0,
  );
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "No file selected");
  assert.equal(await evaluate("document.querySelector('#review-comments').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#file-browser').getBoundingClientRect().width"), 232);
  assert.equal(await evaluate("document.querySelector('#review-comments').getBoundingClientRect().width"), 310);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(`rv:reviewed:${f.root}`)})`), "{}");
  assert.equal(await evaluate("localStorage.getItem('rv:comments:/another-repo')"), "keep me");
  assert.doesNotMatch(await evaluate("document.body.textContent"), /Clear Comments|Undo/);
  await capture("review-reset");
  await browser("reload");
  await wait("document.querySelector('.comments-panel')");
  assert.deepEqual(await comments(), []);
  console.log(
    "PASS Reset confirmation cancels without changes; confirmed reset clears comments, progress and view state only for this repository, persists across reload",
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
  await wait("document.querySelector('.tabs')");
  await click("Changes 1");
  await browser("select", '[aria-label="Review source"]', "commit");
  await click("Commit revision");
  await browser("fill", '[aria-label="Search commits"]', "Document the decision");
  await browser("press", "Enter");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('No files changed.')`,
  );
  assert.match(
    await evaluate("document.querySelector('.tabs').textContent"),
    /Changes 0/,
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
  await click("Commit revision");
  await browser("fill", '[aria-label="Search commits"]', f.second);
  await browser("press", "Enter");
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
  assert.equal(await lineStats(), "5 lines added, 0 lines removed");
  assert.equal(await lineStats("Reviewed"), "1 lines added, 1 lines removed");
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
    "PASS exact section line totals for Files, Working tree and commits; totals move on review/unreview, message adds no lines",
  );
  await browser("select", '[aria-label="Review source"]', "range");
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
  await browser("select", '[aria-label="Review source"]', "commit");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('Charge 12 for international orders.')`,
  );
  assert.match(await reviewedText(), /Commit message/);
  assert.doesNotMatch(await reviewedText(), /shipping\.ts/);
  await click("Files 8");
  await tree("shipping.ts");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('THRESHOLD = 75')`,
  );
  await click("Mark reviewed");
  assert.match(await reviewedText(), /shipping\.ts/);
  await click("Changes 2");
  await browser("select", '[aria-label="Review source"]', "working");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('pending = true')`,
  );
  assert.equal(await reviewedText(), "");
  await click("Mark reviewed");
  assert.match(await reviewedText(), /pending-after-load\.ts/);
  await browser("reload");
  await wait("document.querySelector('.tabs')");
  assert.equal(await reviewedText(), "");
  await click("Changes 1");
  assert.equal(await reviewedText(), "");
  await browser("select", '[aria-label="Review source"]', "commit");
  await click("Commit revision");
  await browser("fill", '[aria-label="Search commits"]', "Document the decision");
  await browser("press", "Enter");
  await wait(
    `${shadow}?.querySelector('pre')?.textContent.includes('No files changed.')`,
  );
  assert.match(await reviewedText(), /Commit message/);
  console.log(
    "PASS Reviewed moves files and messages without duplicates; search, selection, undo, per-comparison isolation, historical persistence and mutable-view refresh reset",
  );
  // Old/corrupt UI state must not prevent opening or resetting a repository.
  const viewKey = JSON.stringify(`rv:view:${f.root}`);
  await evaluate(`localStorage.setItem(${viewKey}, '{broken')`);
  await browser("reload");
  await wait("document.querySelector('.toolbar-label')?.textContent === 'Repository files'");
  assert.equal((await comments()).length, 1);
  await evaluate(`localStorage.setItem(${viewKey}, JSON.stringify({tab:'obsolete', split:'wrong-type', collapsed:null, selected:'deleted-file.ts', futureField:'unused'}))`);
  await browser("reload");
  await wait("document.querySelector('.toolbar-label')?.textContent === 'Repository files'");
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "No file selected");
  assert.equal(await evaluate(`'futureField' in JSON.parse(localStorage.getItem(${viewKey}))`), false);
  await evaluate(`localStorage.setItem(${viewKey}, JSON.stringify({tab:'changes', mode:'commit', appliedMode:'commit', target:'missing-commit', selected:'src/shipping.ts'}))`);
  await browser("reload");
  await wait("document.querySelector('[role=alert]')?.textContent.includes('Unknown commit')");
  await click("Reset");
  await browser("dialog", "accept");
  await wait("document.querySelector('.toolbar-label')?.textContent === 'Repository files'");
  assert.deepEqual(await comments(), []);
  console.log("PASS corrupt/obsolete view state falls back safely; missing commits remain recoverable with Reset");
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
