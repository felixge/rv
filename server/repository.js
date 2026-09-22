import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, lstat, realpath, readFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const MAX_FILE = 2 * 1024 * 1024;
const split = (value) => value.split("\0").filter(Boolean);
const countLines = (text) =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export async function repository(directory) {
  let root = await realpath(directory);
  const git = async (...args) =>
    (
      await exec("git", ["--no-optional-locks", "-C", root, ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_PAGER: "cat", GIT_LITERAL_PATHSPECS: "1" },
      })
    ).stdout;
  let isGit = true;
  try {
    root = (await git("rev-parse", "--show-toplevel")).trim();
  } catch {
    isGit = false;
  }

  async function resolve(ref) {
    if (!ref || ref.length > 256)
      throw new Error("Enter a valid commit or branch.");
    try {
      return (
        await git(
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${ref}^{commit}`,
        )
      ).trim();
    } catch {
      throw new Error(`Unknown commit: ${ref}`);
    }
  }

  async function emptyTree() {
    const result = exec("git", [
      "-C",
      root,
      "hash-object",
      "-t",
      "tree",
      "--stdin",
    ]);
    result.child.stdin.end();
    return (await result).stdout.trim();
  }

  async function head() {
    try {
      return await resolve("HEAD");
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
      // A missing file is distinct from an empty one. ls-tree also identifies submodules.
      const entry = await git("ls-tree", "-z", ref, "--", name);
      if (!entry) return null;
      if (!entry.startsWith("100"))
        return {
          name,
          contents: "",
          notice: "Symbolic links and submodules are not displayed.",
        };
      const size = Number(
        (await git("cat-file", "-s", `${ref}:${name}`)).trim(),
      );
      if (size > MAX_FILE)
        return {
          name,
          contents: "",
          notice: "File exceeds the 2 MiB preview limit.",
        };
      data = (
        await exec("git", ["-C", root, "show", `${ref}:${name}`], {
          encoding: "buffer",
          maxBuffer: MAX_FILE + 1024,
        })
      ).stdout;
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
          return {
            name,
            contents: "",
            notice: "Symbolic links and directories are not displayed.",
          };
        if (stat.size > MAX_FILE)
          return {
            name,
            contents: "",
            notice: "File exceeds the 2 MiB preview limit.",
          };
        data = await readFile(filename);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }
    if (data.includes(0))
      return { name, contents: "", notice: "Binary file — no text preview." };
    return { name, contents: data.toString("utf8") };
  }

  async function files() {
    if (isGit) {
      const deleted = new Set(split(await git("ls-files", "-z", "--deleted")));
      return [
        ...new Set(
          split(
            await git(
              "ls-files",
              "-z",
              "--cached",
              "--others",
              "--exclude-standard",
            ),
          ),
        ),
      ]
        .filter((name) => !deleted.has(name))
        .sort();
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
    return paths.sort();
  }

  async function compare(mode = "working", from = "", to = "") {
    if (!isGit) return { base: "", target: "", entries: [] };
    let base, target;
    if (mode === "working") {
      base = (await head()) || (await emptyTree());
      target = "";
    } else if (mode === "commit") {
      target = await resolve(to);
      const parents = (await git("rev-list", "--parents", "-n", "1", target))
        .trim()
        .split(" ");
      base = parents[1] || (await emptyTree());
    } else if (mode === "range") {
      [base, target] = await Promise.all([resolve(from), resolve(to)]);
    } else throw new Error("Unknown comparison mode.");
    const diffArgs = [
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      base,
      ...(target ? [target] : []),
      "--",
    ];
    const [names, numstat] = await Promise.all([
      git("diff", "--name-status", "-z", ...diffArgs),
      git("diff", "--numstat", "-z", ...diffArgs),
    ]);
    const stats = new Map(
      split(numstat).map((record) => {
        const [added, removed, ...name] = record.split("\t");
        return [
          name.join("\t"),
          {
            additions: added === "-" ? null : Number(added),
            deletions: removed === "-" ? null : Number(removed),
          },
        ];
      }),
    );
    const tokens = split(names);
    const entries = [];
    for (let i = 0; i < tokens.length; i += 2)
      entries.push({
        status: tokens[i],
        path: tokens[i + 1],
        ...stats.get(tokens[i + 1]),
      });
    if (!target) {
      for (const name of split(
        await git("ls-files", "-z", "--others", "--exclude-standard"),
      )) {
        // Reuse the preview's safety/size checks; unavailable text has no line total.
        const source = await file(name).catch(() => null);
        const text = source && !source.notice ? source.contents : null;
        const additions = text === null ? null : countLines(text);
        entries.push({ status: "U", path: name, additions, deletions: 0 });
      }
    }
    return {
      base,
      target,
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
      ...(mode === "commit"
        ? {
            message: (await git("show", "-s", "--format=%B", target)).replace(
              /\n$/,
              "",
            ),
          }
        : {}),
    };
  }

  async function info() {
    const revision = isGit ? await head() : null;
    const commits = revision
      ? (await git("log", "-60", "--format=%H%x00%h%x00%s%x00%an%x00%aI"))
          .trimEnd()
          .split("\n")
          .map((line) => {
            const [id, short, subject, author, date] = line.split("\0");
            return { id, short, subject, author, date };
          })
      : [];
    let branch = "";
    if (isGit) {
      try {
        branch = (await git("symbolic-ref", "--short", "HEAD")).trim();
      } catch {
        branch = revision?.slice(0, 7) || "";
      }
    }
    const fileList = await files();
    // Line totals for the Files explorer, where change stats make no sense.
    // Unavailable text (binary, oversized, symlinked) has no line total.
    const lineCounts = {};
    await Promise.all(
      fileList.map(async (name) => {
        const source = await file(name).catch(() => null);
        lineCounts[name] =
          source && !source.notice ? countLines(source.contents) : null;
      }),
    );
    return {
      root,
      name: path.basename(root),
      isGit,
      branch,
      commits,
      files: fileList,
      lineCounts,
      working: await compare(),
    };
  }

  return { root, info, compare, file };
}
