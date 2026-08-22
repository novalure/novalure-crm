#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspace = await readFile(
  new URL("../src/components/crm-workspace.tsx", import.meta.url),
  "utf8",
);

function presetSource(presetId, nextPresetId) {
  const start = workspace.indexOf(`  ${presetId}: {`);
  const end = nextPresetId
    ? workspace.indexOf(`  ${nextPresetId}: {`, start + 1)
    : workspace.indexOf("const quickActionSections", start + 1);
  assert.notEqual(start, -1, `${presetId} preset must exist`);
  assert.notEqual(end, -1, `${nextPresetId ?? "preset map end"} must follow ${presetId}`);
  return workspace.slice(start, end);
}

test("analysis quick actions have a real navigation entry in every offering preset", () => {
  const marketing = presetSource("marketing", "assistant");
  const management = presetSource("management", "newUser");
  const novalureAdmin = presetSource("novalureAdmin");

  for (const [name, source] of [
    ["marketing", marketing],
    ["management", management],
    ["novalureAdmin", novalureAdmin],
  ]) {
    assert.match(source, /navigationEntries:\s*\[[\s\S]*?"analysis"/m, `${name} navigation must expose analysis`);
    assert.match(source, /quickActions:\s*\[[\s\S]*?"analysis"/m, `${name} quick actions must expose analysis`);
  }
});

test("quick actions resolve through enabled navigation entries and never a hidden section fallback", () => {
  assert.match(workspace, /const visibleQuickActionIds = normalizedActivePreset\.quickActions\.filter/);
  assert.match(workspace, /enabledNavigationEntryIds\.some\([\s\S]*navigationEntries\[entryId\]\.section === targetSection/);
  assert.match(workspace, /const matchingEntryId = enabledNavigationEntryIds\.find/);
  assert.match(workspace, /handleNavigationChange\(matchingEntryId\)/);
  assert.doesNotMatch(workspace, /if \(nextSection\) \{\s*handleSectionChange\(nextSection\);/);
  assert.match(workspace, /\{visibleQuickActionIds\.map\(\(actionId\) => \(/);
});
