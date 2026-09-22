#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { repository } from "../server/repository.js";
import { createApp } from "../server/http.js";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4444" },
      host: { type: "string", default: "127.0.0.1" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: difflet [directory] [--port 4444] [--no-open]\n\nReview the current repository in your browser. Refresh the page to see new changes.\n--host 0.0.0.0 allows remote access; use only behind a trusted proxy.",
    );
  } else {
    if (positionals.length > 1)
      throw new Error("Expected at most one directory.");
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid port.");
    const repo = await repository(positionals[0] || process.cwd());
    const server = createApp(repo, {
      allowRemote: values.host !== "127.0.0.1" && values.host !== "localhost",
    });
    server.on("error", (error) => {
      console.error(
        `difflet: ${error.code === "EADDRINUSE" ? "Port is busy. Use --port <number>." : error.message}`,
      );
      process.exitCode = 1;
    });
    server.listen(port, values.host, () => {
      const url = `http://localhost:${server.address().port}`;
      console.log(
        `\n  difflet → ${url}\n  ${repo.root}\n\n  Refresh the page to update. Ctrl+C to stop.\n`,
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
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => server.close());
  }
} catch (error) {
  console.error(`difflet: ${error.message}`);
  process.exitCode = 1;
}
