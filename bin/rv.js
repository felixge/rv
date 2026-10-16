#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";

const usage = `Usage: rv [directory] [--working | --commit <ref> | --range <from>..<to>]
       [--port 4444] [--no-open]

Review the current repository in your browser. Refresh the page to see new changes.
If the default port 4444 is busy, a free port is picked automatically.
--host 0.0.0.0 allows remote access; use only behind a trusted proxy.

Open on a specific review view:
  --working             Uncommitted changes
  --commit <ref>        A single commit, e.g. --commit HEAD
  --range <from>..<to>  A commit range, e.g. --range main..HEAD`;

// Resolves once listening; rejects with the server's error (e.g. EADDRINUSE).
function listen(server, options) {
  server.listen(options);
  return once(server, "listening");
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      "no-open": { type: "boolean" },
      working: { type: "boolean" },
      commit: { type: "string" },
      range: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (positionals.length > 1)
      throw new Error("Expected at most one directory.");
    const views = [
      values.working && "working",
      values.commit && "commit",
      values.range && "range",
    ].filter(Boolean);
    if (views.length > 1)
      throw new Error("Use only one of --working, --commit or --range.");
    let view = "";
    if (values.working) {
      view = "?mode=working";
    } else if (values.commit) {
      view = `?mode=commit&to=${encodeURIComponent(values.commit)}`;
    } else if (values.range) {
      const [from, to] = values.range.split("..");
      if (!from || !to || to.includes(".."))
        throw new Error("Use --range <from>..<to>, e.g. --range main..HEAD.");
      view = `?mode=range&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    }
    const explicitPort = values.port === undefined ? null : Number(values.port);
    if (
      explicitPort !== null &&
      (!Number.isInteger(explicitPort) || explicitPort < 0 || explicitPort > 65535)
    )
      throw new Error("Invalid port.");
    const port = explicitPort ?? 4444;
    const repo = await repository(positionals[0] || process.cwd());
    const server = createApp(repo, {
      allowRemote: values.host !== "127.0.0.1" && values.host !== "localhost",
    });
    try {
      await listen(server, { port, host: values.host });
    } catch (error) {
      if (error.code !== "EADDRINUSE" || explicitPort !== null) throw error;
      await listen(server, { port: 0, host: values.host });
    }
    server.on("error", (error) => console.error(`rv: ${error.message}`));
    const url = `http://localhost:${server.address().port}${view}`;
    console.log(
      `\n  rv → ${url}\n  ${repo.root}\n\n  Refresh the page to update. Ctrl+C to stop.\n`,
    );
    if (!values["no-open"]) {
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
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => server.close());
  }
} catch (error) {
  console.error(
    `rv: ${error.code === "EADDRINUSE" ? "Port is busy. Use --port <number>." : error.message}`,
  );
  process.exitCode = 1;
}
