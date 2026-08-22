#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { splitPostgresStatements } from "./lib/postgres-statement-splitter.mjs";

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error("Pass one or more migration SQL files.");
}

const statements = ["set local search_path = public"];
for (const file of files) {
  const fileName = basename(file);
  const match = fileName.match(/^(\d{3}_[A-Za-z0-9_]+)\.sql$/);
  if (!match) throw new Error(`Invalid migration filename: ${fileName}`);

  const version = match[1];
  const name = version.replace(/^\d{3}_/, "");
  const content = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const checksum = createHash("sha256").update(content).digest("hex");
  statements.push(...splitPostgresStatements(content));
  statements.push(
    `insert into public.novalure_schema_migrations (version, name, checksum) values (${sqlLiteral(version)}, ${sqlLiteral(name)}, ${sqlLiteral(checksum)})`,
  );
}

process.stdout.write(JSON.stringify(statements));
