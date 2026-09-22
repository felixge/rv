import { defineConfig } from "vite";

export default defineConfig({
  // The syntax highlighter loads language grammars from local bundled chunks.
  worker: { format: "es" },
});
