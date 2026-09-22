// Run after npm run build. Measures in-page key-to-render time, not CLI latency.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "difflet-navigation-"));
const session = `nav-${process.pid}`;
const browser = async (...args) => {
  const { stdout } = await exec("agent-browser", ["--session", session, "--json", ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  assert.equal(response.success, true, stdout);
  return response.data;
};
const evaluate = async (code) => (await browser("eval", code)).result;
const git = (...args) => exec("git", ["-C", root, ...args]);
let server;
try {
  await git("init", "-q");
  await git("config", "user.name", "Navigation Test");
  await git("config", "user.email", "test@example.invalid");
  const source = (name, changed) => Array.from({ length: 2000 }, (_, i) =>
    `export const ${name}_${i} = { label: "${name}", value: ${i + (changed && i % 7 === 0 ? 1 : 0)} };\n`,
  ).join("");
  for (const name of ["alpha", "beta", "gamma"])
    await writeFile(path.join(root, `${name}.ts`), source(name, false));
  await git("add", ".");
  await git("commit", "-qm", "Initial files");
  for (const name of ["alpha", "beta", "gamma"])
    await writeFile(path.join(root, `${name}.ts`), source(name, true));
  server = createApp(await repository(root));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await browser("open", `http://127.0.0.1:${server.address().port}`);
  await browser("set", "viewport", "1440", "900", "2");
  await browser("wait", "[aria-label='Find a file']");
  await evaluate(`(() => {
    window.highlightRequests = 0;
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.type === 'file' || message.type === 'diff') window.highlightRequests++;
      return postMessage.call(this, message, ...args);
    };
    window.navigate = async (key, name) => {
      const start = performance.now();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      while (performance.now() - start < 10000) {
        await new Promise(requestAnimationFrame);
        const pre = document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
        if (document.querySelector('.file-path')?.textContent === name + '.ts' &&
            pre?.textContent.includes(name + '_0') && pre.querySelector('span[style]')) {
          return performance.now() - start;
        }
      }
      throw new Error('Navigation did not render highlighted ' + name);
    };
  })()`);
  for (const mode of ["Files", "Unified", "Split"]) {
    if (mode === "Files") {
      await browser("click", ".tabs button:first-child");
    } else if (mode === "Unified") {
      await browser("click", ".tabs button:nth-child(2)");
    } else {
      await browser("find", "role", "button", "click", "--name", "Split", "--exact");
    }
    await browser("find", "role", "treeitem", "click", "--name", "alpha.ts", "--exact");
    await browser("wait", "--fn", "document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre')?.textContent.includes('alpha_0')");
    const cold = await evaluate(`(async () => [
      await navigate('j', 'beta'), await navigate('j', 'gamma'), await navigate('j', 'alpha')
    ])()`);
    const requestsBefore = await evaluate("highlightRequests");
    assert.ok(requestsBefore > 0, "Highlighting must run in workers, not block the UI thread");
    const apiRequests = () => evaluate("performance.getEntriesByType('resource').filter(e => e.name.includes('/api/file?')).length");
    const filesBefore = await apiRequests();
    const warm = await evaluate(`(async () => {
      const times = [];
      for (let i = 0; i < 3; i++) {
        times.push(await navigate('k', 'gamma'));
        times.push(await navigate('k', 'beta'));
        times.push(await navigate('k', 'alpha'));
      }
      return times;
    })()`);
    const requestsAfter = await evaluate("highlightRequests");
    const sorted = [...warm].sort((a, b) => a - b);
    console.log(`${mode}: first visits ${cold.map(n => Math.round(n)).join('/')} ms; warm median ${Math.round(sorted[4])} ms, max ${Math.round(sorted.at(-1))} ms; highlight jobs on revisits ${requestsAfter - requestsBefore}`);
    assert.equal(requestsAfter, requestsBefore, "Revisits must reuse syntax highlighting");
    assert.equal(await apiRequests(), filesBefore, "Revisits must reuse file contents");
    // Broad budget to catch the original ~1–2 second stalls without frame-time flakiness.
    assert.ok(sorted[4] < 300, `${mode} warm navigation median exceeds 300 ms`);
    if (process.env.SCREENSHOTS) {
      await mkdir(process.env.SCREENSHOTS, { recursive: true });
      await browser("screenshot", path.resolve(process.env.SCREENSHOTS, `navigation-${mode.toLowerCase()}.png`));
    }
  }

  // Clear all page caches, then navigate faster than cold highlighting completes.
  await browser("reload");
  await browser("wait", "[aria-label='Find a file']");
  const rapid = await evaluate(`(async () => {
    const steps = [['j', 'beta'], ['j', 'gamma'], ['k', 'beta'], ['k', 'alpha'], ['k', 'gamma']];
    const times = [];
    for (const [key, name] of steps) {
      const start = performance.now();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      while (document.querySelector('.file-path')?.textContent !== name + '.ts') {
        if (performance.now() - start > 3000) throw new Error('Lost navigation key: ' + key);
        await new Promise(requestAnimationFrame);
      }
      times.push(performance.now() - start);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return times;
  })()`);
  await browser("wait", "--fn", "document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre')?.textContent.includes('gamma_0')");
  // Let obsolete highlight responses arrive; they must not replace the last selection.
  await evaluate("new Promise(resolve => setTimeout(resolve, 1500))");
  assert.equal(await evaluate("document.querySelector('.file-path').textContent"), "gamma.ts");
  assert.equal(await evaluate("document.querySelector('diffs-container').shadowRoot.querySelector('pre').textContent.includes('gamma_0')"), true);
  assert.ok(Math.max(...rapid) < 300, "Cold highlighting must not stall rapid j/k selection");
  console.log(`PASS rapid cold j/j/k/k/k navigation; slowest selection ${Math.round(Math.max(...rapid))} ms; no stale content`);
  assert.equal((await browser("errors")).errors?.length || 0, 0);
  console.log("PASS large-file j/k navigation renders the selected file in Files, Unified and Split");
} finally {
  await browser("close").catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
