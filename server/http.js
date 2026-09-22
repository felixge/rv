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

export function createApp(repo, { allowRemote = false } = {}) {
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const host = (req.headers.host || "").split(":")[0];
      if (!allowRemote && !["localhost", "127.0.0.1"].includes(host))
        return send(403, {
          error:
            "Local access only. Behind a reverse proxy? Start rv with --host 0.0.0.0.",
        });
      if (req.method !== "GET" && url.pathname !== "/api/state")
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
          if (req.method === "PUT") {
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
            await saveState(repo.root, state);
            return send(200, { ok: true });
          }
          if (req.method === "DELETE") {
            await clearState(repo.root);
            return send(200, { ok: true });
          }
          return send(405, { error: "Unsupported method." });
        }
        const p = url.searchParams;
        if (url.pathname === "/api/info") return send(200, await repo.info());
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
      const data = await readFile(filename);
      res.writeHead(200, {
        "Content-Type":
          types[path.extname(filename)] || "application/octet-stream",
      });
      res.end(data);
    } catch (error) {
      send(error.code === "ENOENT" ? 404 : 400, {
        error:
          error.code === "ENOENT"
            ? "Not found. Run npm run build first."
            : error.message,
      });
    }
  });
}
