import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearState, loadState, saveState } from "./state.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const MAX_STATE = 1024 * 1024;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Drop the content but keep draining so the error response
        // can still be delivered over the open request.
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(overflow ? null : Buffer.concat(chunks).toString("utf8")),
    );
    req.on("error", reject);
  });
}
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
};

export function createAgentChannel(token) {
  const queue = [];
  let waiter = null;
  return {
    token,
    submit(prompt) {
      if (waiter) {
        const current = waiter;
        waiter = null;
        current.resolve(prompt);
      } else {
        queue.push(prompt);
      }
    },
    wait() {
      if (queue.length)
        return { promise: Promise.resolve(queue.shift()), cancel() {} };
      if (waiter) {
        const error = new Error("Another rv --wait is already pending.");
        error.status = 409;
        throw error;
      }
      let resolve;
      let reject;
      const current = {
        resolve: (value) => resolve(value),
        reject: (error) => reject(error),
      };
      const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
      waiter = current;
      return {
        promise,
        cancel() {
          if (waiter === current) waiter = null;
        },
      };
    },
    close() {
      if (!waiter) return;
      const current = waiter;
      waiter = null;
      current.reject(new Error("Agent session stopped."));
    },
  };
}

export function createApp(repo, { allowRemote = false, agent = null } = {}) {
  // Serialize read/merge/write operations so simultaneous tabs cannot lose
  // unrelated sections (for example, preferences racing with a comment save).
  let stateWrite = Promise.resolve();
  const writeState = (operation) => {
    const result = stateWrite.then(operation);
    stateWrite = result.catch(() => {});
    return result;
  };
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const sendText = (status, body) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(body);
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const host = (req.headers.host || "").split(":")[0];
      if (!allowRemote && !["localhost", "127.0.0.1"].includes(host))
        return send(403, {
          error:
            "Local access only. Behind a reverse proxy? Start rv with --host 0.0.0.0.",
        });
      if (
        req.method !== "GET" &&
        url.pathname !== "/api/state" &&
        url.pathname !== "/api/agent/submit"
      )
        return send(405, { error: "Read-only server." });
      if (url.pathname.startsWith("/api/")) {
        // Custom header + no CORS prevents other websites reading local source files.
        if (
          req.headers["x-rv"] !== "1" ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return send(403, { error: "Same-origin access only." });
        if (url.pathname === "/api/state") {
          // Review state is a browser-independent cache on local disk,
          // served back so it survives restarts, ports and browsers.
          if (req.method === "GET")
            return send(200, (await loadState(repo.root)) || {});
          if (req.method === "PUT" || req.method === "PATCH") {
            const body = await readBody(req, MAX_STATE);
            if (body === null)
              return send(413, { error: "State exceeds the 1 MiB limit." });
            let state;
            try {
              state = JSON.parse(body);
            } catch {
              return send(400, { error: "Invalid JSON." });
            }
            if (!state || typeof state !== "object" || Array.isArray(state))
              return send(400, { error: "State must be a JSON object." });
            await writeState(async () => {
              const next = req.method === "PATCH"
                ? { ...await loadState(repo.root), ...state }
                : state;
              if (Buffer.byteLength(JSON.stringify(next)) > MAX_STATE)
                throw new Error("State exceeds the 1 MiB limit.");
              await saveState(repo.root, next);
            });
            return send(200, { ok: true });
          }
          if (req.method === "DELETE") {
            await writeState(() => clearState(repo.root));
            return send(200, { ok: true });
          }
          return send(405, { error: "Unsupported method." });
        }
        if (url.pathname === "/api/agent/status") {
          if (!agent) return send(404, { error: "Agent mode is not enabled." });
          if (req.headers["x-rv-agent"] !== agent.token)
            return send(403, { error: "Invalid agent session." });
          return send(200, { ok: true });
        }
        if (url.pathname === "/api/agent/wait") {
          if (!agent) return send(404, { error: "Agent mode is not enabled." });
          if (req.headers["x-rv-agent"] !== agent.token)
            return send(403, { error: "Invalid agent session." });
          const pending = agent.wait();
          res.once("close", pending.cancel);
          const prompt = await pending.promise;
          res.off("close", pending.cancel);
          return sendText(200, prompt);
        }
        if (url.pathname === "/api/agent/submit") {
          if (!agent) return send(404, { error: "Agent mode is not enabled." });
          if (req.method !== "POST")
            return send(405, { error: "Unsupported method." });
          const prompt = await readBody(req, MAX_STATE);
          if (prompt === null)
            return send(413, { error: "Prompt exceeds the 1 MiB limit." });
          if (!prompt.trim()) return send(400, { error: "Prompt is empty." });
          await writeState(async () => {
            const state = (await loadState(repo.root)) || {};
            await saveState(repo.root, { ...state, comments: [] });
          });
          agent.submit(prompt);
          return send(200, { ok: true });
        }
        const p = url.searchParams;
        if (url.pathname === "/api/info")
          return send(200, { ...await repo.info(), agent: Boolean(agent) });
        if (url.pathname === "/api/compare")
          return send(
            200,
            await repo.compare(p.get("mode"), p.get("from"), p.get("to")),
          );
        if (url.pathname === "/api/file")
          return send(200, await repo.file(p.get("path"), p.get("ref")));
        return send(404, { error: "Not found." });
      }
      const name =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname).slice(1);
      const filename = path.resolve(dist, name);
      if (!filename.startsWith(dist))
        return send(403, { error: "Invalid path." });
      // Vite fingerprints these filenames. Cache only successful asset reads;
      // HTML and every API response must stay fresh across builds and reviews.
      const asset = /^assets\/.+-[\w-]{8,}\.(js|css|wasm|svg)$/.test(name);
      const acceptsGzip = (req.headers["accept-encoding"] || "")
        .split(",")
        .some((value) => {
          const [encoding, ...params] = value.trim().split(";");
          const quality = params.find((param) => param.trim().startsWith("q="));
          return encoding === "gzip" && (!quality || Number(quality.trim().slice(2)) > 0);
        });
      let data;
      let compressed = false;
      if (asset && acceptsGzip) {
        try {
          data = await readFile(`${filename}.gz`);
          compressed = true;
        } catch (error) {
          // Builds predating precompression can still be served.
          if (error.code !== "ENOENT") throw error;
        }
      }
      data ??= await readFile(filename);
      if (asset) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.setHeader("Vary", "Accept-Encoding");
      }
      if (compressed) res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Length", data.length);
      res.writeHead(200, {
        "Content-Type":
          types[path.extname(filename)] || "application/octet-stream",
      });
      res.end(data);
    } catch (error) {
      send(error.status || (error.code === "ENOENT" ? 404 : 400), {
        error:
          error.code === "ENOENT"
            ? "Not found. Run npm run build first."
            : error.message,
      });
    }
  });
}
