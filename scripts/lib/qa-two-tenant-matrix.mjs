import { createHash } from "node:crypto";

export const QA_WRITE_CONFIRMATION = "RUN_TWO_TENANT_QA";
export const QA_CLEANUP_CONFIRMATION = "RESET_TWO_TENANT_QA";

export const qaRequiredMigrationVersions = Object.freeze([
  "057_bot_webhook_legacy_index_cutover",
  "068_qa_batch_reset_safety",
  "069_property_unit_idempotency",
  "070_funnel_submission_idempotency_recovery",
  "071_forms_owner_tenant_guard",
  "072_form_submission_atomicity",
  "073_launch_tenant_relation_guards",
  "074_validate_launch_tenant_relation_guards",
  "075_public_funnel_visit_truth",
  "076_bot_webhook_durable_processing",
  "077_schema_ledger_runtime_projection",
]);

export const qaTenantConstraintNames = Object.freeze([
  "funnels_workspace_project_fk", "funnels_workspace_owner_fk",
  "funnel_steps_workspace_project_fk", "funnel_steps_workspace_funnel_fk", "funnel_steps_workspace_bot_fk",
  "property_inquiries_workspace_project_fk", "property_inquiries_workspace_property_fk",
  "property_inquiries_workspace_unit_fk", "property_inquiries_workspace_contact_fk",
  "property_inquiries_workspace_lead_fk", "property_inquiries_workspace_funnel_fk",
  "property_inquiries_workspace_form_fk", "property_inquiries_workspace_owner_fk",
  "property_activity_events_workspace_project_fk", "property_activity_events_workspace_property_fk",
  "property_activity_events_workspace_unit_fk", "property_activity_events_workspace_contact_fk",
  "property_activity_events_workspace_lead_fk", "property_activity_events_workspace_actor_fk",
]);

export const qaTenantRelationNames = Object.freeze([
  "funnels.project", "funnels.owner",
  "funnel_steps.project", "funnel_steps.funnel", "funnel_steps.bot",
  "property_inquiries.project", "property_inquiries.property", "property_inquiries.unit",
  "property_inquiries.contact", "property_inquiries.lead", "property_inquiries.funnel",
  "property_inquiries.form", "property_inquiries.owner",
  "property_activity.project", "property_activity.property", "property_activity.unit",
  "property_activity.contact", "property_activity.lead", "property_activity.actor",
]);

export const qaLaunchSchemaArtifactNames = Object.freeze([
  "075.table.public_funnel_visit_events",
  "075.constraint.scope_unique",
  "075.constraint.funnel_fk",
  "075.constraints.checks",
  "075.index.expiry",
  "075.grants.tenant_app",
  "075.grants.public_none",
  "076.columns.webhook_state",
  "076.constraints.webhook_state",
  "076.index.webhook_workspace_unique",
  "076.index.webhook_account_event",
  "076.index.webhook_legacy_absent",
  "076.index.webhook_reclaim",
  "076.index.webhook_account_received",
  "076.table.webhook_envelopes",
  "076.rpc.webhook_envelope_quarantine",
  "076.grants.webhook_envelope_quarantine",
  "076.columns.event_ids",
  "076.indexes.event_unique",
  "076.constraints.event_fks",
  "076.audit.snapshot_without_fk",
]);

const migrationChecksumPattern = /^[a-f0-9]{64}$/iu;

