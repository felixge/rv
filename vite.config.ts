import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { defineConfig } from "vite";

function version() {
  try {
    return execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  }
}

export default defineConfig({
  define: { __RV_VERSION__: JSON.stringify(version()) },
  plugins: [{
    name: "precompress-assets",
    generateBundle: {
      // Vite must finish replacing preload markers before we compress chunks.
      order: "post",
      handler(_, bundle) {
        // Compress at build time, not on the first request. Include worker chunks
        // and language grammars, which are fetched independently of the entrypoint.
        for (const item of Object.values(bundle)) {
          if (!/\.(js|css|wasm|svg)$/.test(item.fileName)) continue;
          const source = item.type === "chunk" ? item.code : item.source;
          this.emitFile({
            type: "asset",
            fileName: `${item.fileName}.gz`,
            source: gzipSync(source, { level: 9 }),
          });
        }
      },
    },
  }],
  // The syntax highlighter loads language grammars from local bundled chunks.
  worker: { format: "es" },
});
