import assert from "node:assert/strict";
import test from "node:test";
import { makePropertyObservation, type PropertyObservationInput } from "../src/lib/crm-property-observation";

const base: PropertyObservationInput = {
  actorId: "d3d8620c-dc34-4a02-8ea6-0e8b457ab44d",
  workspaceId: "bd0bb16b-2f0f-4ed0-8780-8e8d1406a10d",
  projectId: "3e524572-dddf-4320-803e-4c86103e6cd9",
  unitId: "db29989d-3daa-4e43-b1d7-cf7144677983",
  sourceRevision: "a".repeat(40), deploymentId: "dpl_Test1", objectVersion: 3,
  updatedAt: "2026-11-20T12:00:00.000Z",
  requestedFields: ["priceCents", "areaSqm", "rooms", "status", "balconyAreaSqm"],
  row: { priceCents: "0", areaSqm: "74.50", rooms: null, status: "undocumented" },
};

test("projection keeps zero, null, absent and unknown status distinct", () => {
  const result = makePropertyObservation(base);
  assert.deepEqual(result.fields, [
    { field: "priceCents", value: 0, valueState: "PRESENT" },
    { field: "areaSqm", value: 74.5, valueState: "PRESENT" },
    { field: "rooms", value: null, valueState: "EXPLICIT_UNKNOWN" },
    { field: "status", value: "UNKNOWN", valueState: "PRESENT" },
    { field: "balconyAreaSqm", value: null, valueState: "NOT_EXPOSED" },
  ]);
  assert.equal(result.authority, "NOT_ESTABLISHED");
  assert.equal(result.sourceApproval, "NOT_EXPOSED");
  assert.equal(result.purpose, "property_read");
  assert.equal(Object.isFrozen(result.fields), true);
});

test("projects only explicitly requested fields and preserves CRM identifiers", () => {
  const result = makePropertyObservation({ ...base, requestedFields: ["status"], row: { status: "sold", priceCents: 1234 } });
  assert.deepEqual(result.fields, [{ field: "status", value: "sold", valueState: "PRESENT" }]);
  assert.equal(result.unitId, base.unitId);
  assert.equal(result.sourceRevision, base.sourceRevision);
  assert.equal(result.objectVersion, 3);
});

test("detail values respect database precision and parking count bounds", () => {
  const result = makePropertyObservation({ ...base, requestedFields: ["balconyAreaSqm", "carportCount"],
    row: { balconyAreaSqm: "99999999.99", carportCount: "10000" } });
  assert.deepEqual(result.fields, [
    { field: "balconyAreaSqm", value: 99999999.99, valueState: "PRESENT" },
    { field: "carportCount", value: 10000, valueState: "PRESENT" },
  ]);
  for (const [field, value] of [["balconyAreaSqm", "100000000"], ["balconyAreaSqm", "1.001"], ["carportCount", "10001"], ["carportCount", "0.5"]] as const)
    assert.throws(() => makePropertyObservation({ ...base, requestedFields: [field], row: { [field]: value } }), /CRM_PROPERTY_OBSERVATION_INVALID/);
});

test("rejects malformed scope, metadata, field selection and unsupported raw data", () => {
  for (const patch of [
    { actorId: "anonymous" }, { projectId: "not-a-uuid" }, { sourceRevision: "x" },
    { deploymentId: "unknown" }, { objectVersion: 0 }, { updatedAt: "tomorrow" },
    { requestedFields: [] }, { requestedFields: ["status", "status"] },
    { requestedFields: ["ownerEmail"] }, { row: { priceCents: "-1" } },
    { row: { priceCents: "9007199254740992" } }, { row: { priceCents: "1.5" } },
    { row: { priceCents: "9007199254740991.1" } }, { row: { priceCents: "1.00" } },
    { row: { priceCents: "1e3" } }, { row: { priceCents: true } },
    { row: { priceCents: undefined } }, { row: { status: 1 } },
  ]) {
    assert.throws(() => makePropertyObservation({ ...base, ...patch } as PropertyObservationInput), /CRM_PROPERTY_OBSERVATION_INVALID/);
  }
});
