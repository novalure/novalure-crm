import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { compactWebsiteSalesOperationsReceipt } from "../src/lib/website-sales-operations-receipt";

test("large legitimate history does not turn a small committed effect acknowledgement into UNKNOWN", () => {
  const original = { contractVersion: "website-sales-operations-v1", persisted: true, commandId: randomUUID(), auditReference: randomUUID(), correlationId: randomUUID(), replayed: false,
    data: { workspaceId: randomUUID(), projectId: randomUUID(), companyId: randomUUID(), locationId: randomUUID(), portfolioId: randomUUID(), version: 3, canContact: false,
      plan: { ranked: Array.from({ length: 200 }, () => ({ suppliedEvidence: "Current approved business metadata".repeat(100) })) } },
    currentData: { projection: "RESOURCE", policies: Array.from({ length: 25 }, () => ({ policy: "Approved versioned policy metadata".repeat(1000) })) } };
  assert(Buffer.byteLength(JSON.stringify(original)) > 262144);
  const compact = compactWebsiteSalesOperationsReceipt(original);
  assert(Buffer.byteLength(JSON.stringify(compact)) < 2048); assert.equal(compact.commandId, original.commandId); assert.equal(compact.auditReference, original.auditReference);
  assert.equal(compact.correlationId, original.correlationId); assert.equal(compact.data.portfolioId, original.data.portfolioId);
  assert.equal(compact.data.canContact, false); assert.equal(Object.hasOwn(compact, "currentData"), false); assert.equal(Object.hasOwn(compact.data, "plan"), false);
  assert.equal(original.currentData.policies.length, 25); assert.equal(original.data.plan.ranked.length, 200, "Canonical stored evidence was never mutated");
  const recovered = compactWebsiteSalesOperationsReceipt(original, true);
  assert.deepEqual(recovered.currentData, original.currentData); assert.equal(Object.hasOwn(recovered.data, "plan"), false);
  assert(Buffer.byteLength(JSON.stringify(recovered.data)) < 1024, "A recovered receipt also fits the unchanged encrypted journal cap");
});
