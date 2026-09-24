import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createAgentChannel, createApp } from "../server/http.js";
import { repository } from "../server/repository.js";
import {
  clearAgentSession,
  loadAgentSession,
  loadState,
  saveAgentSession,
  saveState,
} from "../server/state.js";
import { fixture } from "./fixture.js";

const exec = promisify(execFile);
const headers = { "X-Rv": "1" };

test("--skill prints standalone agent integration instructions", async () => {
  const { stdout, stderr } = await exec(
    process.execPath,
    [path.resolve("bin/rv.js"), "--skill"],
    { cwd: tmpdir() },
  );
  assert.equal(stderr, "");
  assert.match(stdout, /rv --agent.*long-running process/);
  assert.match(stdout, /rv --wait.*prints the exact prompt to stdout/s);
  assert.match(stdout, /run "rv --wait" again/);
  assert.doesNotMatch(stdout, /directory/);
  assert.match(stdout, /successful submission clears its comments/);
});

test("closing an agent channel releases a pending wait", async () => {
  const agent = createAgentChannel("token");
  const pending = agent.wait();
  agent.close();
  await assert.rejects(pending.promise, /Agent session stopped/);
});

test("agent submissions queue for rv --wait and clear only comments", async (t) => {
  const cache = await mkdtemp(path.join(tmpdir(), "rv-agent-cache-"));
  process.env.RV_CACHE_DIR = cache;
  const f = await fixture();
  t.after(() => delete process.env.RV_CACHE_DIR);
  t.after(() => rm(cache, { recursive: true, force: true }));
  t.after(f.cleanup);
  const token = "test-agent-token";
  const agent = createAgentChannel(token);
  const server = createApp(await repository(f.root), { agent });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://localhost:${server.address().port}`;
  await saveAgentSession(f.root, { url, token });
  await saveState(f.root, {
    comments: [{ id: "c1", text: "Fix the edge case." }],
    reviewed: { scope: ["src/shipping.ts"] },
  });

  const info = await fetch(`${url}/api/info`, { headers });
  assert.equal((await info.json()).agent, true);
  assert.equal(
    (await fetch(`${url}/api/agent/status`, { headers })).status,
    403,
  );

  const waiting = exec(
    process.execPath,
    [path.resolve("bin/rv.js"), f.root, "--wait"],
    { env: { ...process.env, RV_CACHE_DIR: cache } },
  );
  const prompt = "src/shipping.ts:4\nHandle free shipping.";
  const submitted = await fetch(`${url}/api/agent/submit`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "text/plain" },
    body: prompt,
  });
  assert.equal(submitted.status, 200);
  assert.equal((await waiting).stdout, `${prompt}\n`);
  assert.deepEqual(await loadState(f.root), {
    comments: [],
    reviewed: { scope: ["src/shipping.ts"] },
  });

  // A submission made between wait commands remains queued for the next one.
  const queued = "README.md:2\nClarify setup.";
  assert.equal(
    (await fetch(`${url}/api/agent/submit`, {
      method: "POST",
      headers,
      body: queued,
    })).status,
    200,
  );
  assert.equal(
    (await exec(
      process.execPath,
      [path.resolve("bin/rv.js"), f.root, "--wait"],
      { env: { ...process.env, RV_CACHE_DIR: cache } },
    )).stdout,
    `${queued}\n`,
  );

  await clearAgentSession(f.root, "another-token");
  assert.deepEqual(await loadAgentSession(f.root), { url, token });
  await clearAgentSession(f.root.replace(/-/, "/"), token);
  assert.deepEqual(await loadAgentSession(f.root), { url, token });
  await clearAgentSession(f.root, token);
  assert.equal(await loadAgentSession(f.root), null);
});

test("submitting without agent mode fails without clearing comments", async (t) => {
  const cache = await mkdtemp(path.join(tmpdir(), "rv-agent-cache-"));
  process.env.RV_CACHE_DIR = cache;
  const f = await fixture();
  t.after(() => delete process.env.RV_CACHE_DIR);
  t.after(() => rm(cache, { recursive: true, force: true }));
  t.after(f.cleanup);
  await saveState(f.root, { comments: [{ id: "c1", text: "Keep me" }] });
  const server = createApp(await repository(f.root));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;

  const info = await fetch(`${url}/api/info`, { headers });
  assert.equal((await info.json()).agent, false);
  assert.equal(
    (await fetch(`${url}/api/agent/submit`, {
      method: "POST",
      headers,
      body: "A prompt",
    })).status,
    404,
  );
  assert.deepEqual(await loadState(f.root), {
    comments: [{ id: "c1", text: "Keep me" }],
  });
});
