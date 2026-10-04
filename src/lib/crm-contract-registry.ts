/**
 * Provider-neutral, machine-readable contract between Novalure CRM and its
 * automation consumers. This is deliberately application code rather than a
 * database catalogue: changing the integration contract must be reviewed and
 * deployed with the code that enforces it.
 */

export const CRM_CONTRACT_REGISTRY_VERSION = "1.0.0";
export const CRM_CONTRACT_SCHEMA_VERSION = "1.0.0";
export const CRM_LEGACY_WIRE_VERSION = "crm-integration-v1";

export const CRM_CANONICAL_ENTITIES = [
  "Contact",
  "Company",
  "Lead",
  "Deal",
  "Pipeline",
  "Activity",
  "Email",
  "Meeting",
  "Task",
  "Document",
  "Offer",
  "Project",
  "WorkPackage",
  "Approval",
  "SupportCase",
] as const;

export type CrmCanonicalEntity = (typeof CRM_CANONICAL_ENTITIES)[number];
export type CrmContractAccess = "read" | "write" | "publish" | "consume";

type ContractCompatibility = {
  strategy: "exact";
  acceptedSchemaVersions: readonly string[];
  rejectUnknownVersions: true;
  rejectWriteDowngrade: true;
};

export type CrmContractDefinition = {
  id: string;
  schemaVersion: string;
  producer: "novalure-crm" | "evelyn";
  consumer: "novalure-crm" | "evelyn";
  access: CrmContractAccess;
  compatibility: ContractCompatibility;
  requiredTests: readonly string[];
  changeOwner: string;
  entities: readonly CrmCanonicalEntity[];
  operations: readonly string[];
};

const exactCompatibility: ContractCompatibility = {
  strategy: "exact",
  acceptedSchemaVersions: [CRM_CONTRACT_SCHEMA_VERSION],
  rejectUnknownVersions: true,
  rejectWriteDowngrade: true,
};

const requiredBoundaryTests = [
  "schema-validation",
  "version-rejection",
  "tenant-isolation-negative",
  "synthetic-provider-free",
] as const;

const contract = (
  id: string,
  producer: CrmContractDefinition["producer"],
  consumer: CrmContractDefinition["consumer"],
  access: CrmContractAccess,
  entities: readonly CrmCanonicalEntity[],
  operations: readonly string[],
  requiredTests: readonly string[] = requiredBoundaryTests,
): CrmContractDefinition => ({
  id,
  schemaVersion: CRM_CONTRACT_SCHEMA_VERSION,
  producer,
  consumer,
  access,
  compatibility: exactCompatibility,
  requiredTests,
  changeOwner: "crm-platform",
  entities,
  operations,
});

export type CrmContractRegistry = {
  registryId: string;
  registryVersion: string;
  schemaVersion: string;
  wireVersion: string;
  providerNeutral: true;
  compatibility: { reads: string; writes: string; unknown: "reject" };
  canonicalEntities: Record<CrmCanonicalEntity, { source: string; support: "native" | "projection" }>;
  acquisitionPipelines: Record<string, {
    key: string;
    model: string;
    entities: readonly CrmCanonicalEntity[];
    stages: readonly string[];
  }>;
  contracts: readonly CrmContractDefinition[];
};

