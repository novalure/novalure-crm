#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/components/password-visibility-input.tsx", import.meta.url),
  "utf8",
);

test("password visibility input forwards native React 19 props and ref", () => {
  assert.match(source, /ComponentPropsWithRef<"input">/);
  assert.match(source, /\.\.\.nativeProps/);
  assert.match(source, /ref=\{ref\}/);
  assert.match(source, /Omit<ComponentPropsWithRef<"input">, "type">/);
});

test("password visibility toggle is named, associated and at least 44 pixels", () => {
  assert.match(source, /aria-controls=\{id\}/);
  assert.match(source, /aria-label=\{label\}/);
  assert.match(source, /aria-pressed=\{revealed\}/);
  assert.match(source, /h-11 w-11/);
  assert.match(source, /type="button"/);
});
