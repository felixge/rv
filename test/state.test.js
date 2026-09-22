import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearState, loadState, saveState, statePath } from "../server/state.js";
import { createApp } from "../server/http.js";
import { repository } from "../server/repository.js";
import { fixture } from "./fixture.js";

async function cacheDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "rv-cache-"));
  process.env.RV_CACHE_DIR = dir;
  return dir;
}

test("state is a per-repository cache file in RV_CACHE_DIR", async (t) => {
  const dir = await cacheDir();
  t.after(() => delete process.env.RV_CACHE_DIR);
  const f = await fixture();
  t.after(f.cleanup);

  assert.equal(await loadState(f.root), null);
  await saveState(f.root, { comments: [{ id: "c1" }], reviewed: {} });
  // One readable directory per opened path, pi-style:
  // ~/.cache/rv/--tmp-rv-review-x--/state.json
  const expectedDir = path.join(
    dir,
    `--${f.root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  const file = statePath(f.root);
  assert.equal(file, path.join(expectedDir, "state.json"));
  assert.deepEqual(await readdir(dir), [path.basename(expectedDir)]);
  assert.deepEqual(await loadState(f.root), { comments: [{ id: "c1" }], reviewed: {} });

  // The file records which repository it belongs to and is written atomically.
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.root, f.root);

  // Path encoding is lossy: /tmp/rv-review-x and /tmp/rv/review-x encode to
  // the same directory, so a mismatched root never serves another
  // repository's state.
  const colliding = f.root.replace(/-/, "/");
  assert.equal(statePath(colliding), statePath(f.root));
  assert.equal(await loadState(colliding), null);

  // A second repository never sees the first one's state.
  const other = await fixture();
  t.after(other.cleanup);
  assert.equal(await loadState(other.root), null);

  await clearState(f.root);
  assert.equal(await loadState(f.root), null);
});

test("malformed cache files are ignored, not fatal", async (t) => {
  const dir = await cacheDir();
  t.after(() => delete process.env.RV_CACHE_DIR);
  const f = await fixture();
  t.after(f.cleanup);
  const { writeFile } = await import("node:fs/promises");
  await saveState(f.root, { comments: [] });
  await writeFile(statePath(f.root), "{truncated");
  assert.equal(await loadState(f.root), null);
  await writeFile(statePath(f.root), "[1,2]");
  assert.equal(await loadState(f.root), null);
});

test("the state API round-trips browser state to disk", async (t) => {
  const dir = await cacheDir();
  t.after(() => delete process.env.RV_CACHE_DIR);
  const f = await fixture();
  t.after(f.cleanup);
  const repo = await repository(f.root);
  const server = createApp(repo);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { "X-Rv": "1", "Content-Type": "application/json" };

  assert.deepEqual(await (await fetch(`${url}/api/state`, { headers })).json(), {});

  const state = {
    view: { tab: "changes", mode: "working", split: true },
    reviewed: {},
    comments: [{ id: "c1", path: "src/shipping.ts", start: 3, end: 3, text: "Hi" }],
  };
  assert.equal(
    (await fetch(`${url}/api/state`, { method: "PUT", headers, body: JSON.stringify(state) }))
      .status,
    200,
  );
  assert.deepEqual(await (await fetch(`${url}/api/state`, { headers })).json(), state);
  // The same state is on disk, so a restarted server serves it again.
  assert.deepEqual(await loadState(f.root), state);

  assert.equal((await fetch(`${url}/api/state`, { method: "DELETE", headers })).status, 200);
  assert.deepEqual(await (await fetch(`${url}/api/state`, { headers })).json(), {});
  assert.equal(await loadState(f.root), null);
});

test("the state API rejects junk, oversize bodies and other methods", async (t) => {
  const dir = await cacheDir();
  t.after(() => delete process.env.RV_CACHE_DIR);
  const f = await fixture();
  t.after(f.cleanup);
  const server = createApp(await repository(f.root));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { "X-Rv": "1" };

  assert.equal(
    (await fetch(`${url}/api/state`, { method: "PUT", headers, body: "{nope" })).status,
    400,
  );
  assert.equal(
    (await fetch(`${url}/api/state`, { method: "PUT", headers, body: "[1,2]" })).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${url}/api/state`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 1) }),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(`${url}/api/state`, { method: "POST", headers, body: "{}" })).status,
    405,
  );
  // Same-origin rules apply to state writes like every other API call.
  assert.equal(
    (await fetch(`${url}/api/state`, { method: "PUT", body: "{}" })).status,
    403,
  );
  assert.equal(await loadState(f.root), null);
});
