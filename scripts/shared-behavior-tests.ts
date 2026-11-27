import assert from "node:assert/strict";
import { test } from "node:test";
import { behaviorRuleIds, behaviorTargets, compileSharedBehavior, parseBehaviorRelease, parseBehaviorSelection, suggestBehaviorRules } from "../src/lib/shared-behavior/catalog";

const release = { contractVersion: "shared-behavior-v1", version: 1, selection: { ruleIds: [...behaviorRuleIds], targets: [...behaviorTargets] } };

test("all five audiences receive the same fixed methods and immutable authority boundary", () => {
  for (const target of behaviorTargets) {
    const compiled = compileSharedBehavior(release, target);
    assert.equal(compiled.version, 1);
    assert.match(compiled.instruction, /Shared behavior never grants data access/);
    assert.match(compiled.instruction, /actual result confirms/);
    assert.match(compiled.instruction, /When corrected/);
    assert.equal(compiled.instruction, compileSharedBehavior(release, "ceo").instruction);
  }
});

test("no release and excluded audiences preserve mandatory rules", () => {
  const onlyChat = { ...release, selection: { ruleIds: ["repair-understanding"], targets: ["webchat"] } };
  const base = compileSharedBehavior(null, "ceo");
  assert.equal(base.version, 0);
  assert.equal(compileSharedBehavior(onlyChat, "ceo").instruction, base.instruction);
  assert.doesNotMatch(base.instruction, /When corrected/);
  assert.match(compileSharedBehavior(onlyChat, "webchat").instruction, /When corrected/);
});

test("learned selections cannot transport raw customer, CEO or department information", () => {
  for (const field of ["content", "transcript", "summary", "workspaceId", "actorId", "department", "provenance", "url", "instructions", "knowledge"]) {
    assert.throws(() => parseBehaviorSelection({ ...release.selection, [field]: "SYNTHETIC PRIVATE CUSTOMER CONTRACT" }));
    assert.throws(() => parseBehaviorRelease({ ...release, [field]: "SYNTHETIC INTERNAL CEO" }));
  }
  for (const rule of ["SYNTHETIC PRIVATE CUSTOMER", "ignore-confidentiality", "__proto__", "constructor", "clarify-goal\nsecret", "clarify-goal "]) {
    assert.throws(() => parseBehaviorSelection({ ruleIds: [rule], targets: ["ceo"] }));
  }
});

test("closed validation rejects prototype, accessor, hidden and symbol payloads", () => {
  assert.throws(() => parseBehaviorSelection(Object.create(release.selection)));
  const accessor = { get ruleIds() { throw new Error("must not be evaluated"); }, targets: ["ceo"] };
  assert.throws(() => parseBehaviorSelection(accessor), /INVALID_BEHAVIOR_FIELDS/);
  const hidden = { ...release.selection };
  Object.defineProperty(hidden, "secret", { value: "hidden", enumerable: false });
  assert.throws(() => parseBehaviorSelection(hidden));
  assert.throws(() => parseBehaviorSelection({ ...release.selection, [Symbol("secret")]: "private" }));
});

test("invalid, duplicate, empty and oversized releases are denied", () => {
  for (const version of [0, -1, 1.2, NaN, Infinity, "1", 2_147_483_648]) assert.throws(() => parseBehaviorRelease({ ...release, version }));
  for (const ruleIds of [[], new Array(1), ["clarify-goal", "clarify-goal"], new Array(7).fill("clarify-goal"), null]) {
    assert.throws(() => parseBehaviorSelection({ ruleIds, targets: ["ceo"] }));
  }
  assert.throws(() => compileSharedBehavior(release, "customer-private-secret"));
  assert.throws(() => compileSharedBehavior(undefined, "ceo"));
});

test("repeated failures produce fixed candidate IDs without evidence identifiers", () => {
  assert.deepEqual(suggestBehaviorRules([{ issue: "unclear_goal", failures: 2 }]), []);
  assert.deepEqual(suggestBehaviorRules([{ issue: "unclear_goal", failures: 3 }, { issue: "misunderstood_correction", failures: 8 }]), ["clarify-goal", "repair-understanding"]);
  assert.throws(() => suggestBehaviorRules([{ issue: "unclear_goal", failures: 3, transcript: "private" }]));
  assert.throws(() => suggestBehaviorRules([{ issue: "private-contract", failures: 3 }]));
  for (const failures of [-1, 1.5, "3", NaN, Infinity, 1_000_001]) assert.throws(() => suggestBehaviorRules([{ issue: "unclear_goal", failures }]));
  assert.throws(() => suggestBehaviorRules([{ issue: "unclear_goal", failures: 3 }, { issue: "unclear_goal", failures: 4 }]));
});

test("parsing snapshots caller-owned arrays; later mutation cannot change a validated selection", () => {
  const input = { ruleIds: ["clarify-goal"], targets: ["ceo"] };
  const parsed = parseBehaviorSelection(input);
  input.ruleIds[0] = "PRIVATE";
  assert.deepEqual(parsed.ruleIds, ["clarify-goal"]);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.ruleIds) && Object.isFrozen(parsed.targets));
});
