#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { repository } from "../server/repository.js";
import { createAgentChannel, createApp } from "../server/http.js";
import {
  clearAgentSession,
  loadAgentSession,
  saveAgentSession,
} from "../server/state.js";

const agentSkill = `Use rv to collect review feedback from the user:
1. Start "rv --agent" as a long-running process and keep it alive.
2. Run "rv --wait". It blocks until the user submits the review, then prints the exact prompt to stdout and exits.
3. Apply the submitted feedback, then run "rv --wait" again for the next review round.

The browser UI stays open between rounds. A successful submission clears its comments, and submissions made between wait calls remain queued.`;

async function sessionIsActive(session) {
  try {
    const response = await fetch(`${session.url}/api/agent/status`, {
      headers: { "X-Rv": "1", "X-Rv-Agent": session.token },
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForSubmission(root) {
  const session = await loadAgentSession(root);
  if (!session || !(await sessionIsActive(session)))
    throw new Error("No active agent session. Start rv --agent first.");
  const response = await fetch(`${session.url}/api/agent/wait`, {
    headers: { "X-Rv": "1", "X-Rv-Agent": session.token },
  });
  if (!response.ok) {
    let message = `Agent session returned HTTP ${response.status}.`;
    try {
      message = (await response.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  const prompt = await response.text();
  await new Promise((resolve, reject) =>
    process.stdout.write(`${prompt}\n`, (error) => error ? reject(error) : resolve()),
  );
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(options);
  });
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
      agent: { type: "boolean" },
      wait: { type: "boolean" },
      skill: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: rv [directory] [--working | --commit <ref> | --range <from>..<to>]\n       [--agent] [--port 4444] [--no-open]\n       rv [directory] --wait\n       rv --skill\n\nReview the current repository in your browser. Refresh the page to see new changes.\nIf the default port 4444 is busy, a free port is picked automatically.\n--host 0.0.0.0 allows remote access; use only behind a trusted proxy.\n\nOpen on a specific review view:\n  --working             Uncommitted changes\n  --commit <ref>        A single commit, e.g. --commit HEAD\n  --range <from>..<to>  A commit range, e.g. --range main..HEAD\n\nAgent integration:\n  --agent               Enable submitting review prompts to an agent\n  --wait                Wait for the next submitted prompt and print it\n  --skill               Print instructions for coding agents",
    );
  } else if (values.skill) {
    console.log(agentSkill);
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
    if (values.wait && (values.agent || views.length))
      throw new Error("--wait cannot be combined with --agent or a review view.");
    const repo = await repository(positionals[0] || process.cwd());
    if (values.wait) {
      await waitForSubmission(repo.root);
      process.exit(0);
    }
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
    const existing = values.agent && await loadAgentSession(repo.root);
    if (existing && await sessionIsActive(existing))
      throw new Error("An agent session is already running for this repository.");
    const token = values.agent ? randomBytes(32).toString("hex") : null;
    const agent = token ? createAgentChannel(token) : null;
    const server = createApp(repo, {
      allowRemote: values.host !== "127.0.0.1" && values.host !== "localhost",
      agent,
    });
    try {
      await listen(server, { port, host: values.host });
    } catch (error) {
      if (error.code !== "EADDRINUSE" || explicitPort !== null) throw error;
      await listen(server, { port: 0, host: values.host });
    }
    const baseURL = `http://localhost:${server.address().port}`;
    if (agent) {
      try {
        await saveAgentSession(repo.root, { url: baseURL, token: agent.token });
      } catch (error) {
        server.close();
        throw error;
      }
    }
    server.on("error", (error) => console.error(`rv: ${error.message}`));
    server.on("close", () => {
      if (agent) void clearAgentSession(repo.root, agent.token);
    });
    const url = `${baseURL}${view}`;
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
      process.on(signal, () => {
        agent?.close();
        server.close();
      });
  }
} catch (error) {
  console.error(
    `rv: ${error.code === "EADDRINUSE" ? "Port is busy. Use --port <number>." : error.message}`,
  );
  process.exitCode = 1;
}
