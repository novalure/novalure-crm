#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [calendar, workspace] = await Promise.all([
  readFile(new URL("../src/components/calendar-command-center.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8"),
]);

test("calendar selectors retain stable visible labels whenever their gated panels are enabled", () => {
  const ids = [
    "calendar-default-provider",
    "calendar-default-meeting-provider",
    "calendar-sync-mode",
    "calendar-share-meeting-type",
    "calendar-share-theme",
  ];

  for (const id of ids) {
    assert.match(calendar, new RegExp(`htmlFor="${id}"`));
    assert.match(calendar, new RegExp(`id="${id}"`));
  }
});

test("booking output has a visible programmatic label and calendar has no nested main", () => {
  assert.match(calendar, /htmlFor="calendar-share-output"/);
  assert.match(calendar, /id="calendar-share-output"/);
  assert.doesNotMatch(calendar, /<\/?main\b/);
  assert.match(calendar, /aria-label=\{automationSteps\.find/);
});

test("calendar feedback is announced without exposing decorative-only text", () => {
  assert.match(calendar, /role="status"/);
  assert.match(calendar, /role="alert"/);
  assert.match(calendar, /aria-live="polite"/);
  assert.match(calendar, /aria-live="assertive"/);
});

test("workspace dialogs are named, keyboard-contained, escapable, and restore focus", () => {
  assert.match(workspace, /aria-labelledby=\{titleId\}/);
  assert.match(workspace, /role="dialog"/);
  assert.match(workspace, /event\.key === "Escape"/);
  assert.match(workspace, /event\.key !== "Tab"/);
  assert.match(workspace, /previouslyFocused\?\.focus\(\)/);
  assert.match(workspace, /className="grid h-11 w-11/);
});

test("role priority headings always have non-empty fallback content", () => {
  assert.match(workspace, /title: roleCopy\.title/);
  assert.match(workspace, />\{profile\.title\}<\/h3>/);
  assert.doesNotMatch(workspace, />\{profile\?\.title\}<\/h3>/);
});
