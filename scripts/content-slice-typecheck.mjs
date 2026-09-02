import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "..");
const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
if (configFile.error) {
  console.error(ts.formatDiagnosticsWithColorAndContext([configFile.error], {
    getCanonicalFileName: (value) => value,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const sourceRoots = [
  "src/lib/content-library.ts",
  "src/lib/privacy-lifecycle.ts",
  "src/lib/db/content-library-repositories.ts",
  "src/lib/db/global-search-repository.ts",
  "src/lib/db/privacy-lifecycle-repository.ts",
  "src/components/content-library-panel.tsx",
  "src/components/global-search-command.tsx",
  "src/components/privacy-lifecycle-panel.tsx",
];
const routeRoots = fs.readdirSync(path.join(root, "src/app/api/crm"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
  .filter((file) => /[\\/](documents|templates|search|privacy)[\\/]/.test(file));
const rootNames = [...sourceRoots.map((file) => path.join(root, file)), ...routeRoots];
const program = ts.createProgram({
  rootNames,
  options: { ...parsed.options, incremental: false, noEmit: true, tsBuildInfoFile: undefined },
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (value) => value,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  process.exit(1);
}
console.log(`Content/Search/Privacy typecheck passed (${rootNames.length} roots).`);
