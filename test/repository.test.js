import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";
import { formatPrompt } from "../src/prompt.js";
import { fixture } from "./fixture.js";

test("working tree includes staged, unstaged, deleted and untracked changes, not ignored files", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const repo = await repository(path.join(f.root, "src"));
  const info = await repo.info();
  // Opening a subdirectory reviews only that directory, with scope-relative paths.
  assert.equal(repo.root, path.join(f.root, "src"));
  assert.deepEqual(info.files, ["discount.ts", "shipping.ts"]);
  await f.write("src/ignored/secret.txt", "not in the browser");
  assert.ok(!(await repo.info()).files.includes("ignored/secret.txt"));
  assert.deepEqual(info.working.entries, [
    { path: "discount.ts", status: "U", additions: 3, deletions: 0 },
    { path: "legacy.ts", status: "D", additions: 0, deletions: 1 },
    { path: "shipping.ts", status: "M", additions: 3, deletions: 3 },
  ]);
  assert.equal(info.commits.length, 3); // commit history stays repository-wide
  const commit = await repo.compare("commit", "", f.second);
  assert.deepEqual(commit.entries, [
    { path: "shipping.ts", status: "M", additions: 1, deletions: 1 },
  ]);
  // The Files explorer shows total lines of code per current file,
  // keyed like the file list, so scoped runs use scope-relative paths.
  assert.ok(info.lineCounts["shipping.ts"] > 0);
  assert.ok(!("legacy.ts" in info.lineCounts));
  // A staged deletion stays reviewable but absent from Files; recreating it
  // makes it a current file again, even while its deletion remains staged.
  f.git("add", "src/legacy.ts");
  assert.ok(!(await repo.info()).files.includes("legacy.ts"));
  await f.write("src/legacy.ts", "recreated\n");
  assert.ok((await repo.info()).files.includes("legacy.ts"));
  await rm(path.join(f.root, "src/legacy.ts"));
  const oldFile = await repo.file("shipping.ts", info.working.base);
  const newFile = await repo.file("shipping.ts");
  assert.match(oldFile.contents, /THRESHOLD = 100/);
  assert.match(newFile.contents, /THRESHOLD = 75/); // staged
  assert.match(newFile.contents, /\? 6 : 14/); // unstaged
  assert.equal(await repo.file("legacy.ts"), null);
  assert.equal(
    (await repo.file("legacy.ts", info.working.base)).contents,
    "export const freeShipping = false;\n",
  );
});

test("single commit, root commit and ranges use exact historical contents", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const repo = await repository(f.root);
  const commit = await repo.compare("commit", "", f.second);
  assert.equal(commit.base, f.first);
  assert.equal(commit.target, f.second);
  assert.equal(
    commit.message,
    "Add international shipping rates\n\nKeep domestic shipping at 5.\nCharge 12 for international orders.\n",
  );
  assert.deepEqual(commit.entries, [
    { path: "src/shipping.ts", status: "M", additions: 1, deletions: 1 },
    { path: "test/shipping.test.ts", status: "A", additions: 5, deletions: 0 },
  ]);
  const range = await repo.compare("range", f.first, f.third);
  assert.equal(range.message, undefined);
  assert.match(
    (await repo.file("src/shipping.ts", range.base)).contents,
    /const baseRate = 5/,
  );
  assert.match(
    (await repo.file("src/shipping.ts", range.target)).contents,
    /THRESHOLD = 100/,
  );
  const root = await repo.compare("commit", "", f.first);
  assert.equal(root.entries.length, 4);
  assert.ok(root.entries.every((entry) => entry.status === "A"));
  assert.equal(await repo.file("src/shipping.ts", root.base), null);
  assert.deepEqual(
    (await repo.compare("range", f.second, f.second)).entries,
    [],
  );
  await assert.rejects(
    repo.compare("range", "--output=/tmp/nope", "HEAD"),
    /Unknown commit/,
  );
  f.git("reset", "--hard", "HEAD");
  f.git(
    "commit",
    "--allow-empty",
    "-qm",
    "Document the decision",
    "-m",
    "No files changed.",
  );
  const empty = await repo.compare("commit", "", "HEAD");
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.message, "Document the decision\n\nNo files changed.\n");
});

