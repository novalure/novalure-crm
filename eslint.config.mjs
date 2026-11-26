import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The standalone relinking proof loads the CommonJS decoder through Node.
  {
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
    // This is generated Emscripten output. Its inputs and relinking proof are shipped separately.
    "public/heic-decoder/primary.js",
    "docs/**",
    "*.docx",
    "next-env.d.ts",
    ".novalure-*.cjs",
  ]),
]);

export default eslintConfig;