export const CRM_CONTRACT_REGISTRY = {
  registryId: "novalure-crm-evelyn",
  registryVersion: CRM_CONTRACT_REGISTRY_VERSION,
  schemaVersion: CRM_CONTRACT_SCHEMA_VERSION,
  wireVersion: CRM_LEGACY_WIRE_VERSION,
  providerNeutral: true,
  compatibility: {
    reads: "exact-schema-version",
    writes: "exact-schema-version-and-resource-cas",
    unknown: "reject",
  },
  canonicalEntities: {
    Contact: { source: "contacts", support: "native" },
    Company: { source: "organizations", support: "native" },
    Lead: { source: "leads", support: "native" },
    Deal: { source: "deals", support: "native" },
    Pipeline: { source: "crm_pipelines", support: "native" },
    Activity: { source: "contact_timeline_items", support: "native" },
    Email: { source: "conversations[channel=E-Mail]", support: "projection" },
    Meeting: { source: "calendar_events", support: "native" },
    Task: { source: "tasks", support: "native" },
    Document: { source: "property_documents", support: "projection" },
    Offer: { source: "crm_offers", support: "native" },
    Project: { source: "projects", support: "native" },
    WorkPackage: { source: "tasks[metadata.workPackage]", support: "projection" },
    Approval: { source: "crm_offer_approvals|crm_synthetic_approval_requests", support: "projection" },
    SupportCase: { source: "conversations[metadata.supportCase]", support: "projection" },
  },
  acquisitionPipelines: {
    developerProjectMarketing: {
      key: "developer_project_marketing",
      model: "crm_pipelines",
      entities: ["Company", "Contact", "Lead", "Deal", "Pipeline", "Project", "Offer", "Approval", "Activity", "Task", "Document"] as const,
      stages: ["prospect", "qualified", "project-discovery", "marketing-scope", "offer", "negotiation", "won", "lost"] as const,
    },
    websiteWebDesign: {
      key: "website_web_design",
      model: "crm_pipelines",
      entities: ["Company", "Contact", "Lead", "Deal", "Pipeline", "Project", "WorkPackage", "Offer", "Approval", "Activity", "Task", "Document", "SupportCase"] as const,
      stages: ["prospect", "qualified", "discovery", "solution", "offer", "negotiation", "won", "lost"] as const,
    },
  },
  contracts: [
    contract("crm.records.read", "novalure-crm", "evelyn", "read", CRM_CANONICAL_ENTITIES, ["get", "list"]),
    contract("crm.records.write", "evelyn", "novalure-crm", "write", ["Contact", "Company", "Lead", "Deal", "Pipeline", "Project", "Offer"], ["create", "update"], [...requiredBoundaryTests, "idempotency", "resource-cas"]),
    contract("crm.events", "novalure-crm", "evelyn", "publish", ["Lead", "Deal", "Pipeline", "Activity", "Offer", "Project", "Approval"], ["publish", "replay"], [...requiredBoundaryTests, "event-idempotency", "ordering"]),
    contract("crm.tasks", "evelyn", "novalure-crm", "write", ["Task", "WorkPackage"], ["create", "update", "complete"], [...requiredBoundaryTests, "idempotency", "resource-cas"]),
    contract("crm.activities", "novalure-crm", "evelyn", "read", ["Activity", "Email", "Meeting", "Task"], ["get", "list"]),
    contract("crm.approvals", "evelyn", "novalure-crm", "write", ["Approval", "Offer", "Document"], ["request", "verify", "record"], [...requiredBoundaryTests, "approval-evidence", "resource-cas"]),
    contract("crm.documents", "novalure-crm", "evelyn", "read", ["Document", "Offer", "Project"], ["get", "list-metadata"]),
    contract("crm.customer-communication", "evelyn", "novalure-crm", "write", ["Email", "Activity", "Contact", "SupportCase"], ["prepare", "record"], [...requiredBoundaryTests, "consent-policy", "delivery-is-external"]),
    contract("crm.reporting", "novalure-crm", "evelyn", "read", ["Lead", "Deal", "Pipeline", "Activity", "Project"], ["aggregate", "snapshot"]),
    contract("crm.finance-references", "novalure-crm", "evelyn", "read", ["Deal", "Offer", "Project", "WorkPackage"], ["get-reference", "list-references"], [...requiredBoundaryTests, "no-payment-authority"]),
  ],
} as const satisfies CrmContractRegistry;

export class CrmContractCompatibilityError extends Error {
  constructor(public readonly code: "CRM_CONTRACT_UNKNOWN" | "CRM_CONTRACT_VERSION_UNSUPPORTED" | "CRM_CONTRACT_VERSION_ROLLBACK") {
    super(code);
    this.name = "CrmContractCompatibilityError";
  }
}

