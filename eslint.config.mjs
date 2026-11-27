import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The redistributable HEIC relinking proof is an intentionally CommonJS tool.
    files: ["public/third-party/heic-decoder/relink-proof/test-relink.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".vercel/**",
    ".npm-cache/**",
    ".next/**",
    "design-c/.next/**",
    "design-c/out/**",
    "design-c/verification/**",
    ".codex-worktrees/**",
    "out/**",
    "build/**",
    "docs/**",
    "*.docx",
    "next-env.d.ts",
    // Generated third-party decoder; keep authored application code linted.
    "public/heic-decoder/primary.js",
    ".novalure-*.cjs",
  ]),
]);

export default eslintConfig;