test("range diffs use the merge base so base-branch changes stay hidden", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.git("reset", "--hard", "HEAD");
  const repo = await repository(f.root);
  // Branch off the first commit; the base gains a commit the branch never sees.
  f.git("checkout", "-q", "-b", "topic", f.first);
  await f.write("src/topic.ts", "export const topic = true;\n");
  f.git("add", "src/topic.ts");
  f.git("commit", "-qm", "Topic change");
  const topic = f.git("rev-parse", "HEAD");
  f.git("checkout", "-q", "main");
  await f.write("README.md", "# Parcel\n\nThe base branch moved on.\n");
  f.git("commit", "-aqm", "Base branch change");
  const main = f.git("rev-parse", "HEAD");

  const range = await repo.compare("range", main, topic);
  assert.equal(range.base, f.first); // the merge base, not main itself
  assert.equal(range.target, topic);
  assert.deepEqual(range.entries, [
    { path: "src/topic.ts", status: "A", additions: 1, deletions: 0 },
  ]);
  // The old side loads from the merge base, matching the rendered diff.
  assert.equal(
    (await repo.file("README.md", range.base)).contents,
    "# Parcel\n\nA small, predictable shipping calculator.\n",
  );
});

test("empty repositories work before the first commit, and refresh sees new changes", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.git("checkout", "--orphan", "empty");
  f.git("rm", "-rf", "--cached", ".");
  const repo = await repository(f.root);
  const info = await repo.info();
  assert.deepEqual(info.commits, []);
  assert.ok(
    info.working.entries.some((entry) => entry.path === "src/shipping.ts"),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "First");
  assert.deepEqual((await repo.info()).working.entries, []);
  await f.write("new file.txt", "new\n");
  assert.deepEqual((await repo.info()).working.entries, [
    { path: "new file.txt", status: "U", additions: 1, deletions: 0 },
  ]);
});

test("line counts preserve unusual paths and handle binary, empty and unterminated text", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const name = "tabs\tand\nlines.txt";
  await f.write(name, "before\nkeep\n");
  await f.write("binary.dat", Buffer.from([1, 0, 2]));
  f.git("add", name, "binary.dat");
  f.git("commit", "-qm", "Stats baseline");
  await f.write(name, "after\nextra\nkeep\n");
  await f.write("binary.dat", Buffer.from([3, 0, 4]));
  await f.write("empty.txt", "");
  await f.write("no-newline.txt", "first\nlast");
  await f.write("untracked-binary.dat", Buffer.from([0, 1]));
  const repo = await repository(f.root);
  const entries = (await repo.compare()).entries;
  assert.deepEqual(
    entries.find((e) => e.path === name),
    { path: name, status: "M", additions: 2, deletions: 1 },
  );
  assert.deepEqual(
    entries.find((e) => e.path === "binary.dat"),
    { path: "binary.dat", status: "M", additions: null, deletions: null },
  );
  assert.equal(entries.find((e) => e.path === "empty.txt").additions, 0);
  assert.equal(entries.find((e) => e.path === "no-newline.txt").additions, 2);
  assert.equal(
    entries.find((e) => e.path === "untracked-binary.dat").additions,
    null,
  );
  const lineCounts = (await repo.info()).lineCounts;
  assert.equal(lineCounts[name], 3);
  assert.equal(lineCounts["empty.txt"], 0);
  assert.equal(lineCounts["no-newline.txt"], 2);
  assert.equal(lineCounts["binary.dat"], null);
  assert.equal(lineCounts["untracked-binary.dat"], null);
  f.git("add", name);
  f.git("commit", "-qm", "Count historical lines");
  assert.deepEqual((await repo.compare("commit", "", "HEAD")).entries, [
    { path: name, status: "M", additions: 2, deletions: 1 },
  ]);
});

test("paths, binary files, large files, symlinks and unusual filenames are handled safely", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const repo = await repository(f.root);
  for (const name of ["../outside", ".git/config", "/etc/passwd"])
    await assert.rejects(repo.file(name), /Invalid file path/);
  await symlink("/etc/passwd", path.join(f.root, "escape"));
  await assert.rejects(repo.file("escape"), /outside/);
  await symlink(path.join(f.root, ".git"), path.join(f.root, "git-alias"));
  await assert.rejects(repo.file("git-alias/config"), /Invalid file path/);
  await f.write("binary.dat", Buffer.from([1, 0, 2]));
  await f.write("big.txt", "a".repeat(2 * 1024 * 1024 + 1));
  assert.match((await repo.file("binary.dat")).notice, /Binary/);
  assert.match((await repo.file("big.txt")).notice, /2 MiB/);
  for (const name of [
    "space name.txt",
    "-flag.txt",
    "line\nbreak.txt",
    "unicode-✓.txt",
  ]) {
    await f.write(name, "exact\n");
    assert.equal((await repo.file(name)).contents, "exact\n");
    assert.ok(
      (await repo.compare()).entries.some((entry) => entry.path === name),
    );
  }
});