function versionParts(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left: string, right: string): number | null {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function assertCrmContractCompatibility(input: {
  contractId: string;
  schemaVersion: string;
  access: CrmContractAccess;
  storedSchemaVersion?: string | null;
}): CrmContractDefinition {
  const definition = CRM_CONTRACT_REGISTRY.contracts.find(item => item.id === input.contractId);
  if (!definition || definition.access !== input.access) throw new CrmContractCompatibilityError("CRM_CONTRACT_UNKNOWN");
  if (input.access === "write" && input.storedSchemaVersion) {
    const order = compareVersions(input.schemaVersion, input.storedSchemaVersion);
    if (order === null || order < 0) throw new CrmContractCompatibilityError("CRM_CONTRACT_VERSION_ROLLBACK");
    if (order > 0) throw new CrmContractCompatibilityError("CRM_CONTRACT_VERSION_UNSUPPORTED");
  }
  if (!(definition.compatibility.acceptedSchemaVersions as readonly string[]).includes(input.schemaVersion)) throw new CrmContractCompatibilityError("CRM_CONTRACT_VERSION_UNSUPPORTED");
  return definition;
}

export type CrmContractImpact = {
  level: "none" | "patch" | "minor" | "major";
  changes: readonly string[];
  requiredTests: readonly string[];
};

/** Detects review impact before a registry replacement is accepted. */
export function detectCrmContractImpact(previous: CrmContractRegistry, next: CrmContractRegistry): CrmContractImpact {
  const changes: string[] = [], tests = new Set<string>();
  let level: CrmContractImpact["level"] = "none";
  const elevate = (candidate: CrmContractImpact["level"]) => {
    const order = ["none", "patch", "minor", "major"] as const;
    if (order.indexOf(candidate) > order.indexOf(level)) level = candidate;
  };
  const oldContracts = new Map(previous.contracts.map(item => [item.id, item]));
  const newContracts = new Map(next.contracts.map(item => [item.id, item]));
  if (previous.schemaVersion !== next.schemaVersion || previous.wireVersion !== next.wireVersion || JSON.stringify(previous.compatibility) !== JSON.stringify(next.compatibility)) {
    changes.push("registry-compatibility-changed"); elevate("major");
  }
  for (const entity of CRM_CANONICAL_ENTITIES) if (JSON.stringify(previous.canonicalEntities[entity]) !== JSON.stringify(next.canonicalEntities[entity])) {
    changes.push(`entity-mapping-changed:${entity}`); elevate("major");
  }
  const oldPipelines = new Map(Object.values(previous.acquisitionPipelines).map(item => [item.key, item]));
  const newPipelines = new Map(Object.values(next.acquisitionPipelines).map(item => [item.key, item]));
  for (const [key, pipeline] of oldPipelines) {
    const replacement = newPipelines.get(key);
    if (!replacement) { changes.push(`pipeline-removed:${key}`); elevate("major"); continue; }
    if (pipeline.model !== replacement.model || pipeline.stages.some(stage => !replacement.stages.includes(stage)) || pipeline.entities.some(entity => !replacement.entities.includes(entity))) { changes.push(`pipeline-breaking-change:${key}`); elevate("major"); }
    else if (replacement.stages.some(stage => !pipeline.stages.includes(stage)) || replacement.entities.some(entity => !pipeline.entities.includes(entity))) { changes.push(`pipeline-addition:${key}`); elevate("minor"); }
  }
  for (const key of newPipelines.keys()) if (!oldPipelines.has(key)) { changes.push(`pipeline-added:${key}`); elevate("minor"); }
  for (const [id, oldContract] of oldContracts) {
    const replacement = newContracts.get(id);
    if (!replacement) { changes.push(`contract-removed:${id}`); elevate("major"); oldContract.requiredTests.forEach(test => tests.add(test)); continue; }
    const breakingFields = ["schemaVersion", "producer", "consumer", "access"] as const;
    for (const field of breakingFields) if (oldContract[field] !== replacement[field]) { changes.push(`${field}-changed:${id}`); elevate("major"); }
    for (const operation of oldContract.operations) if (!replacement.operations.includes(operation)) { changes.push(`operation-removed:${id}:${operation}`); elevate("major"); }
    for (const entity of oldContract.entities) if (!replacement.entities.includes(entity)) { changes.push(`entity-removed:${id}:${entity}`); elevate("major"); }
    for (const operation of replacement.operations) if (!oldContract.operations.includes(operation)) { changes.push(`operation-added:${id}:${operation}`); elevate("minor"); }
    for (const entity of replacement.entities) if (!oldContract.entities.includes(entity)) { changes.push(`entity-added:${id}:${entity}`); elevate("minor"); }
    if (JSON.stringify(oldContract.compatibility) !== JSON.stringify(replacement.compatibility)) { changes.push(`compatibility-changed:${id}`); elevate("major"); }
    if (oldContract.changeOwner !== replacement.changeOwner) { changes.push(`owner-changed:${id}`); elevate("patch"); }
    for (const requiredTest of oldContract.requiredTests) if (!replacement.requiredTests.includes(requiredTest)) { changes.push(`required-test-removed:${id}:${requiredTest}`); elevate("major"); }
    for (const requiredTest of replacement.requiredTests) if (!oldContract.requiredTests.includes(requiredTest)) { changes.push(`required-test-added:${id}:${requiredTest}`); elevate("patch"); }
    if (changes.some(change => change.includes(`:${id}`))) replacement.requiredTests.forEach(test => tests.add(test));
  }
  for (const [id, added] of newContracts) if (!oldContracts.has(id)) { changes.push(`contract-added:${id}`); elevate("minor"); added.requiredTests.forEach(test => tests.add(test)); }
  return { level, changes, requiredTests: [...tests].sort() };
}

export class CrmContractRegistryChangeError extends Error {
  constructor(public readonly impact: CrmContractImpact) {
    super("CRM_REGISTRY_VERSION_INVALID");
    this.name = "CrmContractRegistryChangeError";
  }
}

/** Requires a registry version bump at least as large as the detected change. */
export function assertCrmContractRegistryChange(previous: CrmContractRegistry, next: CrmContractRegistry): CrmContractImpact {
  const impact = detectCrmContractImpact(previous, next);
  if (impact.level === "none") return impact;
  const oldVersion = versionParts(previous.registryVersion), newVersion = versionParts(next.registryVersion);
  if (!oldVersion || !newVersion) throw new CrmContractRegistryChangeError(impact);
  const [oldMajor, oldMinor, oldPatch] = oldVersion, [newMajor, newMinor, newPatch] = newVersion;
  const valid = impact.level === "major" ? newMajor > oldMajor
    : impact.level === "minor" ? newMajor > oldMajor || (newMajor === oldMajor && newMinor > oldMinor)
      : newMajor > oldMajor || (newMajor === oldMajor && (newMinor > oldMinor || (newMinor === oldMinor && newPatch > oldPatch)));
  if (!valid) throw new CrmContractRegistryChangeError(impact);
  return impact;
}

export function validateCrmContractRegistry(registry: CrmContractRegistry = CRM_CONTRACT_REGISTRY): readonly string[] {
  const errors: string[] = [], ids = new Set<string>();
  if (!versionParts(registry.registryVersion) || !versionParts(registry.schemaVersion)) errors.push("invalid-registry-version");
  for (const definition of registry.contracts) {
    if (ids.has(definition.id)) errors.push(`duplicate-contract:${definition.id}`);
    ids.add(definition.id);
    if (!definition.schemaVersion || !definition.producer || !definition.consumer || !definition.changeOwner) errors.push(`incomplete-contract:${definition.id}`);
    if (!definition.requiredTests.length) errors.push(`missing-tests:${definition.id}`);
    if (!definition.compatibility.acceptedSchemaVersions.includes(definition.schemaVersion)) errors.push(`active-version-not-accepted:${definition.id}`);
  }
  for (const entity of CRM_CANONICAL_ENTITIES) if (!(entity in registry.canonicalEntities)) errors.push(`missing-entity:${entity}`);
  return errors;
}
