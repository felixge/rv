#!/usr/bin/env node
import { parseArgs, promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { repository } from "../server/repository.js";
import { ensureInstance, listInstances, startInstance, stopInstances } from "../server/instance.js";

const usage = `Usage: rv [directory] [--working | --commit <ref> | --range <from>..<to>]
       [--port 4444] [--no-open]
       rv ensure [directory] [--working | --commit <ref> | --range <from>..<to>]
       [--port 4444] [--no-open]
       rv list
       rv stop [directory]

Review the current repository in your browser. Refresh the page to see new changes.
If the default port 4444 is busy, a free port is picked automatically.
--host 0.0.0.0 allows remote access; use only behind a trusted proxy.

ensure restarts the Git working-tree root's servers with this installation,
prints the URL, and exits. It never opens a browser and only uses localhost.
The existing port is kept unless --port explicitly overrides it.
list shows registered running local servers (PID, URL, directory).
stop shuts down the servers for a directory; without a directory it stops all.

Open on a specific review view:
  --working             Uncommitted changes
  --commit <ref>        A single commit, e.g. --commit HEAD
  --range <from>..<to>  A commit range, e.g. --range main..HEAD`;

async function main() {
  const args = process.argv.slice(2);
  const command = ["ensure", "list", "stop"].includes(args[0]) ? args[0] : null;
  const ensure = command === "ensure";
  const management = command === "list" || command === "stop";
  const { values, positionals } = parseArgs({
    args: command ? args.slice(1) : args,
    allowPositionals: true,
    options: management ? { help: { type: "boolean", short: "h" } } : {
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      "no-open": { type: "boolean" },
      working: { type: "boolean" },
      commit: { type: "string" },
      range: { type: "string" },
      help: { type: "boolean", short: "h" },
      "ensure-server": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (command === "list") {
    if (positionals.length) throw new Error("rv list does not accept arguments.");
    const instances = await listInstances();
    if (!instances.length) console.log("No running rv instances.");
    else {
      console.log("PID\tURL\tDIRECTORY");
      for (const instance of instances)
        console.log(`${instance.pid}\t${instance.url}\t${instance.root}`);
    }
    return;
  }
  if (positionals.length > 1)
    throw new Error("Expected at most one directory.");
  if (command === "stop") {
    // Prefer an exact opened scope (also supports non-Git folders). Otherwise,
    // resolve subdirectories the same way ensure resolves a working-tree root.
    let root = null;
    if (positionals.length) {
      root = await realpath(positionals[0]);
      if (!(await listInstances()).some((instance) => instance.root === root))
        root = await worktreeRoot(root).catch(() => root);
    }
    const { stopped, failed } = await stopInstances(root);
    for (const instance of stopped)
      console.log(`Stopped ${instance.pid}\t${instance.url}\t${instance.root}`);
    for (const { root, error } of failed)
      console.error(`rv: ${root}: ${error.message}`);
    if (!stopped.length && !failed.length)
      console.log(root ? `No running rv instances for ${root}.` : "No running rv instances.");
    if (failed.length) process.exitCode = 1;
    return;
  }
  if (values["ensure-server"] && (ensure || !process.send))
    throw new Error("--ensure-server is an internal option.");
  if (ensure && !["127.0.0.1", "localhost"].includes(values.host))
    throw new Error("rv ensure only supports localhost.");
  const view = reviewView(values);
  const port = values.port === undefined ? null : Number(values.port);
  if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535))
    throw new Error("Invalid port.");
  const directory = positionals[0] || process.cwd();
  if (ensure) {
    const root = await worktreeRoot(directory);
    const instance = await ensureInstance(root, { port });
    console.log(instance.url + view);
    return;
  }
  const repo = await repository(directory);
  const { instance } = await startInstance(repo, {
    port, host: values.host, background: values["ensure-server"],
  });
  if (values["ensure-server"]) {
    notify({ instance });
    return;
  }
  const url = instance.url + view;
  console.log(
    `\n  rv → ${url}\n  ${repo.root}\n\n  Refresh the page to update. Ctrl+C to stop.\n`,
  );
  if (!values["no-open"]) openBrowser(url);
}

function reviewView(values) {
  const views = [
    values.working && "working",
    values.commit && "commit",
    values.range && "range",
  ].filter(Boolean);
  if (views.length > 1)
    throw new Error("Use only one of --working, --commit or --range.");
  if (values.working) return "?mode=working";
  if (values.commit)
    return `?mode=commit&to=${encodeURIComponent(values.commit)}`;
  if (values.range) {
    const [from, to] = values.range.split("..");
    if (!from || !to || to.includes(".."))
      throw new Error("Use --range <from>..<to>, e.g. --range main..HEAD.");
    return `?mode=range&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }
  return "";
}

async function worktreeRoot(directory) {
  const { stdout } = await promisify(execFile)("git", [
    "-C", directory, "rev-parse", "--show-toplevel",
  ], { encoding: "utf8" });
  return realpath(stdout.trim());
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore" });
  child.on("error", () =>
    console.log("  Open the URL above in your browser."),
  );
}

function notify(message) {
  if (!process.connected) return;
  // A caller exiting early must not kill a server that is already running.
  process.send(message, () => {
    if (process.connected) process.disconnect();
  });
}

main().catch((error) => {
  const message = error.code === "EADDRINUSE"
    ? "Port is busy. Use --port <number>." : error.message;
  console.error(`rv: ${message}`);
  notify({ error: message });
  process.exitCode = 1;
});
