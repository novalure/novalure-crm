#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [knowledge, sequences, workspace, password] = await Promise.all([
  readFile(new URL("../src/components/knowledge-command-center.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/lead-sequence-command-center.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/password-visibility-input.tsx", import.meta.url), "utf8"),
]);

test("audited icon controls use at least 44 by 44 CSS pixel target boxes", () => {
  assert.doesNotMatch(sequences, /grid h-9 w-9/);
  assert.doesNotMatch(knowledge, /grid h-9 w-9/);
  assert.ok((sequences.match(/grid h-11 w-11/g)?.length ?? 0) >= 4);
  assert.match(knowledge, /grid h-11 w-11/);
  assert.match(workspace, /className="grid h-11 w-11/);
  assert.match(password, /h-11 w-11/);
});
