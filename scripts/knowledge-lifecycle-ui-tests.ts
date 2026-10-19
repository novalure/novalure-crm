import assert from "node:assert/strict";
import test from "node:test";
import { compareKnowledgeVersions } from "../src/lib/knowledge-center/version-comparison";
import { getKnowledgeLifecycleCopy } from "../src/lib/knowledge-center/lifecycle-copy";
import type { KnowledgeVersion } from "../src/lib/knowledge-center/types";

const version: KnowledgeVersion = { id: "v1", sourceId: "source", version: 1, name: "Opening hours", content: "Monday 09:00", structuredData: {}, url: null, mediaAssetId: null, status: "draft", createdAt: "2026-10-19T12:00:00Z", approvedAt: null, processingStatus: "manual", processingMessage: null, processingFormat: null };

test("version comparison identifies changed and removed content without confusing structured names", () => {
  const previous = { ...version, structuredData: { name: "Legal name", optional: null, price: 0 } };
  const current = { ...version, content: "Monday 11:00", structuredData: { name: "Trading name", price: 0 } };
  const changes = compareKnowledgeVersions(previous, current);
  assert.deepEqual(changes.map((change) => change.field), ["content", "structured.name", "structured.optional"]);
  assert.equal(changes[0].before, "Monday 09:00");
  assert.equal(changes[0].after, "Monday 11:00");
  assert.equal(changes[2].before, "null");
  assert.equal(changes[2].after, "");
  assert.equal(previous.structuredData.name, "Legal name");
});

test("version comparison ignores object key order while preserving array order and numeric types", () => {
  assert.deepEqual(compareKnowledgeVersions({ ...version, structuredData: { contact: { address: { city: "Vienna", zip: 1010 }, names: ["a", "b"] } } }, { ...version, structuredData: { contact: { names: ["a", "b"], address: { zip: 1010, city: "Vienna" } } } }), []);
  assert.equal(compareKnowledgeVersions({ ...version, structuredData: { price: 0 } }, { ...version, structuredData: { price: "0" } }).length, 1);
  assert.equal(compareKnowledgeVersions({ ...version, structuredData: { options: ["a", "b"] } }, { ...version, structuredData: { options: ["b", "a"] } }).length, 1);
});

test("lifecycle copy distinguishes approval from publication and supplies restoration and monitoring states in all languages", () => {
  for (const language of ["de", "en", "es"] as const) {
    const copy = getKnowledgeLifecycleCopy(language);
    for (const key of ["draft", "submitted", "reviewed", "approved", "published", "archived", "error", "restore", "currentConfirm", "legalConfirm", "daily", "weekly", "monthly", "monitoringHint"] as const) assert.ok(copy[key].trim(), `${language}: ${key}`);
    assert.notEqual(copy.approve, copy.publish);
    assert.notEqual(copy.approved, copy.published);
  }
});