export function evaluateQaTenantRelationGate(input = {}) {
  const migrations = Array.isArray(input.migrations) ? input.migrations : [];
  const migrationByVersion = new Map(migrations.map((migration) => [migration?.version, migration]));
  const expectedMigrationChecksums = input.expectedMigrationChecksums ?? {};
  const missingMigrations = qaRequiredMigrationVersions.filter((version) => !migrationByVersion.has(version));
  const invalidExpectedChecksums = qaRequiredMigrationVersions.filter(
    (version) => !migrationChecksumPattern.test(String(expectedMigrationChecksums[version] ?? "")),
  );
  const mismatchedMigrations = qaRequiredMigrationVersions.filter((version) => {
    const migration = migrationByVersion.get(version);
    const expectedChecksum = String(expectedMigrationChecksums[version] ?? "");
    return migration
      && migrationChecksumPattern.test(expectedChecksum)
      && String(migration.checksum ?? "").toLowerCase() !== expectedChecksum.toLowerCase();
  });

  const schemaArtifacts = Array.isArray(input.schemaArtifacts) ? input.schemaArtifacts : [];
  const schemaArtifactByName = new Map(schemaArtifacts.map((artifact) => [artifact?.artifact, artifact?.ok === true]));
  const missingSchemaArtifactChecks = qaLaunchSchemaArtifactNames.filter(
    (artifact) => !schemaArtifactByName.has(artifact),
  );
  const invalidSchemaArtifacts = qaLaunchSchemaArtifactNames.filter(
    (artifact) => schemaArtifactByName.has(artifact) && schemaArtifactByName.get(artifact) !== true,
  );

  const constraintState = input.constraintState ?? {};
  const expectedConstraintCount = qaTenantConstraintNames.length;
  const constraintsPresent = Number(constraintState.found ?? -1) === expectedConstraintCount;
  const constraintsValidated = Number(constraintState.validated ?? -1) === expectedConstraintCount;
  const constraintsDeferrable = Number(constraintState.deferrable ?? -1) === expectedConstraintCount
    && Number(constraintState.initiallyDeferred ?? -1) === expectedConstraintCount;

  const violations = Array.isArray(input.violations) ? input.violations : [];
  const violationByRelation = new Map(violations.map((entry) => [entry?.relation, Number(entry?.violations ?? Number.NaN)]));
  const missingRelationChecks = qaTenantRelationNames.filter((relation) => !violationByRelation.has(relation));
  const violatingRelations = qaTenantRelationNames.filter((relation) => {
    const count = violationByRelation.get(relation);
    return count !== undefined && (!Number.isSafeInteger(count) || count !== 0);
  });

  const errors = [
    ...missingMigrations.map((version) => `missing_migration:${version}`),
    ...invalidExpectedChecksums.map((version) => `invalid_expected_migration_checksum:${version}`),
    ...mismatchedMigrations.map((version) => `migration_checksum_mismatch:${version}`),
    ...missingSchemaArtifactChecks.map((artifact) => `missing_schema_artifact_check:${artifact}`),
    ...invalidSchemaArtifacts.map((artifact) => `invalid_schema_artifact:${artifact}`),
    ...(!constraintsPresent ? ["tenant_constraints_missing"] : []),
    ...(!constraintsValidated ? ["tenant_constraints_unvalidated"] : []),
    ...(!constraintsDeferrable ? ["tenant_constraints_not_deferred"] : []),
    ...missingRelationChecks.map((relation) => `missing_relation_check:${relation}`),
    ...violatingRelations.map((relation) => `tenant_relation_violation:${relation}`),
  ];

  return Object.freeze({
    constraintsDeferrable,
    constraintsPresent,
    constraintsValidated,
    errors: Object.freeze(errors),
    migrationsChecksummed:
      invalidExpectedChecksums.length === 0
      && mismatchedMigrations.length === 0
      && missingMigrations.length === 0,
    migrationsPresent: missingMigrations.length === 0,
    ok: errors.length === 0,
    relationChecksPresent: missingRelationChecks.length === 0,
    relationViolationsZero: violatingRelations.length === 0 && missingRelationChecks.length === 0,
    schemaArtifactsValid: missingSchemaArtifactChecks.length === 0 && invalidSchemaArtifacts.length === 0,
    violationTotal: qaTenantRelationNames.reduce((sum, relation) => {
      const count = violationByRelation.get(relation);
      return sum + (Number.isFinite(count) ? count : 0);
    }, 0),
  });
}

export const qaActors = Object.freeze({
  owner: Object.freeze({ appRole: "owner", productRoles: ["customer_owner"] }),
  admin: Object.freeze({ appRole: "admin", productRoles: ["workspace_admin"] }),
  member: Object.freeze({ appRole: "agent", productRoles: ["team_member"] }),
  customer: Object.freeze({ appRole: "assistant", productRoles: ["viewer", "external_partner"] }),
});

