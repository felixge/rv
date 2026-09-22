import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
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
        return send(403, { error: "Local access only." });
      if (req.method !== "GET")
        return send(405, { error: "Read-only server." });
      if (url.pathname.startsWith("/api/")) {
        // Custom header + no CORS prevents other websites reading local source files.
        if (
          req.headers["x-difflet"] !== "1" ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return send(403, { error: "Same-origin access only." });
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
