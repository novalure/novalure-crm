import { readFileSync } from "node:fs";
import { assertSharedBehaviorMigrationSources, assertSharedBehaviorQaLedger } from "./lib/shared-behavior-migration-contract.mjs";
const source = assertSharedBehaviorMigrationSources();
if (process.argv.length === 2) console.log(JSON.stringify(source));
else if (process.argv[2] === "--qa-ledger" && process.argv.length === 4)
  console.log(JSON.stringify({ source, qaReference: assertSharedBehaviorQaLedger(JSON.parse(readFileSync(process.argv[3], "utf8"))) }));
else throw new Error("Use no arguments or --qa-ledger <existing-metadata-json>; no database operation is performed");
