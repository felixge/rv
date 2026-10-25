import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdir, lstat, realpath, readFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const MAX_FILE = 2 * 1024 * 1024;
const split = (value) => value.split("\0").filter(Boolean);
const countLines = (text) =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const unavailable = (name, notice) => ({ name, contents: "", notice });
const TOO_LARGE = "File exceeds the 2 MiB preview limit.";

// A long-running `git cat-file --batch` or `--batch-check` process. Each
// lookup is a line on its stdin instead of a new git process. Resolves to
// { type, size, data } (data only with --batch), or null for missing objects.
function catFile(args, option) {
  let child;
  let buffer = Buffer.alloc(0);
  let pending = [];
  function drain() {
    while (pending.length) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const [, type, size] = buffer.toString("latin1", 0, newline).split(" ");
      let end = newline + 1;
      let data;
      if (option === "--batch" && size !== undefined) {
        end += Number(size) + 1;
        if (buffer.length < end) return;
        data = buffer.subarray(newline + 1, end - 1);
      }
      buffer = buffer.subarray(end);
      // Missing objects answer "<name> missing", without a size.
      pending.shift().resolve(size === undefined ? null : { type, size: Number(size), data });
    }
    // Idle processes must not keep Node running.
    child?.stdout.unref();
  }
  function stop(error) {
    for (const request of pending) request.reject(error);
    pending = [];
    buffer = Buffer.alloc(0);
    child = undefined;
  }
  return (object) =>
    new Promise((resolve, reject) => {
      if (!child) {
        const current = (child = spawn("git", [...args, "cat-file", option], {
          stdio: ["pipe", "pipe", "ignore"],
        }));
        current.unref();
        current.stdin.unref();
        current.stdout.on("data", (chunk) => {
          buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
          drain();
        });
        const failed = (error) => {
          if (child === current) stop(error);
        };
        current.on("error", failed);
        // Not "exit": an unreferenced child's exit may never be delivered.
        current.stdout.on("close", () => failed(new Error("git cat-file exited.")));
        current.stdin.on("error", failed);
      }
      pending.push({ resolve, reject });
      child.stdout.ref();
      child.stdin.write(`${object}\n`);
    });
}

// Finds a name in a raw tree object: "<mode> <name>\0<binary object id>" entries.
function treeEntry(tree, name, idBytes) {
  const wanted = Buffer.from(name);
  for (let i = 0; i < tree.length; ) {
    const space = tree.indexOf(32, i);
    const nul = tree.indexOf(0, space);
    const next = nul + 1 + idBytes;
    if (tree.subarray(space + 1, nul).equals(wanted))
      return {
        mode: tree.toString("latin1", i, space),
        id: tree.toString("hex", nul + 1, next),
      };
    i = next;
  }
  return null;
}