test("HTTP is read-only, blocks cross-origin reads and serves the built UI", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const server = createApp(await repository(f.root));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/info`)).status, 403);
  assert.equal(
    (
      await fetch(`${url}/api/info`, {
        headers: { "X-Rv": "1", "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  const foreignHostStatus = await new Promise((resolve, reject) => {
    get(
      `${url}/api/info`,
      { headers: { "X-Rv": "1", Host: "evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).on("error", reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal(
    (await fetch(`${url}/api/info`, { method: "POST" })).status,
    405,
  );
  const response = await fetch(`${url}/api/info`, {
    headers: { "X-Rv": "1" },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).commits.length, 3);
  const html = await fetch(url);
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.match(await html.text(), /rv — local code review/);
});

test("built assets are compressed and immutable, but HTML, API data and errors are never cached", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const server = createApp(await repository(f.root));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const assets = await readdir(new URL("../dist/assets/", import.meta.url));
  // Exercise the entrypoint, CSS, workers, WASM and lazy language chunks.
  for (const prefix of ["index-", "worker-", "wasm-", "typescript-"]) {
    const names = assets.filter(name => name.startsWith(prefix) && /\.(js|css)$/.test(name));
    assert.ok(names.length, `Missing built ${prefix} assets`);
    for (const name of names) {
      const plain = await fetch(`${url}/assets/${name}`, { headers: { "Accept-Encoding": "identity" } });
      assert.equal(plain.headers.get("content-encoding"), null);
      const expected = await plain.text();
      const gzip = await fetch(`${url}/assets/${name}`, { headers: { "Accept-Encoding": "br, gzip;q=0.8" } });
      assert.equal(gzip.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.equal(gzip.headers.get("vary"), "Accept-Encoding");
      assert.equal(gzip.headers.get("content-encoding"), "gzip");
      assert.equal(gzip.headers.get("content-type"), plain.headers.get("content-type"));
      assert.ok(Number(gzip.headers.get("content-length")) < Buffer.byteLength(expected) / 2);
      assert.equal(await gzip.text(), expected); // fetch decompresses the wire bytes
      const declined = await fetch(`${url}/assets/${name}`, { headers: { "Accept-Encoding": "gzip;q=0, identity" } });
      assert.equal(declined.headers.get("content-encoding"), null);
      assert.equal(await declined.text(), expected);
    }
  }
  for (const route of ["/", "/index.html", "/api/info", "/api/state", "/api/file?path=src/shipping.ts", "/assets/missing-12345678.js"]) {
    const response = await fetch(url + route, { headers: { "X-Rv": "1" } });
    assert.equal(response.headers.get("cache-control"), "no-store", route);
    if (route.includes("missing")) assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
});

test("prompt contains only exact file:line references and associated comments", () => {
  assert.equal(
    formatPrompt([
      { path: "src/a.ts", start: 7, end: 7, text: " Check the boundary. " },
      {
        path: "b.ts",
        start: 12,
        end: 15,
        text: "Keep this.\nRemove the fallback.",
        context: "not exported",
        side: "deletions",
      },
      {
        path: "\0commit-message",
        commit: "abc123",
        start: 3,
        end: 4,
        text: "Explain why.",
        context: "not exported",
      },
    ]),
    "src/a.ts:7\nCheck the boundary.\n\nb.ts:12-15\nKeep this.\nRemove the fallback.\n\ncommit:abc123:message:3-4\nExplain why.",
  );
  assert.equal(formatPrompt([]), "");
});

test("ordinary folders and brand-new Git repositories with zero objects work", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "rv-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "hello.txt"), "hello\n");
  const folder = await repository(root);
  assert.equal((await folder.info()).isGit, false);
  assert.deepEqual((await folder.info()).files, ["hello.txt"]);
  execFileSync("git", ["-C", root, "init", "-q"]);
  const repo = await repository(root);
  const info = await repo.info();
  assert.deepEqual(info.commits, []);
  assert.deepEqual(info.working.entries, [
    { path: "hello.txt", status: "U", additions: 1, deletions: 0 },
  ]);
  assert.equal(await repo.file("hello.txt", info.working.base), null);
  execFileSync("git", ["-C", root, "add", "hello.txt"]);
  assert.deepEqual((await repo.compare()).entries, [
    { path: "hello.txt", status: "A", additions: 1, deletions: 0 },
  ]);
});
