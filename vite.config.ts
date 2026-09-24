import { execFileSync } from "node:child_process";
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
  // The syntax highlighter loads language grammars from local bundled chunks.
  worker: { format: "es" },
});
