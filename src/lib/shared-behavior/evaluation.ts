import { createHash } from "node:crypto";
import { behaviorRuleIds, behaviorTargets, compileSharedBehavior, parseBehaviorSelection, type BehaviorSelection } from "./catalog";

/** Deterministic scenario coverage, NOT an LLM conversation-quality benchmark. */
export const scenarioSuite = Object.freeze([
  ["ambiguous-request", "clarify-goal"], ["user-correction", "repair-understanding"],
  ["changed-goal", "follow-topic-switch"], ["changed-language", "match-language"],
  ["person-requested", "offer-human-handoff"], ["actionable-request", "confirm-next-step"],
] as const);
export function selectionDigest(selection: BehaviorSelection): string {
  return createHash("sha256").update(JSON.stringify(parseBehaviorSelection(selection))).digest("hex");
}
export function evaluatorDigest(): string {
  // Bind suite version, scenario definitions, catalog wording and all target classes.
  return createHash("sha256").update(JSON.stringify({ version: "coverage-v1", scenarioSuite,
    catalog: behaviorTargets.map(target => compileSharedBehavior({ contractVersion: "shared-behavior-v1", version: 1,
      selection: { ruleIds: behaviorRuleIds, targets: behaviorTargets } }, target)) })).digest("hex");
}
export function evaluateSelection(candidate: unknown, baseline: BehaviorSelection | null) {
  const selection = parseBehaviorSelection(candidate);
  const previous = baseline === null ? null : parseBehaviorSelection(baseline);
  let improvements = 0, regressions = 0;
  for (const target of behaviorTargets) for (const [, rule] of scenarioSuite) {
    const before = previous?.targets.includes(target) && previous.ruleIds.includes(rule) ? 1 : 0;
    const after = selection.targets.includes(target) && selection.ruleIds.includes(rule) ? 1 : 0;
    if (after > before) improvements++;
    if (after < before) regressions++;
  }
  return Object.freeze({ evaluatorDigest: evaluatorDigest(), selectionDigest: selectionDigest(selection),
    checks: scenarioSuite.length * behaviorTargets.length, improvements, regressions,
    passed: regressions === 0 && improvements > 0 });
}
