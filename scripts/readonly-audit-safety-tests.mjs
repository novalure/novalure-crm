#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("environment fingerprint utility logs only hashes, booleans and sanitized error classes", async () => {
  const source = await readFile(
    new URL("./env-target-fingerprint-readonly.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /slice\(0, 20\)/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(?:DATABASE_URL|RESEND_API_KEY|READ_WRITE_TOKEN)/u);
  assert.match(source, /errorClass: error instanceof Error \? error\.name/);
});

test("schema and ledger audit contains only SELECT statements", async () => {
  const source = await readFile(
    new URL("./schema-ledger-readonly-audit.mjs", import.meta.url),
    "utf8",
  );
  const sqlStatements = [
    ...source.matchAll(/sql\.query\(\s*([`"])([\s\S]*?)\1/gmu),
  ].map((match) => match[2].trim().toLowerCase());

  assert.ok(sqlStatements.length >= 3);
  for (const statement of sqlStatements) {
    assert.match(statement, /^(?:select|with\b[\s\S]*\bselect\b)/u);
    assert.doesNotMatch(statement, /\b(?:insert|update|delete|alter|drop|truncate|create|grant|revoke)\b/u);
  }
});