export const qaCrudMatrix = Object.freeze([
  Object.freeze({ actor: "owner", create: 200, read: 200, update: 200, delete: 200 }),
  Object.freeze({ actor: "admin", create: 200, read: 200, update: 200, delete: 200 }),
  Object.freeze({ actor: "member", create: 200, read: 200, update: 200, delete: 403 }),
  Object.freeze({ actor: "customer", create: 403, read: 200, update: 403, delete: 403 }),
  Object.freeze({ actor: "public", create: 401, read: 401, update: 401, delete: 401 }),
]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const batchMarkerPattern = /^QA-TEST-[0-9]{8}-[0-9]{4}-[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/;
const runPrefixPattern = /^GOLIVETEST_[A-Za-z0-9_-]{6,80}$/;
const shaPattern = /^[a-f0-9]{40}$/i;
const secretKeyPattern = /(password|passcode|secret|token|cookie|authorization|database.?url)/i;

function required(env, name, missing) {
  const value = env[name]?.trim();
  if (!value) missing.push(name);
  return value ?? "";
}

function optional(env, name) {
  return env[name]?.trim() ?? "";
}

function expectUuid(value, name, errors) {
  if (value && !uuidPattern.test(value)) errors.push(`${name} must be a UUID.`);
  return value.toLowerCase();
}

function expectEmail(value, name, errors) {
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${name} must be an email address.`);
  return value.toLowerCase();
}

function expectTotp(value, name, errors) {
  const normalized = value.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/g, "");
  if (normalized && !/^[A-Z2-7]{16,128}$/.test(normalized)) {
    errors.push(`${name} must be a base32 TOTP secret.`);
  }
  return normalized;
}

function expectPublicPath(value, name, errors) {
  if (value && (!value.startsWith("/") || value.startsWith("//") || /[\r\n]/.test(value))) {
    errors.push(`${name} must be a same-origin absolute path.`);
  }
  if (/^\/api(?:\/|$)/i.test(value)) errors.push(`${name} must reference a rendered public page, not an API route.`);
  return value;
}

function parseOrigin(value, name, errors, { allowLocal = false } = {}) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      errors.push(`${name} must contain only an origin.`);
    }
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(allowLocal && local && url.protocol === "http:")) {
      errors.push(`${name} must use HTTPS (HTTP is allowed only for explicitly enabled localhost).`);
    }
    return url.origin;
  } catch {
    errors.push(`${name} must be a valid URL origin.`);
    return "";
  }
}

function parseActor(env, tenantPrefix, actorName, sharedPassword, missing, errors) {
  const actorPrefix = `${tenantPrefix}_${actorName.toUpperCase()}`;
  const productRoleName = `${actorPrefix}_PRODUCT_ROLE`;
  const expected = qaActors[actorName];
  const productRole = optional(env, productRoleName) || expected.productRoles[0];
  if (!expected.productRoles.includes(productRole)) {
    errors.push(`${productRoleName} must be one of: ${expected.productRoles.join(", ")}.`);
  }

  const password = optional(env, `${actorPrefix}_PASSWORD`) || sharedPassword;
  if (!password) missing.push(`${actorPrefix}_PASSWORD (or NOVALURE_QA_PASSWORD)`);

  return Object.freeze({
    appRole: expected.appRole,
    email: expectEmail(required(env, `${actorPrefix}_EMAIL`, missing), `${actorPrefix}_EMAIL`, errors),
    name: actorName,
    password,
    productRole,
    totpSecret: expectTotp(required(env, `${actorPrefix}_TOTP_SECRET`, missing), `${actorPrefix}_TOTP_SECRET`, errors),
    userId: expectUuid(required(env, `${actorPrefix}_USER_ID`, missing), `${actorPrefix}_USER_ID`, errors),
  });
}

function parseTenant(env, key, sharedPassword, missing, errors) {
  const prefix = `NOVALURE_QA_TENANT_${key}`;
  const actors = Object.fromEntries(
    Object.keys(qaActors).map((actorName) => [
      actorName,
      parseActor(env, prefix, actorName, sharedPassword, missing, errors),
    ]),
  );

  return Object.freeze({
    actors: Object.freeze(actors),
    batchId: expectUuid(required(env, `${prefix}_BATCH_ID`, missing), `${prefix}_BATCH_ID`, errors),
    batchMarker: required(env, `${prefix}_BATCH_MARKER`, missing),
    key,
    projectId: expectUuid(required(env, `${prefix}_PROJECT_ID`, missing), `${prefix}_PROJECT_ID`, errors),
    publicPath: expectPublicPath(required(env, `${prefix}_PUBLIC_PATH`, missing), `${prefix}_PUBLIC_PATH`, errors),
    resetActorUserId: expectUuid(
      required(env, `${prefix}_RESET_ACTOR_USER_ID`, missing),
      `${prefix}_RESET_ACTOR_USER_ID`,
      errors,
    ),
    workspaceId: expectUuid(required(env, `${prefix}_WORKSPACE_ID`, missing), `${prefix}_WORKSPACE_ID`, errors),
  });
}

function validateDatabaseTarget(database, productionHost, errors) {
  if (!database.url) return;
  try {
    const url = new URL(database.url);
    if (!/^postgres(?:ql)?:$/.test(url.protocol)) errors.push("NOVALURE_QA_DATABASE_URL must be a PostgreSQL URL.");
    if (url.hostname.toLowerCase() !== database.host.toLowerCase()) {
      errors.push("NOVALURE_QA_DATABASE_URL host must match NOVALURE_QA_DATABASE_HOST.");
    }
    if (!url.hostname.toLowerCase().includes("-pooler.")) {
      errors.push("NOVALURE_QA_DATABASE_URL must use the pooled Neon endpoint.");
    }
    if (url.pathname.replace(/^\//, "") !== database.databaseName) {
      errors.push("NOVALURE_QA_DATABASE_URL database must match NOVALURE_QA_DATABASE_NAME.");
    }
    if (decodeURIComponent(url.username) !== database.role) {
      errors.push("NOVALURE_QA_DATABASE_URL role must match NOVALURE_QA_DATABASE_ROLE.");
    }
    if (productionHost && url.hostname.toLowerCase() === productionHost.toLowerCase()) {
      errors.push("QA database host must not equal NOVALURE_PRODUCTION_DATABASE_HOST.");
    }
  } catch {
    errors.push("NOVALURE_QA_DATABASE_URL must be a valid URL.");
  }
}

export function parseQaTwoTenantConfig(env = process.env, options = {}) {
  const missing = [];
  const errors = [];
  const allowLocal = optional(env, "NOVALURE_QA_ALLOW_LOCAL") === "1";
  const sharedPassword = optional(env, "NOVALURE_QA_PASSWORD");
  const baseUrl = parseOrigin(
    required(env, "NOVALURE_QA_BASE_URL", missing),
    "NOVALURE_QA_BASE_URL",
    errors,
    { allowLocal },
  );
  const productionOrigin = parseOrigin(
    required(env, "NOVALURE_PRODUCTION_ORIGIN", missing),
    "NOVALURE_PRODUCTION_ORIGIN",
    errors,
  );
  if (baseUrl && productionOrigin && baseUrl === productionOrigin) {
    errors.push("NOVALURE_QA_BASE_URL must not equal NOVALURE_PRODUCTION_ORIGIN.");
  }

  const runPrefix = required(env, "NOVALURE_QA_RUN_PREFIX", missing);
  if (runPrefix && !runPrefixPattern.test(runPrefix)) {
    errors.push("NOVALURE_QA_RUN_PREFIX must be a unique GOLIVETEST_ identifier.");
  }

  const expectedGitSha = required(env, "NOVALURE_QA_EXPECTED_GIT_SHA", missing);
  if (expectedGitSha && !shaPattern.test(expectedGitSha)) {
    errors.push("NOVALURE_QA_EXPECTED_GIT_SHA must be a 40-character commit SHA.");
  }

  const tenants = [
    parseTenant(env, "A", sharedPassword, missing, errors),
    parseTenant(env, "B", sharedPassword, missing, errors),
  ];

  const database = Object.freeze({
    branchId: required(env, "NOVALURE_QA_BRANCH_ID", missing),
    databaseName: required(env, "NOVALURE_QA_DATABASE_NAME", missing),
    host: required(env, "NOVALURE_QA_DATABASE_HOST", missing),
    projectId: required(env, "NOVALURE_QA_PROJECT_ID", missing),
    role: required(env, "NOVALURE_QA_DATABASE_ROLE", missing),
    url: required(env, "NOVALURE_QA_DATABASE_URL", missing),
  });
  const productionDatabaseHost = required(env, "NOVALURE_PRODUCTION_DATABASE_HOST", missing);
  validateDatabaseTarget(database, productionDatabaseHost, errors);

  for (const tenant of tenants) {
    if (tenant.batchMarker && !batchMarkerPattern.test(tenant.batchMarker)) {
      errors.push(`NOVALURE_QA_TENANT_${tenant.key}_BATCH_MARKER does not match QA-TEST-YYYYMMDD-HHmm-short-id.`);
    }
  }

  const resetAdminPassword = optional(env, "NOVALURE_QA_RESET_ADMIN_PASSWORD") || sharedPassword;
  if (!resetAdminPassword) missing.push("NOVALURE_QA_RESET_ADMIN_PASSWORD (or NOVALURE_QA_PASSWORD)");
  const resetAdmin = Object.freeze({
    appRole: "owner",
    email: expectEmail(
      required(env, "NOVALURE_QA_RESET_ADMIN_EMAIL", missing),
      "NOVALURE_QA_RESET_ADMIN_EMAIL",
      errors,
    ),
    password: resetAdminPassword,
    productRole: "platform_admin",
    totpSecret: expectTotp(
      required(env, "NOVALURE_QA_RESET_ADMIN_TOTP_SECRET", missing),
      "NOVALURE_QA_RESET_ADMIN_TOTP_SECRET",
      errors,
    ),
  });

  if (options.requireExecution) {
    if (optional(env, "NOVALURE_QA_E2E_WRITE_CONFIRM") !== QA_WRITE_CONFIRMATION) {
      errors.push(`NOVALURE_QA_E2E_WRITE_CONFIRM must equal ${QA_WRITE_CONFIRMATION}.`);
    }
    if (optional(env, "NOVALURE_QA_E2E_CLEANUP_CONFIRM") !== QA_CLEANUP_CONFIRMATION) {
      errors.push(`NOVALURE_QA_E2E_CLEANUP_CONFIRM must equal ${QA_CLEANUP_CONFIRMATION}.`);
    }
  }

  const allWorkspaceIds = tenants.map((tenant) => tenant.workspaceId).filter(Boolean);
  if (new Set(allWorkspaceIds).size !== allWorkspaceIds.length) errors.push("Tenant workspace IDs must be distinct.");
  const allProjectIds = tenants.map((tenant) => tenant.projectId).filter(Boolean);
  if (new Set(allProjectIds).size !== allProjectIds.length) errors.push("Tenant project IDs must be distinct.");
  const allBatchIds = tenants.map((tenant) => tenant.batchId).filter(Boolean);
  if (new Set(allBatchIds).size !== allBatchIds.length) errors.push("Tenant batch IDs must be distinct.");
  const allMarkers = tenants.map((tenant) => tenant.batchMarker).filter(Boolean);
  if (new Set(allMarkers).size !== allMarkers.length) errors.push("Tenant batch markers must be distinct.");
  const allPublicPaths = tenants.map((tenant) => tenant.publicPath).filter(Boolean);
  if (new Set(allPublicPaths).size !== allPublicPaths.length) errors.push("Tenant public paths must be distinct.");

  const allEmails = tenants.flatMap((tenant) => Object.values(tenant.actors).map((actor) => actor.email)).filter(Boolean);
  if (new Set(allEmails).size !== allEmails.length) {
    errors.push("The eight tenant role accounts must use distinct email addresses.");
  }
  if (allEmails.includes(resetAdmin.email)) errors.push("Reset admin email must be separate from tenant role fixtures.");

  const everyUserId = tenants.flatMap((tenant) => [
    tenant.resetActorUserId,
    ...Object.values(tenant.actors).map((actor) => actor.userId),
  ]).filter(Boolean);
  if (new Set(everyUserId).size !== everyUserId.length) {
    errors.push("All tenant fixture and reset-actor user IDs must be globally distinct.");
  }

  for (const tenant of tenants) {
    const actorIds = Object.values(tenant.actors).map((actor) => actor.userId).filter(Boolean);
    if (new Set(actorIds).size !== actorIds.length) {
      errors.push(`Tenant ${tenant.key} role user IDs must be distinct.`);
    }
    if (actorIds.includes(tenant.resetActorUserId)) {
      errors.push(`Tenant ${tenant.key} reset actor must be separate from customer-role fixtures.`);
    }
  }

  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length || errors.length) {
    const details = [
      ...(uniqueMissing.length ? [`Missing environment variables: ${uniqueMissing.join(", ")}`] : []),
      ...errors,
    ];
    throw new Error(details.join("\n"));
  }

  return Object.freeze({
    allowLocal,
    baseUrl,
    database,
    evidenceDirectory: optional(env, "NOVALURE_QA_EVIDENCE_DIR") || `artifacts/qa/${runPrefix.toLowerCase()}`,
    expectedGitSha: expectedGitSha.toLowerCase(),
    productionOrigin,
    resetAdmin,
    runPrefix,
    tenants: Object.freeze(tenants),
  });
}

export function qaTwoTenantRequiredEnvironment() {
  const names = [
    "NOVALURE_QA_BASE_URL",
    "NOVALURE_PRODUCTION_ORIGIN",
    "NOVALURE_QA_EXPECTED_GIT_SHA",
    "NOVALURE_QA_DATABASE_URL",
    "NOVALURE_QA_DATABASE_HOST",
    "NOVALURE_QA_PROJECT_ID",
    "NOVALURE_QA_BRANCH_ID",
    "NOVALURE_QA_DATABASE_NAME",
    "NOVALURE_QA_DATABASE_ROLE",
    "NOVALURE_PRODUCTION_DATABASE_HOST",
    "NOVALURE_QA_RUN_PREFIX",
    "NOVALURE_QA_RESET_ADMIN_EMAIL",
    "NOVALURE_QA_RESET_ADMIN_PASSWORD",
    "NOVALURE_QA_RESET_ADMIN_TOTP_SECRET",
    "NOVALURE_QA_E2E_WRITE_CONFIRM",
    "NOVALURE_QA_E2E_CLEANUP_CONFIRM",
  ];
  for (const key of ["A", "B"]) {
    const prefix = `NOVALURE_QA_TENANT_${key}`;
    names.push(
      `${prefix}_WORKSPACE_ID`,
      `${prefix}_PROJECT_ID`,
      `${prefix}_PUBLIC_PATH`,
      `${prefix}_BATCH_ID`,
      `${prefix}_BATCH_MARKER`,
      `${prefix}_RESET_ACTOR_USER_ID`,
    );
    for (const actorName of Object.keys(qaActors)) {
      const actorPrefix = `${prefix}_${actorName.toUpperCase()}`;
      names.push(
        `${actorPrefix}_EMAIL`,
        `${actorPrefix}_PASSWORD`,
        `${actorPrefix}_TOTP_SECRET`,
        `${actorPrefix}_USER_ID`,
      );
    }
  }
  return names;
}

export function buildQaTwoTenantScenarioMatrix() {
  const scenarios = [];
  for (const tenant of ["A", "B"]) {
    for (const row of qaCrudMatrix) {
      for (const operation of ["create", "read", "update", "delete"]) {
        scenarios.push(Object.freeze({
          actor: row.actor,
          expectedStatus: row[operation],
          id: `${tenant.toLowerCase()}.contact.${row.actor}.${operation}`,
          operation,
          tenant,
        }));
      }
    }
    for (const actor of ["owner", "admin", "member", "customer"]) {
      scenarios.push(Object.freeze({ actor, expectedStatus: 403, id: `${tenant.toLowerCase()}.cross_tenant.${actor}.read`, tenant }));
      scenarios.push(Object.freeze({ actor, expectedStatus: [403, 404], id: `${tenant.toLowerCase()}.cross_tenant.${actor}.update`, tenant }));
    }
    scenarios.push(Object.freeze({ actor: "owner", expectedStatus: 200, id: `${tenant.toLowerCase()}.persistence.relogin`, tenant }));
    scenarios.push(Object.freeze({ actor: "owner", expectedStatus: 200, id: `${tenant.toLowerCase()}.deal.idempotency`, tenant }));
    scenarios.push(Object.freeze({ actor: "owner", expectedStatus: 200, id: `${tenant.toLowerCase()}.deal.concurrency`, tenant }));
    scenarios.push(Object.freeze({ actor: "public", expectedStatus: 200, id: `${tenant.toLowerCase()}.public.page`, tenant }));
    scenarios.push(Object.freeze({ actor: "resetAdmin", expectedStatus: 200, id: `${tenant.toLowerCase()}.cleanup.dry_run`, tenant }));
    scenarios.push(Object.freeze({ actor: "resetAdmin", expectedStatus: 200, id: `${tenant.toLowerCase()}.cleanup.execute`, tenant }));
    scenarios.push(Object.freeze({ actor: "resetAdmin", expectedStatus: 0, id: `${tenant.toLowerCase()}.cleanup.remaining_rows`, tenant }));
  }
  return scenarios;
}

export function fingerprint(value, length = 16) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, length)}`;
}

export function assertEvidenceContainsNoSecrets(value, path = "evidence") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (secretKeyPattern.test(key)) throw new Error(`Secret-shaped evidence key is forbidden: ${childPath}`);
    if (child && typeof child === "object") assertEvidenceContainsNoSecrets(child, childPath);
  }
}

export function canonicalJson(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}
