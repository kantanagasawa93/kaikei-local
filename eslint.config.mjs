import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Round 30: ビルド成果物・worktree コピー・別プロジェクトを lint 対象から除外
    // (これまで src-tauri/target 等の bundled JS で 2,000+ 件の偽エラーが出ていた)
    "src-tauri/**",
    ".claude/**",
    "api-server/**",
    "docs/**",
    "scripts/**",
    "*.mjs",
  ]),
]);

export default eslintConfig;
