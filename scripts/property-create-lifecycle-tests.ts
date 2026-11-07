import assert from "node:assert/strict";
import { test } from "node:test";
import { createPropertyDraftStore, protectPropertyDraftUnload, type PropertyCreateAttempt, type PropertyDraft } from "../src/lib/property-draft-store";

const initial = { title: "", projectId: "project-a" } as PropertyDraft;
const attempt = (submittedDraft: PropertyDraft, key = "command-a"): PropertyCreateAttempt => ({
  workspaceId: "workspace-a", projectId: "project-a", endpoint: "/api/crm/properties?workspaceId=workspace-a",
  body: JSON.stringify(submittedDraft), key, correlation: "correlation-a", submittedDraft, phase: "in_flight",
});

test("a late receipt cannot retire a replacement command or erase newer input", () => {
  const store = createPropertyDraftStore("user-a"), scope = "scope-a";
  const submitted = store.update(scope, initial, { ...initial, title: "SYNTHETIC submitted" });
  store.setCreateAttempt(scope, attempt(submitted));
  const replacement = { ...attempt(submitted, "command-b"), body: "SYNTHETIC replacement" };
  store.setCreateAttempt(scope, replacement);
  assert.equal(store.clearCreateAttempt(scope, "command-a"), false);
  assert.equal(store.markCreateUncertain(scope, "command-a"), false);
  assert.equal(store.readCreateAttempt(scope), replacement);
  const newer = store.update(scope, initial, { ...submitted, title: "SYNTHETIC newer" });
  assert.equal(store.clearCreateAttempt(scope, "command-b"), true);
  assert.equal(store.clear(scope, submitted), false);
  assert.equal(store.read(scope), newer);
});

test("one shared mutation lock spans scopes and stale release cannot unlock another request", () => {
  const store = createPropertyDraftStore("user-a");
  const first = store.acquireMutation(); assert.ok(first);
  assert.equal(store.acquireMutation(), null);
  store.clearAll(); // Sign-out/identity change discards that session's RAM.
  const second = store.acquireMutation(); assert.ok(second);
  assert.equal(store.releaseMutation(first), false);
  assert.equal(store.isMutationBusy(), true);
  assert.equal(store.releaseMutation(second), true);
});

test("pending commands keep the parent unload guard active even without a draft entry", () => {
  const store = createPropertyDraftStore("user-a"); let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; }, returnValue: "" };
  store.setCreateAttempt("scope-a", attempt(initial));
  assert.equal(protectPropertyDraftUnload(store, event), true);
  assert.equal(prevented, 1);
  assert.equal(store.hasCreateAttemptOutside("scope-b"), true);
  assert.equal(store.readCreateAttempt("scope-b"), undefined);
  store.clearAll();
  assert.equal(store.hasDrafts(), false);
  assert.equal(protectPropertyDraftUnload(store, event), false);
});