export async function repository(directory) {
  const root = await realpath(directory);
  const run = async (args, options = {}) =>
    (
      await exec("git", ["--no-optional-locks", "-C", root, ...args], {
        encoding: "utf8",
        // Metadata (file lists and diff stats) scales with the repository, not
        // the preview size. Individual file contents keep their own bound below.
        maxBuffer: Infinity,
        env: { ...process.env, GIT_PAGER: "cat", GIT_LITERAL_PATHSPECS: "1" },
        ...options,
      })
    ).stdout;
  const git = (...args) => run(args);
  const gitArgs = ["--no-optional-locks", "-C", root];
  const objectInfo = catFile(gitArgs, "--batch-check");
  const objectData = catFile(gitArgs, "--batch");
  let isGit = true;
  let gitRoot = root;
  try {
    // The opened directory is the review scope: git runs with -C root so
    // ls-files is limited to it and diff --relative limits and names diffs
    // relative to it. Commands like rev-parse and log still work repo-wide.
    gitRoot = (await git("rev-parse", "--show-toplevel")).trim();
  } catch {
    isGit = false;
  }
  // Path from the repository root to the review scope, for tree walks.
  const prefix = path.relative(gitRoot, root).split(path.sep);

  // One process resolves the commit, its parents and its message.
  async function resolve(ref) {
    if (!ref || ref.length > 256)
      throw new Error("Enter a valid commit or branch.");
    let output;
    try {
      output = await git(
        "rev-list",
        "--parents",
        "-n",
        "1",
        "--format=%B",
        "--end-of-options",
        `${ref}^{commit}`,
        "--",
      );
    } catch {
      throw new Error(`Unknown commit: ${ref}`);
    }
    const newline = output.indexOf("\n");
    const [, id, ...parents] = output.slice(0, newline).split(" ");
    return { id, parents, message: output.slice(newline + 1).replace(/\n$/, "") };
  }

  let emptyTreeId;
  async function emptyTree() {
    if (!emptyTreeId) {
      const result = exec("git", [
        "-C",
        root,
        "hash-object",
        "-t",
        "tree",
        "--stdin",
      ]);
      result.child.stdin.end();
      emptyTreeId = (await result).stdout.trim();
    }
    return emptyTreeId;
  }

  async function head() {
    try {
      return (await resolve("HEAD")).id;
    } catch {
      return null;
    }
  }

  function checkPath(name) {
    if (
      !name ||
      name.includes("\0") ||
      name.includes("\\") ||
      path.isAbsolute(name) ||
      name
        .split("/")
        .some((part) => part === ".." || part === ".git" || part === ".")
    ) {
      throw new Error("Invalid file path.");
    }
  }

  async function file(name, ref = "") {
    checkPath(name);
    let data;
    if (ref) {
      if (!/^[a-f0-9]{40,64}$/.test(ref)) throw new Error("Invalid revision.");
      // Walk the trees from the commit's root by object id, so paths never
      // travel over the cat-file protocol. Tree entries carry the file mode,
      // which identifies symbolic links and submodules.
      let entry = { mode: "40000", id: `${ref}^{tree}` };
      for (const part of [...prefix, ...name.split("/")].filter(Boolean)) {
        // A missing file is distinct from an empty one.
        if (entry.mode !== "40000") return null;
        const tree = await objectData(entry.id);
        if (!tree) throw new Error(`Unknown revision: ${ref}`);
        entry = treeEntry(tree.data, part, ref.length / 2);
        if (!entry) return null;
      }
      if (!entry.mode.startsWith("100"))
        return unavailable(name, "Symbolic links and submodules are not displayed.");
      // Check the size before reading, so large blobs never cross the pipe.
      if ((await objectInfo(entry.id)).size > MAX_FILE)
        return unavailable(name, TOO_LARGE);
      data = (await objectData(entry.id)).data;
    } else {
      const filename = path.join(root, name);
      try {
        const actual = await realpath(filename);
        const relative = path.relative(root, actual);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new Error("File is outside this repository.");
        checkPath(relative.split(path.sep).join("/"));
        const stat = await lstat(filename);
        if (!stat.isFile())
          return unavailable(name, "Symbolic links and directories are not displayed.");
        if (stat.size > MAX_FILE) return unavailable(name, TOO_LARGE);
        data = await readFile(filename);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }
    if (data.includes(0)) return unavailable(name, "Binary file — no text preview.");
    return { name, contents: data.toString("utf8") };
  }

  // Lists the reviewable paths, and separately the untracked ones.
  async function files() {
    if (isGit) {
      // One process; -t tags deleted files "R" and untracked ones "?".
      const tagged = split(
        await git(
          "ls-files",
          "-z",
          "-t",
          "--cached",
          "--deleted",
          "--others",
          "--exclude-standard",
        ),
      ).map((entry) => [entry[0], entry.slice(2)]);
      const deleted = new Set(
        tagged.filter(([tag]) => tag === "R").map(([, name]) => name),
      );
      return {
        paths: [...new Set(tagged.map(([, name]) => name))]
          .filter((name) => !deleted.has(name))
          .sort(),
        untracked: tagged.filter(([tag]) => tag === "?").map(([, name]) => name),
      };
    }
    const paths = [];
    async function walk(dir = "") {
      for (const item of await readdir(path.join(root, dir), {
        withFileTypes: true,
      })) {
        if ([".git", "node_modules", ".amp"].includes(item.name)) continue;
        const name = path.posix.join(dir, item.name);
        if (item.isDirectory()) await walk(name);
        else if (item.isFile()) paths.push(name);
      }
    }
    await walk();
    return { paths: paths.sort(), untracked: [] };
  }

  // browse() passes the untracked files it already listed.
  async function compare(mode = "working", from = "", to = "", untracked) {
    if (!isGit) return { mode: "working", base: "", target: "", entries: [] };
    let base, target, message;
    if (mode === "working") {
      base = (await head()) || (await emptyTree());
      target = "";
    } else if (mode === "commit") {
      let parents;
      ({ id: target, parents, message } = await resolve(to));
      base = parents[0] || (await emptyTree());
    } else if (mode === "range") {
      [{ id: base }, { id: target }] = await Promise.all([resolve(from), resolve(to)]);
      // GitHub-style semantics: diff from the merge base so commits already
      // on the base branch never appear as reversals in the range diff.
      const mergeBase = await git("merge-base", base, target).catch(() => "");
      if (mergeBase) base = mergeBase.trim();
    } else throw new Error("Unknown comparison mode.");
    const diffArgs = [
      "--relative",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      base,
      ...(target ? [target] : []),
      "--",
    ];
    // One process: --raw records (":modes oids status", then the path),
    // followed by --numstat records ("added\tdeleted\tpath").
    const [raw, recent, untrackedNames] = await Promise.all([
      git("diff", "--raw", "--numstat", "-z", ...diffArgs),
      // Where the commit is among the commits the review menu lists, so its
      // URL can stay HEAD-relative without loading that list.
      mode === "commit" ? git("rev-list", "-60", "HEAD").catch(() => "") : "",
      target
        ? []
        : untracked ||
          git("ls-files", "-z", "--others", "--exclude-standard").then(split),
    ]);
    const tokens = split(raw);
    const statuses = [];
    const stats = new Map();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].startsWith(":")) {
        statuses.push([tokens[i].split(" ").pop(), tokens[++i]]);
        continue;
      }
      const [added, removed, ...name] = tokens[i].split("\t");
      stats.set(name.join("\t"), {
        additions: added === "-" ? null : Number(added),
        deletions: removed === "-" ? null : Number(removed),
      });
    }
    const entries = statuses.map(([status, name]) => ({
      status,
      path: name,
      ...stats.get(name),
    }));
    if (!target) {
      for (const name of untrackedNames) {
        // Reuse the preview's safety/size checks; unavailable text has no line total.
        const source = await file(name).catch(() => null);
        const text = source && !source.notice ? source.contents : null;
        const additions = text === null ? null : countLines(text);
        entries.push({ status: "U", path: name, additions, deletions: 0 });
      }
    }
    return {
      mode,
      base,
      target,
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
      ...(mode === "commit"
        ? { message, recent: recent.split("\n").indexOf(target) }
        : {}),
    };
  }

  // Each screen loads only what it shows: info() is the header, browse()
  // the File Browser, commits() the review menu, compare() a comparison.
  async function info() {
    const branch = isGit
      ? (await git("symbolic-ref", "--short", "HEAD").catch(() => "")).trim() ||
        (await head())?.slice(0, 7) ||
        ""
      : "";
    return {
      root,
      name: path.posix.join(
        path.basename(gitRoot),
        path.relative(gitRoot, root).split(path.sep).join("/"),
      ),
      isGit,
      branch,
    };
  }

  async function browse() {
    const { paths, untracked } = await files();
    return { files: paths, working: await compare("working", "", "", untracked) };
  }

  async function commits() {
    if (!isGit) return { commits: [], upstream: "" };
    // The log fails before the first commit.
    const [log, remotes] = await Promise.all([
      git("log", "-60", "--format=%H%x00%h%x00%s%x00%an%x00%aI").catch(() => ""),
      git("remote"),
    ]);
    const list = log
      ? log
          .trimEnd()
          .split("\n")
          .map((line) => {
            const [id, short, subject, author, date] = line.split("\0");
            return { id, short, subject, author, date };
          })
      : [];
    // A commit counts as pushed once any remote-tracking ref contains it.
    // Without remotes there is nothing to push to, so commits carry no state.
    let upstream = "";
    if (list.length && remotes.trim()) {
      const [unpushed, name] = await Promise.all([
        git("rev-list", "HEAD", "--not", "--remotes"),
        git("rev-parse", "--abbrev-ref", "@{upstream}").catch(() => "remote"),
      ]);
      const ids = new Set(unpushed.split("\n"));
      for (const commit of list) commit.pushed = !ids.has(commit.id);
      upstream = name.trim();
    }
    return { commits: list, upstream };
  }

  // Only the Files explorer needs totals. Keep its full-repository scan off
  // the startup/refresh path and leave I/O capacity for interactive previews.
  let counting;
  function lineCounts() {
    // Multiple tabs share one scan, rather than multiplying the open-file cap.
    if (counting) return counting;
    counting = (async () => {
      const { paths: names } = await files();
      const counts = {};
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < names.length) {
          const name = names[next++];
          const source = await file(name).catch(() => null);
          counts[name] = source && !source.notice ? countLines(source.contents) : null;
        }
      }));
      return counts;
    })().finally(() => { counting = undefined; });
    return counting;
  }

  return { root, info, browse, commits, compare, file, lineCounts };
}
