import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

test("deal pipeline no longer persists working state in browser storage", () => {
  const pipeline = readText("src/components/deal-pipeline-workspace.tsx");

  assert.doesNotMatch(pipeline, /localStorage\.(getItem|setItem)/);
  assert.doesNotMatch(pipeline, /loadStoredRecord/);
  assert.doesNotMatch(pipeline, /DEAL_PATCH_STORAGE_KEY|MANUAL_DEAL_STORAGE_KEY|STAGE_HISTORY_STORAGE_KEY/);
});

test("deal creation only succeeds with a persisted server deal", () => {
  const pipeline = readText("src/components/deal-pipeline-workspace.tsx");

  assert.doesNotMatch(pipeline, /persistedDeal\s*\?\?\s*deal/);
  assert.match(pipeline, /if \(!persistedDeal\) \{\s*setSavedMessage\(text\.createFailed\);\s*return;/s);
  assert.match(pipeline, /setManualDeals\(\(current\) => \[persistedDeal/);
  assert.match(pipeline, /await refreshDealsFromSource\(\)/);
});

test("pipeline changes refresh the shared CRM core source", () => {
  const pipeline = readText("src/components/deal-pipeline-workspace.tsx");
  const workspace = readText("src/components/crm-workspace.tsx");

  assert.match(pipeline, /onDealsChanged\?: \(\) => Promise<boolean \| void> \| boolean \| void/);
  assert.match(pipeline, /const refreshDealsFromSource = async \(\) =>/);
  assert.match(workspace, /onDealsChanged=\{refreshCoreData\}/);
});

test("pipeline copy no longer exposes local-session terminology", () => {
  const i18n = readText("src/lib/i18n.ts");

  assert.doesNotMatch(i18n, /reset: "Reset local changes"/);
  assert.doesNotMatch(i18n, /localReset:/);
  assert.doesNotMatch(i18n, /reset: "Lokale/);
  assert.match(i18n, /discardDraft: "Discard draft"/);
  assert.match(i18n, /discardDraft: "Entwurf verwerfen"/);
  assert.match(i18n, /historyLocalActor: "CRM save"/);
  assert.match(i18n, /historyLocalActor: "CRM-Speicherung"/);
});
