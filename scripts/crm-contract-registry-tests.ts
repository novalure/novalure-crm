import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCrmContractCompatibility,
  assertCrmContractRegistryChange,
  CRM_CANONICAL_ENTITIES,
  CRM_CONTRACT_REGISTRY,
  CRM_CONTRACT_SCHEMA_VERSION,
  CrmContractCompatibilityError,
  detectCrmContractImpact,
  validateCrmContractRegistry,
  type CrmContractRegistry,
} from "../src/lib/crm-contract-registry";

const clone = () => structuredClone(CRM_CONTRACT_REGISTRY) as unknown as CrmContractRegistry;

test("registry: every provider-neutral contract is complete and machine serializable", () => {
  assert.deepEqual(validateCrmContractRegistry(), []);
  assert.equal(CRM_CONTRACT_REGISTRY.providerNeutral, true);
  assert.doesNotMatch(JSON.stringify(CRM_CONTRACT_REGISTRY), /hubspot|salesforce|pipedrive/i);
  assert.deepEqual(Object.keys(CRM_CONTRACT_REGISTRY.canonicalEntities), [...CRM_CANONICAL_ENTITIES]);
  for (const definition of CRM_CONTRACT_REGISTRY.contracts) {
    assert.ok(definition.schemaVersion);
    assert.ok(definition.producer);
    assert.ok(definition.consumer);
    assert.equal(definition.compatibility.rejectUnknownVersions, true);
    assert.equal(definition.compatibility.rejectWriteDowngrade, true);
    assert.ok(definition.requiredTests.length >= 4);
    assert.ok(definition.changeOwner);
  }
});

test("registry: required capability families and both B2B acquisition pipelines are explicit", () => {
  assert.deepEqual(CRM_CONTRACT_REGISTRY.contracts.map(item => item.id), [
    "crm.records.read", "crm.records.write", "crm.events", "crm.tasks", "crm.activities", "crm.approvals", "crm.documents", "crm.customer-communication", "crm.reporting", "crm.finance-references",
  ]);
  assert.equal(CRM_CONTRACT_REGISTRY.acquisitionPipelines.developerProjectMarketing.key, "developer_project_marketing");
  assert.equal(CRM_CONTRACT_REGISTRY.acquisitionPipelines.websiteWebDesign.key, "website_web_design");
  for (const pipeline of Object.values(CRM_CONTRACT_REGISTRY.acquisitionPipelines)) {
    assert.equal(pipeline.model, "crm_pipelines");
    assert.ok(pipeline.entities.includes("Deal"));
    assert.ok(pipeline.entities.includes("Pipeline"));
    assert.ok(pipeline.stages.includes("won"));
    assert.ok(pipeline.stages.includes("lost"));
  }
});

test("compatibility: exact active versions pass and unknown contracts or versions fail closed", () => {
  assert.equal(assertCrmContractCompatibility({contractId:"crm.records.read",schemaVersion:CRM_CONTRACT_SCHEMA_VERSION,access:"read"}).id, "crm.records.read");
  for (const input of [
    {contractId:"crm.missing",schemaVersion:CRM_CONTRACT_SCHEMA_VERSION,access:"read" as const},
    {contractId:"crm.records.read",schemaVersion:"0.9.0",access:"read" as const},
    {contractId:"crm.records.read",schemaVersion:CRM_CONTRACT_SCHEMA_VERSION,access:"write" as const},
  ]) assert.throws(() => assertCrmContractCompatibility(input), CrmContractCompatibilityError);
});

test("compatibility: an old writer cannot overwrite state written by a newer schema", () => {
  assert.throws(
    () => assertCrmContractCompatibility({contractId:"crm.records.write",schemaVersion:"0.9.0",storedSchemaVersion:"1.0.0",access:"write"}),
    (error: unknown) => error instanceof CrmContractCompatibilityError && error.code === "CRM_CONTRACT_VERSION_ROLLBACK",
  );
  assert.throws(
    () => assertCrmContractCompatibility({contractId:"crm.records.write",schemaVersion:"1.0.0",storedSchemaVersion:"2.0.0",access:"write"}),
    (error: unknown) => error instanceof CrmContractCompatibilityError && error.code === "CRM_CONTRACT_VERSION_ROLLBACK",
  );
  assert.doesNotThrow(() => assertCrmContractCompatibility({contractId:"crm.records.write",schemaVersion:"1.0.0",storedSchemaVersion:"1.0.0",access:"write"}));
});

test("impact: additions require minor review while removals and compatibility changes are major", () => {
  const same = clone();
  assert.deepEqual(detectCrmContractImpact(CRM_CONTRACT_REGISTRY, same), {level:"none",changes:[],requiredTests:[]});

  const removed = clone();
  (removed.contracts as unknown as {operations:string[]}[])[0].operations = ["get"];
  const removalImpact = detectCrmContractImpact(CRM_CONTRACT_REGISTRY, removed);
  assert.equal(removalImpact.level, "major");
  assert.ok(removalImpact.changes.includes("operation-removed:crm.records.read:list"));

  const added = clone();
  (added.contracts as unknown as {operations:string[]}[])[0].operations.push("search");
  const additionImpact = detectCrmContractImpact(CRM_CONTRACT_REGISTRY, added);
  assert.equal(additionImpact.level, "minor");
  assert.ok(additionImpact.requiredTests.includes("tenant-isolation-negative"));
  assert.throws(() => assertCrmContractRegistryChange(CRM_CONTRACT_REGISTRY, added), /CRM_REGISTRY_VERSION_INVALID/);
  added.registryVersion = "1.1.0";
  assert.equal(assertCrmContractRegistryChange(CRM_CONTRACT_REGISTRY, added).level, "minor");
});

test("isolation: registry metadata contains no tenant identity or provider credential channel", () => {
  const serialized = JSON.stringify(CRM_CONTRACT_REGISTRY);
  assert.doesNotMatch(serialized, /tenantId|workspaceId|token|secret|credential|authorization/i);
  assert.ok(CRM_CONTRACT_REGISTRY.contracts.every(item => item.requiredTests.includes("tenant-isolation-negative")));
});
