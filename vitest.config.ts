import { defineConfig } from "vitest/config";
import path from "node:path";

// Tauri プラグインは WebView ランタイム前提なので、unit テストでは
// src/test-stubs/ の最小スタブに差し替える (import 時に落ちないことだけ保証)。
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@tauri-apps/plugin-sql": path.resolve(__dirname, "src/test-stubs/tauri-plugin-sql.ts"),
      "@tauri-apps/plugin-fs": path.resolve(__dirname, "src/test-stubs/tauri-plugin-fs.ts"),
      "@tauri-apps/api/path": path.resolve(__dirname, "src/test-stubs/tauri-api-path.ts"),
      "@tauri-apps/api/core": path.resolve(__dirname, "src/test-stubs/tauri-api-core.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
