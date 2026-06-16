import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".vercel/**",
    ".next/**",
    ".codex-worktrees/**",
    "out/**",
    "build/**",
    "docs/**",
    "*.docx",
    "next-env.d.ts",
    ".novalure-*.cjs",
  ]),
]);

export default eslintConfig;
