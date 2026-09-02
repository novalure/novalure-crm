import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  intentionalUnvalidatedRecoveryConstraints,
  recoveryBaselineMigrationPlan,
  recoveryDatabaseQueryPack,
  recoveryEvidenceTableNames,
  recoveryExpectedDatabaseName,
  recoveryExpectedMigrationRoleName,
  recoveryExpectedProductionBranchId,
  recoveryExpectedProjectId,
  recoveryQueryPackSha256,
  recoveryQueryPackVersion,
  recoveryTableQuerySpecs,
  recoveryTransformationTableNames,
} from "./database-recovery-query-pack.mjs";
import {
  recoveryMigrationPlan,
  recoveryMigrationPlanContract,
} from "./recovery-migration-plan.mjs";

export { recoveryEvidenceTableNames } from "./database-recovery-query-pack.mjs";

export const excludedRecoveryMigrations = Object.freeze([]);
export const recoveryEvidenceMigrationVersions = recoveryMigrationPlan;
export const intentionalUnvalidatedPilotConstraints = intentionalUnvalidatedRecoveryConstraints;

const maximumInventoryEntries = 20_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const migrationVersionPattern = /^\d{3}_[a-z0-9_]+$/u;
const ledgerVersionPattern = /^\d{3}(?:_[a-z0-9_]+)?$/u;
const branchIdPattern = /^br-[A-Za-z0-9-]{8,128}$/u;
const endpointIdPattern = /^ep-[A-Za-z0-9-]{8,128}$/u;
const receiptIdPattern = /^rcpt_[a-f0-9]{32,64}$/u;
const requestIdPattern = /^req_[A-Za-z0-9_-]{12,156}$/u;
const observerIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{7,255}$/u;
const observerKeyIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{7,159}$/u;
const signatureBase64Pattern = /^[A-Za-z0-9+/]{86}==$/u;
const safeNamePattern = /^[A-Za-z_][A-Za-z0-9_.:$() ,-]{0,511}$/u;
const emptyRowsSha256 = createHash("sha256").update("").digest("hex");
const tableSpecByName = new Map(recoveryTableQuerySpecs.map((spec) => [spec.name, spec]));
const recoveryObservationStatementType = "NOVALURE_NEON_RECOVERY_OBSERVATION_V1";
const recoveryObservationProvider = "NEON";
const recoveryObservationService = "NEON_CONTROL_PLANE_AND_SQL";
const maximumObservationWindowMilliseconds = 24 * 60 * 60 * 1_000;
const maximumEvidenceFinalizationLagMilliseconds = 60 * 60 * 1_000;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function isPlainObject(value) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype,
  );
}

function assertExactKeys(value, expectedKeys, code) {
  invariant(isPlainObject(value), `${code}_OBJECT_REQUIRED`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  invariant(
    actual.length === expected.length
      && actual.every((key, index) => key === expected[index]),
    `${code}_KEYS_INVALID`,
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  invariant(
    value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean",
    "RECOVERY_EVIDENCE_NON_JSON_VALUE",
  );
  invariant(typeof value !== "number" || Number.isFinite(value), "RECOVERY_EVIDENCE_NUMBER_INVALID");
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildTableContentFingerprint(rows) {
  invariant(Array.isArray(rows), "RECOVERY_TABLE_ROWS_ARRAY_REQUIRED");
  const canonicalRows = rows.map((row) => JSON.stringify(canonicalize(row))).sort();
  return Object.freeze({
    contentSha256: sha256(`${canonicalRows.join("\n")}${canonicalRows.length ? "\n" : ""}`),
    rowCount: canonicalRows.length,
  });
}

function scanForSecretMaterial(value) {
  const source = typeof value === "string" ? value : canonicalJson(value);
  for (const forbidden of [
    /postgres(?:ql)?:\/\/[^\s"'<>]+/iu,
    /https?:\/\/[^\s"'<>]+/iu,
    /_vercel_share=/iu,
    /vercel_blob_rw_/iu,
    /(?:^|[^a-z0-9])(?:sk|pk)_(?:live|test)_[a-z0-9_-]{12,}/iu,
    /(?:^|[^a-z0-9])(?:github_pat_|gh[pousr]_)[a-z0-9_]{12,}/iu,
    /(?:^|[^a-z0-9])(?:napi_|vercel_|xox[baprs]-)[a-z0-9_-]{12,}/iu,
    /(?:^|[^a-z0-9])(?:re_|pat-(?:na1|eu1)-|ya29\.|SG\.)[a-z0-9._-]{16,}/iu,
    /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{30,}(?:$|[^A-Za-z0-9_-])/u,
    /(?:^|[^A-Za-z0-9])SK[a-f0-9]{32}(?:$|[^A-Za-z0-9])/iu,
    /(?:^|[^A-Z0-9])AKIA[A-Z0-9]{16}(?:$|[^A-Z0-9])/u,
    /(?:bearer\s+)[A-Za-z0-9._~+\/-]{12,}/iu,
    /(?:password|passwd|secret|cookie|authorization|connectionString)\s*[":=]/iu,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
    /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/u,
  ]) {
    invariant(!forbidden.test(source), "RECOVERY_EVIDENCE_SECRET_PATTERN_DETECTED");
  }
}

function requireSafeText(value, code, { maximumLength = 512, pattern = safeNamePattern } = {}) {
  invariant(
    typeof value === "string"
      && value.length > 0
      && value.length <= maximumLength
      && !/[\u0000-\u001f\u007f]/u.test(value)
      && pattern.test(value),
    code,
  );
  return value;
}

function requireIsoTimestamp(value, code) {
  invariant(typeof value === "string" && value.length <= 64, code);
  const epoch = Date.parse(value);
  invariant(Number.isFinite(epoch) && new Date(epoch).toISOString() === value, code);
  return { epoch, value };
}

function normalizeLedger(value, code) {
  invariant(Array.isArray(value) && value.length <= 512, `${code}_ARRAY_INVALID`);
  const rows = value.map((row) => {
    assertExactKeys(row, ["checksum", "version"], `${code}_ROW`);
    invariant(ledgerVersionPattern.test(row.version), `${code}_VERSION_INVALID`);
    invariant(sha256Pattern.test(row.checksum), `${code}_CHECKSUM_INVALID`);
    return { checksum: row.checksum, version: row.version };
  }).sort((left, right) => left.version.localeCompare(right.version));
  invariant(
    rows.every((row, index) => index === 0 || row.version !== rows[index - 1].version),
    `${code}_DUPLICATE_VERSION`,
  );
  return rows;
}

function normalizeTables(value, code) {
  assertExactKeys(value, recoveryEvidenceTableNames, code);
  return Object.fromEntries(recoveryEvidenceTableNames.map((table) => {
    const entry = value[table];
    const spec = tableSpecByName.get(table);
    assertExactKeys(
      entry,
      ["contentSha256", "projectionId", "queryPackSha256", "rowCount", "state"],
      `${code}_${table}`,
    );
    invariant(entry.projectionId === spec?.projectionId, `${code}_${table}_PROJECTION_ID_INVALID`);
    invariant(entry.queryPackSha256 === recoveryQueryPackSha256, `${code}_${table}_QUERY_PACK_INVALID`);
    invariant(entry.state === "PRESENT" || entry.state === "ABSENT", `${code}_${table}_STATE_INVALID`);
    if (entry.state === "PRESENT") {
      invariant(Number.isSafeInteger(entry.rowCount) && entry.rowCount >= 0, `${code}_${table}_ROW_COUNT_INVALID`);
      invariant(sha256Pattern.test(entry.contentSha256), `${code}_${table}_CONTENT_DIGEST_INVALID`);
    } else {
      invariant(entry.rowCount === null, `${code}_${table}_ABSENT_ROW_COUNT_INVALID`);
      invariant(entry.contentSha256 === null, `${code}_${table}_ABSENT_DIGEST_INVALID`);
    }
    return [table, { ...entry }];
  }));
}

function normalizeCatalogInventory(value, code) {
  invariant(Array.isArray(value) && value.length <= maximumInventoryEntries, `${code}_ARRAY_INVALID`);
  const entries = value.map((entry) => {
    assertExactKeys(
      entry,
      ["definitionSha256", "identity", "kind", "name", "schema"],
      `${code}_ENTRY`,
    );
    requireSafeText(entry.kind, `${code}_KIND_INVALID`, {
      maximumLength: 32,
      pattern: /^[a-z][a-z_]{0,31}$/u,
    });
    requireSafeText(entry.schema, `${code}_SCHEMA_INVALID`, {
      maximumLength: 63,
      pattern: /^[a-z_][a-z0-9_]{0,62}$/u,
    });
    requireSafeText(entry.name, `${code}_NAME_INVALID`);
    requireSafeText(entry.identity, `${code}_IDENTITY_INVALID`);
    invariant(sha256Pattern.test(entry.definitionSha256), `${code}_DEFINITION_DIGEST_INVALID`);
    return { ...entry };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const identities = entries.map((entry) => `${entry.kind}:${entry.schema}:${entry.identity}`);
  invariant(new Set(identities).size === identities.length, `${code}_DUPLICATE_IDENTITY`);
  return entries;
}

function normalizeGrantInventory(value, code) {
  invariant(Array.isArray(value) && value.length <= maximumInventoryEntries, `${code}_ARRAY_INVALID`);
  const entries = value.map((entry) => {
    assertExactKeys(
      entry,
      ["grantable", "grantee", "objectName", "objectType", "privilege"],
      `${code}_ENTRY`,
    );
    requireSafeText(entry.objectType, `${code}_OBJECT_TYPE_INVALID`, {
      maximumLength: 16,
      pattern: /^(?:column|function|schema|sequence|table|view)$/u,
    });
    requireSafeText(entry.objectName, `${code}_OBJECT_NAME_INVALID`);
    requireSafeText(entry.grantee, `${code}_GRANTEE_INVALID`, {
      maximumLength: 128,
      pattern: /^(?:PUBLIC|[a-z_][a-z0-9_-]{0,127})$/u,
    });
    requireSafeText(entry.privilege, `${code}_PRIVILEGE_INVALID`, {
      maximumLength: 32,
      pattern: /^[A-Z][A-Z ]{0,31}$/u,
    });
    invariant(typeof entry.grantable === "boolean", `${code}_GRANTABLE_INVALID`);
    return { ...entry };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  invariant(
    new Set(entries.map((entry) => canonicalJson(entry))).size === entries.length,
    `${code}_DUPLICATE_ENTRY`,
  );
  return entries;
}

function normalizeLocks(value, code, { allowExpectedProductionSessions = false } = {}) {
  assertExactKeys(
    value,
    [
      "idleInTransactionCount",
      "migrationAdvisoryLockCount",
      "schemaBlockingLockCount",
      "unexpectedTargetSessionCount",
    ],
    code,
  );
  for (const [key, count] of Object.entries(value)) {
    invariant(Number.isSafeInteger(count) && count >= 0, `${code}_${key}_INVALID`);
    if (key === "unexpectedTargetSessionCount" && allowExpectedProductionSessions) continue;
    invariant(count === 0, `${code}_${key}_NOT_ZERO`);
  }
  return { ...value };
}

function normalizeSnapshot(
  value,
  code,
  { allowExpectedProductionSessions = false, expectedObservedAt } = {},
) {
  assertExactKeys(
    value,
    ["catalogInventory", "grantInventory", "identity", "ledger", "locks", "tables"],
    code,
  );
  assertExactKeys(
    value.identity,
    [
      "branchId",
      "databaseName",
      "endpointHostSha256",
      "endpointId",
      "observedAt",
      "projectId",
      "queryPackSha256",
      "queryPackVersion",
      "roleName",
      "serverVersionNum",
      "snapshotReceiptSha256",
      "transactionIsolation",
      "transactionReadOnly",
    ],
    `${code}_IDENTITY`,
  );
  invariant(value.identity.projectId === recoveryExpectedProjectId, `${code}_PROJECT_ID_INVALID`);
  invariant(branchIdPattern.test(value.identity.branchId), `${code}_BRANCH_ID_INVALID`);
  invariant(value.identity.databaseName === recoveryExpectedDatabaseName, `${code}_DATABASE_NAME_INVALID`);
  invariant(value.identity.roleName === recoveryExpectedMigrationRoleName, `${code}_ROLE_NAME_INVALID`);
  invariant(endpointIdPattern.test(value.identity.endpointId), `${code}_ENDPOINT_ID_INVALID`);
  invariant(sha256Pattern.test(value.identity.endpointHostSha256), `${code}_ENDPOINT_HOST_DIGEST_INVALID`);
  invariant(value.identity.queryPackVersion === recoveryQueryPackVersion, `${code}_QUERY_PACK_VERSION_INVALID`);
  invariant(value.identity.queryPackSha256 === recoveryQueryPackSha256, `${code}_QUERY_PACK_DIGEST_INVALID`);
  requireIsoTimestamp(value.identity.observedAt, `${code}_OBSERVED_AT_INVALID`);
  invariant(value.identity.observedAt === expectedObservedAt, `${code}_OBSERVED_AT_MISMATCH`);
  invariant(sha256Pattern.test(value.identity.snapshotReceiptSha256), `${code}_SNAPSHOT_RECEIPT_INVALID`);
  invariant(value.identity.transactionIsolation === "repeatable read", `${code}_ISOLATION_INVALID`);
  invariant(value.identity.transactionReadOnly === true, `${code}_READ_ONLY_REQUIRED`);
  invariant(
    Number.isSafeInteger(value.identity.serverVersionNum)
      && value.identity.serverVersionNum >= 170000,
    `${code}_SERVER_VERSION_INVALID`,
  );
  const catalogInventory = normalizeCatalogInventory(value.catalogInventory, `${code}_CATALOG`);
  const grantInventory = normalizeGrantInventory(value.grantInventory, `${code}_GRANTS`);
  return {
    catalog: {
      entryCount: catalogInventory.length,
      sha256: sha256(canonicalJson(catalogInventory)),
    },
    catalogInventory,
    grantInventory,
    grants: {
      entryCount: grantInventory.length,
      sha256: sha256(canonicalJson(grantInventory)),
    },
    identity: { ...value.identity },
    ledger: normalizeLedger(value.ledger, `${code}_LEDGER`),
    locks: normalizeLocks(value.locks, `${code}_LOCKS`, { allowExpectedProductionSessions }),
    tables: normalizeTables(value.tables, `${code}_TABLES`),
  };
}

function assertSame(left, right, code) {
  invariant(canonicalJson(left) === canonicalJson(right), code);
}

function ledgerMap(ledger) {
  return new Map(ledger.map((row) => [row.version, row.checksum]));
}

function migrationAliases(version) {
  return [version, version.slice(0, 3)];
}

function assertBaselineLedger(ledger, targetVersions) {
  assertSame(ledger, recoveryBaselineMigrationPlan, "RECOVERY_BASELINE_LEDGER_EXACT_MISMATCH");
  const versions = new Set(ledger.map((row) => row.version));
  for (const version of [...targetVersions, ...excludedRecoveryMigrations]) {
    invariant(
      migrationAliases(version).every((alias) => !versions.has(alias)),
      "RECOVERY_BASELINE_FORBIDDEN_MIGRATION_PRESENT",
    );
  }
}

function assertMigrationDelta(baseline, migrated, migrationPlan) {
  const baselineRows = ledgerMap(baseline);
  const migratedRows = ledgerMap(migrated);
  invariant(
    migratedRows.size === baselineRows.size + migrationPlan.length,
    "RECOVERY_MIGRATION_LEDGER_DELTA_COUNT_MISMATCH",
  );
  for (const [version, checksum] of baselineRows) {
    invariant(migratedRows.get(version) === checksum, "RECOVERY_BASELINE_LEDGER_DRIFT");
  }
  for (const migration of migrationPlan) {
    invariant(
      migratedRows.get(migration.version) === migration.checksum,
      "RECOVERY_TARGET_MIGRATION_CHECKSUM_MISMATCH",
    );
  }
}

function assertExcludedMigrationsAbsent(snapshots) {
  for (const snapshot of snapshots) {
    const versions = new Set(snapshot.ledger.map((row) => row.version));
    for (const excluded of excludedRecoveryMigrations) {
      invariant(
        migrationAliases(excluded).every((alias) => !versions.has(alias)),
        "RECOVERY_EXCLUDED_MIGRATION_PRESENT",
      );
    }
  }
}

function assertSnapshotIdentity(snapshot, expected, code) {
  invariant(snapshot.identity.projectId === expected.projectId, `${code}_PROJECT_MISMATCH`);
  invariant(snapshot.identity.branchId === expected.branchId, `${code}_BRANCH_MISMATCH`);
  invariant(snapshot.identity.databaseName === expected.databaseName, `${code}_DATABASE_MISMATCH`);
}

function assertMigrationTableStates(snapshots) {
  for (const spec of recoveryTableQuerySpecs) {
    const baseline = snapshots.baselineRecovery.tables[spec.name];
    const migrated = snapshots.migratedRecovery.tables[spec.name];
    if (spec.policy === "CREATED_EMPTY") {
      invariant(baseline.state === "ABSENT", `RECOVERY_${spec.name}_BASELINE_MUST_BE_ABSENT`);
      invariant(migrated.state === "PRESENT", `RECOVERY_${spec.name}_MIGRATED_MUST_BE_PRESENT`);
      invariant(migrated.rowCount === 0, `RECOVERY_${spec.name}_MIGRATED_NOT_EMPTY`);
      invariant(migrated.contentSha256 === emptyRowsSha256, `RECOVERY_${spec.name}_EMPTY_DIGEST_INVALID`);
      continue;
    }
    invariant(baseline.state === "PRESENT", `RECOVERY_${spec.name}_BASELINE_MUST_BE_PRESENT`);
    invariant(migrated.state === "PRESENT", `RECOVERY_${spec.name}_MIGRATED_MUST_BE_PRESENT`);
    invariant(baseline.rowCount === migrated.rowCount, `RECOVERY_${spec.name}_ROW_COUNT_CHANGED`);
    invariant(
      baseline.contentSha256 === migrated.contentSha256,
      `RECOVERY_${spec.name}_STABLE_PROJECTION_CHANGED`,
    );
  }
}

function normalizeMigrationTransformations(value, snapshots) {
  assertExactKeys(value, recoveryTransformationTableNames, "RECOVERY_MIGRATION_TRANSFORMATIONS");
  return Object.fromEntries(recoveryTransformationTableNames.map((table) => {
    const receipt = value[table];
    assertExactKeys(
      receipt,
      [
        "actualAfterSha256",
        "afterRowCount",
        "beforeRowCount",
        "expectedAfterSha256",
        "preservedAfterSha256",
        "preservedRowCount",
        "projectionId",
        "queryPackSha256",
      ],
      `RECOVERY_TRANSFORMATION_${table}`,
    );
    const spec = tableSpecByName.get(table);
    invariant(receipt.projectionId === `${spec?.projectionId}:transform`, `RECOVERY_TRANSFORMATION_${table}_PROJECTION_INVALID`);
    invariant(receipt.queryPackSha256 === recoveryQueryPackSha256, `RECOVERY_TRANSFORMATION_${table}_QUERY_PACK_INVALID`);
    for (const key of ["beforeRowCount", "afterRowCount", "preservedRowCount"]) {
      invariant(Number.isSafeInteger(receipt[key]) && receipt[key] >= 0, `RECOVERY_TRANSFORMATION_${table}_${key}_INVALID`);
    }
    for (const key of ["actualAfterSha256", "expectedAfterSha256", "preservedAfterSha256"]) {
      invariant(sha256Pattern.test(receipt[key]), `RECOVERY_TRANSFORMATION_${table}_${key}_INVALID`);
    }
    invariant(
      receipt.beforeRowCount === snapshots.baselineRecovery.tables[table].rowCount,
      `RECOVERY_TRANSFORMATION_${table}_BASELINE_COUNT_MISMATCH`,
    );
    invariant(
      receipt.afterRowCount === snapshots.migratedRecovery.tables[table].rowCount,
      `RECOVERY_TRANSFORMATION_${table}_MIGRATED_COUNT_MISMATCH`,
    );
    invariant(
      receipt.preservedRowCount === snapshots.preservedMigrated.tables[table].rowCount,
      `RECOVERY_TRANSFORMATION_${table}_PRESERVED_COUNT_MISMATCH`,
    );
    invariant(
      receipt.beforeRowCount === receipt.afterRowCount
        && receipt.afterRowCount === receipt.preservedRowCount,
      `RECOVERY_TRANSFORMATION_${table}_ROW_LOSS`,
    );
    invariant(
      receipt.expectedAfterSha256 === receipt.actualAfterSha256
        && receipt.actualAfterSha256 === receipt.preservedAfterSha256,
      `RECOVERY_TRANSFORMATION_${table}_RESULT_MISMATCH`,
    );
    return [table, { ...receipt }];
  }));
}

function catalogHas(snapshot, objectName) {
  return snapshot.catalogInventory.some(
    (entry) => `${entry.schema}.${entry.name}` === objectName,
  );
}

function privilegesFor(snapshot, { grantee, objectName, objectType }) {
  return snapshot.grantInventory
    .filter(
      (entry) => entry.objectType === objectType
        && entry.objectName === objectName
        && entry.grantee === grantee,
    )
    .map((entry) => entry.privilege)
    .sort();
}

function assertNoGrantOptionsOrColumnGrants(snapshot, objectName, code) {
  const roles = new Set(["PUBLIC", "novalure_app", "novalure_tenant_app"]);
  invariant(
    !snapshot.grantInventory.some(
      (entry) => (entry.objectName === objectName || entry.objectName.startsWith(`${objectName}.`))
        && (entry.grantable || (roles.has(entry.grantee) && entry.objectType === "column")),
    ),
    code,
  );
}

function assertMigratedCatalogAndGrants(snapshot, assertions) {
  const catalog = assertions.catalog;
  invariant(catalog.legacyWebhookIndexPresent === false, "RECOVERY_LEGACY_INDEX_ASSERTION_INVALID");
  invariant(catalog.providerWebhookIndexPresent === true, "RECOVERY_PROVIDER_INDEX_ASSERTION_INVALID");
  invariant(
    catalog.criticalReleaseObjectAclBoundaryExact === true,
    "RECOVERY_CRITICAL_OBJECT_ACL_BOUNDARY_INVALID",
  );
  invariant(catalog.companyApprovalConstraintPresent === true, "RECOVERY_APPROVAL_CONSTRAINT_MISSING");
  invariant(catalog.companyApprovalConstraintValidated === true, "RECOVERY_APPROVAL_CONSTRAINT_NOT_VALIDATED");
  invariant(catalog.mediaDeletionConstraintPresent === true, "RECOVERY_MEDIA_DELETION_CONSTRAINT_MISSING");
  invariant(catalog.mediaDeletionConstraintValidated === true, "RECOVERY_MEDIA_DELETION_CONSTRAINT_NOT_VALIDATED");
  invariant(catalog.migrationChecksumProjectionPresent === true, "RECOVERY_LEDGER_PROJECTION_MISSING");
  invariant(catalog.publicFunnelVisitEventsPresent === true, "RECOVERY_FUNNEL_VISIT_TABLE_MISSING");
  invariant(catalog.pilotRlsEnabled === true, "RECOVERY_FINAL_RLS_CUTOVER_NOT_ACTIVE");
  invariant(catalog.tenantRoleSafe === true, "RECOVERY_TENANT_ROLE_UNSAFE");
  invariant(catalog.tenantRoleAttested === true, "RECOVERY_TENANT_ROLE_ATTESTATION_MISSING");
  invariant(
    catalog.tenantDirectLoginMemberPresent === true,
    "RECOVERY_TENANT_DIRECT_LOGIN_MEMBER_MISSING",
  );
  invariant(catalog.tenantMembershipSafe === true, "RECOVERY_TENANT_MEMBERSHIP_UNSAFE");
  invariant(
    catalog.tenantDatabaseOwnerBoundaryExact === true,
    "RECOVERY_TENANT_DATABASE_OWNER_BOUNDARY_INVALID",
  );
  invariant(
    catalog.pilotApplicationTableAclBoundaryExact === true,
    "RECOVERY_PILOT_APPLICATION_TABLE_ACL_BOUNDARY_INVALID",
  );
  invariant(
    catalog.pilotTenantTablePrivilegesExact === true,
    "RECOVERY_PILOT_TENANT_TABLE_PRIVILEGES_INVALID",
  );
  invariant(
    catalog.pilotApplicationColumnAclBoundaryExact === true,
    "RECOVERY_PILOT_APPLICATION_COLUMN_ACL_BOUNDARY_INVALID",
  );
  invariant(
    catalog.pilotApplicationOwnerBoundaryExact === true,
    "RECOVERY_PILOT_APPLICATION_OWNER_BOUNDARY_INVALID",
  );
  invariant(catalog.pilotOwnersSafe === true, "RECOVERY_PILOT_OWNER_BOUNDARY_UNSAFE");
  invariant(catalog.tenantSchemaUsage === true, "RECOVERY_TENANT_SCHEMA_USAGE_MISSING");
  invariant(
    catalog.tenantSchemaAclBoundaryExact === true,
    "RECOVERY_TENANT_SCHEMA_ACL_BOUNDARY_INVALID",
  );
  invariant(catalog.pilotPoliciesExact === true, "RECOVERY_PILOT_POLICY_CONTRACT_INVALID");
  invariant(catalog.auditAppendOnlyGuardExact === true, "RECOVERY_AUDIT_GUARD_CONTRACT_INVALID");
  invariant(catalog.auditAppendOnlyFunctionExact === true, "RECOVERY_AUDIT_FUNCTION_CONTRACT_INVALID");
  invariant(
    catalog.unexpectedUnvalidatedConstraintCount === 0,
    "RECOVERY_UNEXPECTED_UNVALIDATED_CONSTRAINTS",
  );
  assertSame(
    catalog.intentionalUnvalidatedConstraints,
    intentionalUnvalidatedPilotConstraints,
    "RECOVERY_INTENTIONAL_UNVALIDATED_CONSTRAINT_SET_MISMATCH",
  );

  invariant(
    !catalogHas(snapshot, "public.bot_channel_webhooks_workspace_message_uidx"),
    "RECOVERY_LEGACY_WEBHOOK_INDEX_PRESENT",
  );
  for (const required of [
    "public.bot_channel_webhooks_account_event_uidx",
    "public.broker_operation_requests",
    "public.company_profiles_approval_integrity_check",
    "public.media_assets_deletion_state_check",
    "public.crm_bulk_runtime_batch_items",
    "public.crm_content_documents",
    "public.crm_saved_views",
    "public.novalure_require_media_deletion_actor",
    "public.novalure_schema_migration_checksums",
    "public.property_export_job_events",
    "public.public_funnel_visit_events",
  ]) {
    invariant(catalogHas(snapshot, required), "RECOVERY_REQUIRED_CATALOG_OBJECT_MISSING");
  }

  const funnelObject = "public.public_funnel_visit_events";
  assertSame(
    privilegesFor(snapshot, { grantee: "novalure_app", objectName: funnelObject, objectType: "table" }),
    ["DELETE", "INSERT", "SELECT"],
    "RECOVERY_FUNNEL_APP_GRANTS_INVALID",
  );
  for (const grantee of ["PUBLIC", "novalure_tenant_app"]) {
    assertSame(
      privilegesFor(snapshot, { grantee, objectName: funnelObject, objectType: "table" }),
      [],
      "RECOVERY_FUNNEL_BOUNDARY_GRANTS_INVALID",
    );
  }
  assertNoGrantOptionsOrColumnGrants(snapshot, funnelObject, "RECOVERY_FUNNEL_GRANT_OPTION_OR_COLUMN_GRANT");

  const ledgerObject = "public.novalure_schema_migrations";
  for (const grantee of ["PUBLIC", "novalure_app", "novalure_tenant_app"]) {
    assertSame(
      privilegesFor(snapshot, { grantee, objectName: ledgerObject, objectType: "table" }),
      [],
      "RECOVERY_LEDGER_DIRECT_GRANTS_INVALID",
    );
  }
  assertNoGrantOptionsOrColumnGrants(snapshot, ledgerObject, "RECOVERY_LEDGER_GRANT_OPTION_OR_COLUMN_GRANT");

  const projectionObject = "public.novalure_schema_migration_checksums";
  assertSame(
    privilegesFor(snapshot, {
      grantee: "novalure_app",
      objectName: projectionObject,
      objectType: "view",
    }),
    ["SELECT"],
    "RECOVERY_LEDGER_PROJECTION_APP_GRANTS_INVALID",
  );
  for (const grantee of ["PUBLIC", "novalure_tenant_app"]) {
    assertSame(
      privilegesFor(snapshot, { grantee, objectName: projectionObject, objectType: "view" }),
      [],
      "RECOVERY_LEDGER_PROJECTION_BOUNDARY_INVALID",
    );
  }
  assertNoGrantOptionsOrColumnGrants(
    snapshot,
    projectionObject,
    "RECOVERY_LEDGER_PROJECTION_GRANT_OPTION_OR_COLUMN_GRANT",
  );
}

function normalizeIntentionalConstraintTargets(value) {
  invariant(
    Array.isArray(value) && value.length <= 256,
    "RECOVERY_PILOT_CONSTRAINTS_INVALID",
  );
  const targets = value.map((target) => {
    assertExactKeys(
      target,
      ["constraintName", "tableName"],
      "RECOVERY_PILOT_CONSTRAINT_TARGET",
    );
    requireSafeText(target.tableName, "RECOVERY_PILOT_CONSTRAINT_TABLE_INVALID", {
      maximumLength: 128,
      pattern: /^public\.[a-z_][a-z0-9_]{0,62}$/u,
    });
    requireSafeText(target.constraintName, "RECOVERY_PILOT_CONSTRAINT_NAME_INVALID", {
      maximumLength: 128,
      pattern: /^[a-z_][a-z0-9_]{0,127}$/u,
    });
    return {
      constraintName: target.constraintName,
      tableName: target.tableName,
    };
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  invariant(
    new Set(targets.map((target) => `${target.tableName}:${target.constraintName}`)).size
      === targets.length,
    "RECOVERY_PILOT_CONSTRAINT_TARGET_DUPLICATE",
  );
  return targets;
}

function normalizeTargetMigrationOrder(value) {
  assertExactKeys(
    value,
    ["appliedVersions", "rlsCutoverLast", "strictlyIncreasing", "targetCount"],
    "RECOVERY_TARGET_MIGRATION_ORDER",
  );
  invariant(
    Array.isArray(value.appliedVersions)
      && value.appliedVersions.every((version) => migrationVersionPattern.test(version)),
    "RECOVERY_TARGET_MIGRATION_ORDER_VERSIONS_INVALID",
  );
  assertSame(
    value.appliedVersions,
    recoveryMigrationPlan,
    "RECOVERY_TARGET_MIGRATION_ORDER_SEQUENCE_INVALID",
  );
  invariant(
    value.targetCount === recoveryMigrationPlan.length,
    "RECOVERY_TARGET_MIGRATION_ORDER_COUNT_INVALID",
  );
  invariant(
    value.strictlyIncreasing === true,
    "RECOVERY_TARGET_MIGRATION_APPLIED_AT_NOT_STRICT",
  );
  invariant(value.rlsCutoverLast === true, "RECOVERY_TARGET_MIGRATION_RLS_NOT_LAST");
  return {
    appliedVersions: [...value.appliedVersions],
    rlsCutoverLast: value.rlsCutoverLast,
    strictlyIncreasing: value.strictlyIncreasing,
    targetCount: value.targetCount,
  };
}

function normalizeAssertions(value, expectedCandidateCommit) {
  assertExactKeys(
    value,
    ["catalog", "companyProfileApproval", "targetMigrationOrder"],
    "RECOVERY_ASSERTIONS",
  );
  assertExactKeys(
    value.companyProfileApproval,
    [
      "constraintPresent",
      "constraintValidated",
      "invalidApprovedCount",
      "staleApprovalMetadataCount",
    ],
    "RECOVERY_APPROVAL_ASSERTIONS",
  );
  invariant(value.companyProfileApproval.constraintPresent === true, "RECOVERY_APPROVAL_CONSTRAINT_MISSING");
  invariant(value.companyProfileApproval.constraintValidated === true, "RECOVERY_APPROVAL_CONSTRAINT_NOT_VALIDATED");
  invariant(value.companyProfileApproval.invalidApprovedCount === 0, "RECOVERY_INVALID_APPROVED_ROWS_PRESENT");
  invariant(value.companyProfileApproval.staleApprovalMetadataCount === 0, "RECOVERY_STALE_APPROVAL_METADATA_PRESENT");
  assertExactKeys(
    value.catalog,
    [
      "companyApprovalConstraintPresent",
      "companyApprovalConstraintValidated",
      "criticalReleaseObjectAclBoundaryExact",
      "auditAppendOnlyFunctionExact",
      "auditAppendOnlyGuardExact",
      "intentionalUnvalidatedConstraints",
      "legacyWebhookIndexPresent",
      "mediaDeletionConstraintPresent",
      "mediaDeletionConstraintValidated",
      "migrationChecksumProjectionPresent",
      "pilotApplicationColumnAclBoundaryExact",
      "pilotApplicationOwnerBoundaryExact",
      "pilotApplicationTableAclBoundaryExact",
      "pilotTenantTablePrivilegesExact",
      "pilotOwnersSafe",
      "pilotPoliciesExact",
      "pilotRlsEnabled",
      "providerWebhookIndexPresent",
      "publicFunnelVisitEventsPresent",
      "tenantDirectLoginMemberPresent",
      "tenantDatabaseOwnerBoundaryExact",
      "tenantMembershipSafe",
      "tenantRoleAttestation",
      "tenantRoleAttested",
      "tenantRoleSafe",
      "tenantSchemaAclBoundaryExact",
      "tenantSchemaUsage",
      "unexpectedUnvalidatedConstraintCount",
    ],
    "RECOVERY_CATALOG_ASSERTIONS",
  );
  const intentionalUnvalidatedConstraints = normalizeIntentionalConstraintTargets(
    value.catalog.intentionalUnvalidatedConstraints,
  );
  invariant(
    Number.isSafeInteger(value.catalog.unexpectedUnvalidatedConstraintCount)
      && value.catalog.unexpectedUnvalidatedConstraintCount >= 0,
    "RECOVERY_UNEXPECTED_CONSTRAINT_COUNT_INVALID",
  );
  invariant(
    value.catalog.tenantRoleAttestation
      === `novalure-tenant-cutover:${expectedCandidateCommit}`,
    "RECOVERY_TENANT_ROLE_ATTESTATION_CANDIDATE_MISMATCH",
  );
  for (const key of [
    "auditAppendOnlyFunctionExact",
    "auditAppendOnlyGuardExact",
    "companyApprovalConstraintPresent",
    "companyApprovalConstraintValidated",
    "criticalReleaseObjectAclBoundaryExact",
    "legacyWebhookIndexPresent",
    "mediaDeletionConstraintPresent",
    "mediaDeletionConstraintValidated",
    "migrationChecksumProjectionPresent",
    "pilotApplicationColumnAclBoundaryExact",
    "pilotApplicationOwnerBoundaryExact",
    "pilotApplicationTableAclBoundaryExact",
    "pilotTenantTablePrivilegesExact",
    "pilotOwnersSafe",
    "pilotPoliciesExact",
    "pilotRlsEnabled",
    "providerWebhookIndexPresent",
    "publicFunnelVisitEventsPresent",
    "tenantDirectLoginMemberPresent",
    "tenantDatabaseOwnerBoundaryExact",
    "tenantMembershipSafe",
    "tenantRoleAttested",
    "tenantRoleSafe",
    "tenantSchemaAclBoundaryExact",
    "tenantSchemaUsage",
  ]) {
    invariant(typeof value.catalog[key] === "boolean", "RECOVERY_CATALOG_ASSERTION_BOOLEAN_REQUIRED");
  }
  const targetMigrationOrder = normalizeTargetMigrationOrder(value.targetMigrationOrder);
  return canonicalize({
    ...value,
    catalog: {
      ...value.catalog,
      intentionalUnvalidatedConstraints,
    },
    targetMigrationOrder,
  });
}

function normalizeSchemaDiff(value, branches) {
  assertExactKeys(
    value,
    [
      "baseBranchId",
      "countedAsPassEvidence",
      "diffSha256",
      "observedAt",
      "rawReceiptSha256",
      "requestId",
      "sourceTool",
      "status",
      "targetBranchId",
    ],
    "RECOVERY_SCHEMA_DIFF",
  );
  invariant(value.sourceTool === "NEON_SCHEMA_DIFF", "RECOVERY_SCHEMA_DIFF_SOURCE_INVALID");
  invariant(value.baseBranchId === branches.productionBranchId, "RECOVERY_SCHEMA_DIFF_BASE_BRANCH_INVALID");
  invariant(value.targetBranchId === branches.recoveryBranchId, "RECOVERY_SCHEMA_DIFF_TARGET_BRANCH_INVALID");
  requireIsoTimestamp(value.observedAt, "RECOVERY_SCHEMA_DIFF_OBSERVED_AT_INVALID");
  invariant(sha256Pattern.test(value.rawReceiptSha256), "RECOVERY_SCHEMA_DIFF_RECEIPT_INVALID");
  invariant(requestIdPattern.test(value.requestId), "RECOVERY_SCHEMA_DIFF_REQUEST_ID_INVALID");
  if (value.status === "PASS_EMPTY") {
    invariant(value.countedAsPassEvidence === true, "RECOVERY_SCHEMA_DIFF_PASS_FLAG_INVALID");
    invariant(value.diffSha256 === sha256(""), "RECOVERY_SCHEMA_DIFF_EMPTY_DIGEST_INVALID");
  } else {
    invariant(
      value.status === "UNAVAILABLE_HTTP_413_TOOL_LIMIT",
      "RECOVERY_SCHEMA_DIFF_STATUS_INVALID",
    );
    invariant(value.countedAsPassEvidence === false, "RECOVERY_SCHEMA_DIFF_TOOL_LIMIT_MISREPRESENTED");
    invariant(value.diffSha256 === null, "RECOVERY_SCHEMA_DIFF_TOOL_LIMIT_DIGEST_INVALID");
  }
  return { ...value };
}

function normalizeTimings(value) {
  const keys = [
    "branchCreateStartedAt",
    "branchReadyAt",
    "migrationFinishedAt",
    "migrationStartedAt",
    "postResetSnapshotAt",
    "preserveReadyAt",
    "preserveStartedAt",
    "productionSnapshotAt",
    "resetReadyAt",
    "resetSourceProductionAt",
    "resetStartedAt",
  ];
  assertExactKeys(value, keys, "RECOVERY_TIMINGS");
  const parsed = Object.fromEntries(keys.map((key) => [key, requireIsoTimestamp(value[key], `RECOVERY_${key}_INVALID`)]));
  const order = [
    "productionSnapshotAt",
    "branchCreateStartedAt",
    "branchReadyAt",
    "migrationStartedAt",
    "migrationFinishedAt",
    "preserveStartedAt",
    "preserveReadyAt",
    "resetSourceProductionAt",
    "resetStartedAt",
    "resetReadyAt",
    "postResetSnapshotAt",
  ];
  invariant(
    order.every((key, index) => index === 0 || parsed[key].epoch >= parsed[order[index - 1]].epoch),
    "RECOVERY_TIMING_ORDER_INVALID",
  );
  return {
    ...Object.fromEntries(keys.map((key) => [key, parsed[key].value])),
    observedBranchReadySeconds: (parsed.branchReadyAt.epoch - parsed.branchCreateStartedAt.epoch) / 1_000,
    observedMigrationSeconds: (parsed.migrationFinishedAt.epoch - parsed.migrationStartedAt.epoch) / 1_000,
    observedPreserveReadySeconds: (parsed.preserveReadyAt.epoch - parsed.preserveStartedAt.epoch) / 1_000,
    observedResetReadySeconds: (parsed.resetReadyAt.epoch - parsed.resetStartedAt.epoch) / 1_000,
  };
}

function normalizeMigrationPlan(value) {
  invariant(
    Array.isArray(value) && value.length === recoveryEvidenceMigrationVersions.length,
    "RECOVERY_MIGRATION_PLAN_LENGTH_INVALID",
  );
  const plan = value.map((migration) => {
    assertExactKeys(migration, ["checksum", "version"], "RECOVERY_MIGRATION_PLAN_ENTRY");
    invariant(migrationVersionPattern.test(migration.version), "RECOVERY_MIGRATION_PLAN_VERSION_INVALID");
    invariant(sha256Pattern.test(migration.checksum), "RECOVERY_MIGRATION_PLAN_CHECKSUM_INVALID");
    return { ...migration };
  });
  invariant(new Set(plan.map((migration) => migration.version)).size === plan.length, "RECOVERY_MIGRATION_PLAN_DUPLICATE");
  assertSame(
    plan.map((migration) => migration.version),
    recoveryEvidenceMigrationVersions,
    "RECOVERY_MIGRATION_PLAN_VERSIONS_INVALID",
  );
  return plan;
}

function normalizeEndpointFields(value, code) {
  invariant(endpointIdPattern.test(value.endpointId), `${code}_ENDPOINT_ID_INVALID`);
  invariant(sha256Pattern.test(value.endpointHostSha256), `${code}_ENDPOINT_HOST_DIGEST_INVALID`);
  invariant(value.endpointType === "read_write_direct", `${code}_ENDPOINT_TYPE_INVALID`);
}

function normalizeProductionReceipt(value) {
  assertExactKeys(
    value,
    [
      "action",
      "branchId",
      "endpointHostSha256",
      "endpointId",
      "endpointType",
      "observedAt",
      "parentBranchId",
      "projectId",
      "rawReceiptSha256",
      "receiptId",
      "requestId",
    ],
    "RECOVERY_CONTROL_PLANE_PRODUCTION",
  );
  invariant(value.action === "READ_PRODUCTION_BRANCH", "RECOVERY_CONTROL_PLANE_PRODUCTION_ACTION_INVALID");
  invariant(value.projectId === recoveryExpectedProjectId, "RECOVERY_CONTROL_PLANE_PRODUCTION_PROJECT_INVALID");
  invariant(value.branchId === recoveryExpectedProductionBranchId, "RECOVERY_CONTROL_PLANE_PRODUCTION_BRANCH_INVALID");
  invariant(value.parentBranchId === null, "RECOVERY_CONTROL_PLANE_PRODUCTION_PARENT_INVALID");
  requireIsoTimestamp(value.observedAt, "RECOVERY_CONTROL_PLANE_PRODUCTION_TIME_INVALID");
  invariant(receiptIdPattern.test(value.receiptId), "RECOVERY_CONTROL_PLANE_PRODUCTION_RECEIPT_ID_INVALID");
  invariant(sha256Pattern.test(value.rawReceiptSha256), "RECOVERY_CONTROL_PLANE_PRODUCTION_RECEIPT_INVALID");
  invariant(requestIdPattern.test(value.requestId), "RECOVERY_CONTROL_PLANE_PRODUCTION_REQUEST_ID_INVALID");
  normalizeEndpointFields(value, "RECOVERY_CONTROL_PLANE_PRODUCTION");
  return { ...value };
}

function normalizeOperationReceipt(value, { action, code }) {
  assertExactKeys(
    value,
    [
      "action",
      "completedAt",
      "endpointHostSha256",
      "endpointId",
      "endpointType",
      "operationId",
      "operationStatus",
      "parentBranchId",
      "projectId",
      "rawReceiptSha256",
      "receiptId",
      "requestId",
      "sourceTimestamp",
      "startedAt",
      "targetBranchId",
    ],
    code,
  );
  invariant(value.action === action, `${code}_ACTION_INVALID`);
  invariant(value.projectId === recoveryExpectedProjectId, `${code}_PROJECT_INVALID`);
  invariant(value.operationStatus === "FINISHED", `${code}_OPERATION_NOT_FINISHED`);
  requireSafeText(value.operationId, `${code}_OPERATION_ID_INVALID`, {
    maximumLength: 160,
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/u,
  });
  invariant(receiptIdPattern.test(value.receiptId), `${code}_RECEIPT_ID_INVALID`);
  invariant(sha256Pattern.test(value.rawReceiptSha256), `${code}_RAW_RECEIPT_INVALID`);
  invariant(requestIdPattern.test(value.requestId), `${code}_REQUEST_ID_INVALID`);
  requireIsoTimestamp(value.startedAt, `${code}_STARTED_AT_INVALID`);
  requireIsoTimestamp(value.completedAt, `${code}_COMPLETED_AT_INVALID`);
  requireIsoTimestamp(value.sourceTimestamp, `${code}_SOURCE_TIMESTAMP_INVALID`);
  invariant(Date.parse(value.completedAt) >= Date.parse(value.startedAt), `${code}_TIME_ORDER_INVALID`);
  invariant(branchIdPattern.test(value.parentBranchId), `${code}_PARENT_BRANCH_INVALID`);
  invariant(branchIdPattern.test(value.targetBranchId), `${code}_TARGET_BRANCH_INVALID`);
  normalizeEndpointFields(value, code);
  return { ...value };
}

function assertSnapshotEndpoint(snapshot, receipt, code) {
  invariant(snapshot.identity.endpointId === receipt.endpointId, `${code}_ENDPOINT_ID_MISMATCH`);
  invariant(
    snapshot.identity.endpointHostSha256 === receipt.endpointHostSha256,
    `${code}_ENDPOINT_HOST_MISMATCH`,
  );
}

function normalizeControlPlane(value, { branches, snapshots, timings }) {
  assertExactKeys(
    value,
    ["receiptBundleSha256", "receipts", "sourceTool", "status"],
    "RECOVERY_CONTROL_PLANE",
  );
  invariant(value.status === "VERIFIED", "RECOVERY_CONTROL_PLANE_NOT_VERIFIED");
  invariant(value.sourceTool === "NEON_CONTROL_PLANE_MCP", "RECOVERY_CONTROL_PLANE_SOURCE_INVALID");
  assertExactKeys(
    value.receipts,
    ["preserveCreate", "productionBranch", "recoveryCreate", "recoveryReset"],
    "RECOVERY_CONTROL_PLANE_RECEIPTS",
  );
  const receipts = {
    preserveCreate: normalizeOperationReceipt(value.receipts.preserveCreate, {
      action: "CREATE_PRESERVED_BRANCH",
      code: "RECOVERY_CONTROL_PLANE_PRESERVE",
    }),
    productionBranch: normalizeProductionReceipt(value.receipts.productionBranch),
    recoveryCreate: normalizeOperationReceipt(value.receipts.recoveryCreate, {
      action: "CREATE_RECOVERY_BRANCH",
      code: "RECOVERY_CONTROL_PLANE_CREATE",
    }),
    recoveryReset: normalizeOperationReceipt(value.receipts.recoveryReset, {
      action: "RESET_RECOVERY_BRANCH",
      code: "RECOVERY_CONTROL_PLANE_RESET",
    }),
  };
  invariant(
    value.receiptBundleSha256 === sha256(canonicalJson(receipts)),
    "RECOVERY_CONTROL_PLANE_RECEIPT_BUNDLE_DIGEST_INVALID",
  );
  const production = receipts.productionBranch;
  const create = receipts.recoveryCreate;
  const preserve = receipts.preserveCreate;
  const reset = receipts.recoveryReset;
  invariant(production.observedAt === timings.productionSnapshotAt, "RECOVERY_CONTROL_PLANE_PRODUCTION_TIME_MISMATCH");
  invariant(create.parentBranchId === branches.productionBranchId, "RECOVERY_CONTROL_PLANE_CREATE_PARENT_MISMATCH");
  invariant(create.targetBranchId === branches.recoveryBranchId, "RECOVERY_CONTROL_PLANE_CREATE_TARGET_MISMATCH");
  invariant(create.sourceTimestamp === timings.productionSnapshotAt, "RECOVERY_CONTROL_PLANE_CREATE_SOURCE_TIME_MISMATCH");
  invariant(create.startedAt === timings.branchCreateStartedAt, "RECOVERY_CONTROL_PLANE_CREATE_START_MISMATCH");
  invariant(create.completedAt === timings.branchReadyAt, "RECOVERY_CONTROL_PLANE_CREATE_READY_MISMATCH");
  invariant(preserve.parentBranchId === branches.recoveryBranchId, "RECOVERY_CONTROL_PLANE_PRESERVE_PARENT_MISMATCH");
  invariant(preserve.targetBranchId === branches.preservedMigratedBranchId, "RECOVERY_CONTROL_PLANE_PRESERVE_TARGET_MISMATCH");
  invariant(preserve.sourceTimestamp === timings.migrationFinishedAt, "RECOVERY_CONTROL_PLANE_PRESERVE_SOURCE_TIME_MISMATCH");
  invariant(preserve.startedAt === timings.preserveStartedAt, "RECOVERY_CONTROL_PLANE_PRESERVE_START_MISMATCH");
  invariant(preserve.completedAt === timings.preserveReadyAt, "RECOVERY_CONTROL_PLANE_PRESERVE_READY_MISMATCH");
  invariant(reset.parentBranchId === branches.productionBranchId, "RECOVERY_CONTROL_PLANE_RESET_PARENT_MISMATCH");
  invariant(reset.targetBranchId === branches.recoveryBranchId, "RECOVERY_CONTROL_PLANE_RESET_TARGET_MISMATCH");
  invariant(reset.sourceTimestamp === timings.resetSourceProductionAt, "RECOVERY_CONTROL_PLANE_RESET_SOURCE_TIME_MISMATCH");
  invariant(reset.startedAt === timings.resetStartedAt, "RECOVERY_CONTROL_PLANE_RESET_START_MISMATCH");
  invariant(reset.completedAt === timings.resetReadyAt, "RECOVERY_CONTROL_PLANE_RESET_READY_MISMATCH");
  invariant(
    new Set([production.endpointId, create.endpointId, preserve.endpointId]).size === 3,
    "RECOVERY_CONTROL_PLANE_ENDPOINTS_NOT_DISTINCT",
  );
  invariant(reset.endpointId === create.endpointId, "RECOVERY_CONTROL_PLANE_RESET_ENDPOINT_CHANGED");
  invariant(reset.endpointHostSha256 === create.endpointHostSha256, "RECOVERY_CONTROL_PLANE_RESET_HOST_CHANGED");
  invariant(
    new Set([production.endpointHostSha256, create.endpointHostSha256, preserve.endpointHostSha256]).size === 3,
    "RECOVERY_CONTROL_PLANE_ENDPOINT_HOSTS_NOT_DISTINCT",
  );
  invariant(
    new Set([create.operationId, preserve.operationId, reset.operationId]).size === 3,
    "RECOVERY_CONTROL_PLANE_OPERATION_IDS_NOT_DISTINCT",
  );
  invariant(
    new Set([
      production.receiptId,
      create.receiptId,
      preserve.receiptId,
      reset.receiptId,
    ]).size === 4,
    "RECOVERY_CONTROL_PLANE_RECEIPT_IDS_NOT_DISTINCT",
  );
  invariant(
    new Set([
      production.rawReceiptSha256,
      create.rawReceiptSha256,
      preserve.rawReceiptSha256,
      reset.rawReceiptSha256,
    ]).size === 4,
    "RECOVERY_CONTROL_PLANE_RAW_RECEIPTS_NOT_DISTINCT",
  );
  invariant(
    new Set([
      production.requestId,
      create.requestId,
      preserve.requestId,
      reset.requestId,
    ]).size === 4,
    "RECOVERY_CONTROL_PLANE_REQUEST_IDS_NOT_DISTINCT",
  );
  for (const name of ["baselineProduction", "postResetProduction"]) {
    assertSnapshotEndpoint(snapshots[name], production, `RECOVERY_${name.toUpperCase()}`);
  }
  for (const name of ["baselineRecovery", "migratedRecovery", "postResetRecovery"]) {
    assertSnapshotEndpoint(snapshots[name], create, `RECOVERY_${name.toUpperCase()}`);
  }
  assertSnapshotEndpoint(snapshots.preservedMigrated, preserve, "RECOVERY_PRESERVED_MIGRATED");
  return { ...value, receipts };
}

function normalizeQueryExecution(value, { observationBundle, snapshots, timings }) {
  assertExactKeys(
    value,
    [
      "executedAt",
      "observationBundleSha256",
      "queryPackSha256",
      "queryPackVersion",
      "requestId",
      "snapshotReceipts",
      "sourceTool",
      "status",
      "transactionIsolation",
      "transactionReadOnly",
    ],
    "RECOVERY_QUERY_EXECUTION",
  );
  invariant(value.status === "VERIFIED", "RECOVERY_QUERY_EXECUTION_NOT_VERIFIED");
  invariant(value.sourceTool === "NEON_SQL_READ_ONLY", "RECOVERY_QUERY_EXECUTION_SOURCE_INVALID");
  invariant(value.queryPackVersion === recoveryQueryPackVersion, "RECOVERY_QUERY_EXECUTION_PACK_VERSION_INVALID");
  invariant(value.queryPackSha256 === recoveryQueryPackSha256, "RECOVERY_QUERY_EXECUTION_PACK_DIGEST_INVALID");
  invariant(requestIdPattern.test(value.requestId), "RECOVERY_QUERY_EXECUTION_REQUEST_ID_INVALID");
  invariant(value.transactionIsolation === "repeatable read", "RECOVERY_QUERY_EXECUTION_ISOLATION_INVALID");
  invariant(value.transactionReadOnly === true, "RECOVERY_QUERY_EXECUTION_READ_ONLY_REQUIRED");
  const executedAt = requireIsoTimestamp(value.executedAt, "RECOVERY_QUERY_EXECUTION_TIME_INVALID");
  invariant(
    executedAt.epoch >= Date.parse(timings.postResetSnapshotAt),
    "RECOVERY_QUERY_EXECUTION_BEFORE_FINAL_SNAPSHOT",
  );
  assertExactKeys(value.snapshotReceipts, Object.keys(snapshots), "RECOVERY_QUERY_EXECUTION_SNAPSHOT_RECEIPTS");
  for (const [name, digest] of Object.entries(value.snapshotReceipts)) {
    invariant(sha256Pattern.test(digest), `RECOVERY_QUERY_EXECUTION_${name}_RECEIPT_INVALID`);
    invariant(
      digest === snapshots[name].identity.snapshotReceiptSha256,
      `RECOVERY_QUERY_EXECUTION_${name}_RECEIPT_MISMATCH`,
    );
  }
  invariant(
    new Set(Object.values(value.snapshotReceipts)).size === Object.keys(snapshots).length,
    "RECOVERY_QUERY_EXECUTION_SNAPSHOT_RECEIPTS_NOT_DISTINCT",
  );
  invariant(
    value.observationBundleSha256 === sha256(canonicalJson(observationBundle)),
    "RECOVERY_QUERY_EXECUTION_OBSERVATION_BUNDLE_INVALID",
  );
  return { ...value };
}

function normalizeTrustAnchor(value) {
  invariant(value && typeof value === "object", "RECOVERY_EXTERNAL_TRUST_ANCHOR_REQUIRED");
  invariant(
    sha256Pattern.test(value.expectedPublicKeySha256),
    "RECOVERY_EXTERNAL_TRUST_KEY_DIGEST_INVALID",
  );
  invariant(
    typeof value.expectedSignerIdentity === "string"
      && observerIdentityPattern.test(value.expectedSignerIdentity)
      && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value.expectedSignerIdentity),
    "RECOVERY_EXTERNAL_TRUST_SIGNER_IDENTITY_INVALID",
  );
  invariant(
    typeof value.expectedKeyId === "string" && observerKeyIdPattern.test(value.expectedKeyId),
    "RECOVERY_EXTERNAL_TRUST_KEY_ID_INVALID",
  );
  let publicKey;
  try {
    publicKey = value.publicKey?.type === "public"
      ? value.publicKey
      : createPublicKey(value.publicKey);
  } catch {
    invariant(false, "RECOVERY_EXTERNAL_TRUST_PUBLIC_KEY_INVALID");
  }
  invariant(publicKey.asymmetricKeyType === "ed25519", "RECOVERY_EXTERNAL_TRUST_KEY_TYPE_INVALID");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  invariant(
    sha256(publicKeyDer) === value.expectedPublicKeySha256,
    "RECOVERY_EXTERNAL_TRUST_KEY_DIGEST_MISMATCH",
  );
  return {
    expectedKeyId: value.expectedKeyId,
    expectedPublicKeySha256: value.expectedPublicKeySha256,
    expectedSignerIdentity: value.expectedSignerIdentity,
    publicKey,
  };
}

function canonicalBase64(value, pattern, code) {
  invariant(typeof value === "string" && pattern.test(value), code);
  const decoded = Buffer.from(value, "base64");
  invariant(decoded.toString("base64") === value, code);
  return decoded;
}

export function buildRecoveryObservationStatement({
  branches,
  candidateCommit,
  controlPlane,
  databaseName,
  observationWindow,
  observer,
  projectId,
  queryExecution,
  schemaDiff,
}) {
  const receipts = controlPlane.receipts;
  return canonicalize({
    observationWindow,
    observer: {
      identity: observer.identity,
      keyId: observer.keyId,
      publicKeySha256: observer.publicKeySha256,
    },
    provider: {
      name: recoveryObservationProvider,
      projectId,
      service: recoveryObservationService,
    },
    requestLineage: {
      controlPlane: {
        preserveCreate: {
          action: receipts.preserveCreate.action,
          operationId: receipts.preserveCreate.operationId,
          rawReceiptSha256: receipts.preserveCreate.rawReceiptSha256,
          receiptId: receipts.preserveCreate.receiptId,
          requestId: receipts.preserveCreate.requestId,
        },
        productionBranch: {
          action: receipts.productionBranch.action,
          operationId: null,
          rawReceiptSha256: receipts.productionBranch.rawReceiptSha256,
          receiptId: receipts.productionBranch.receiptId,
          requestId: receipts.productionBranch.requestId,
        },
        recoveryCreate: {
          action: receipts.recoveryCreate.action,
          operationId: receipts.recoveryCreate.operationId,
          rawReceiptSha256: receipts.recoveryCreate.rawReceiptSha256,
          receiptId: receipts.recoveryCreate.receiptId,
          requestId: receipts.recoveryCreate.requestId,
        },
        recoveryReset: {
          action: receipts.recoveryReset.action,
          operationId: receipts.recoveryReset.operationId,
          rawReceiptSha256: receipts.recoveryReset.rawReceiptSha256,
          receiptId: receipts.recoveryReset.receiptId,
          requestId: receipts.recoveryReset.requestId,
        },
      },
      controlPlaneReceiptBundleSha256: controlPlane.receiptBundleSha256,
      schemaDiff: {
        rawReceiptSha256: schemaDiff.rawReceiptSha256,
        requestId: schemaDiff.requestId,
      },
      sqlObservation: {
        observationBundleSha256: queryExecution.observationBundleSha256,
        requestId: queryExecution.requestId,
        snapshotReceipts: queryExecution.snapshotReceipts,
      },
    },
    schemaVersion: 1,
    statementType: recoveryObservationStatementType,
    subject: {
      candidateCommit,
      databaseName,
      preservedMigratedBranchId: branches.preservedMigratedBranchId,
      productionBranchId: branches.productionBranchId,
      queryPackSha256: recoveryQueryPackSha256,
      queryPackVersion: recoveryQueryPackVersion,
      recoveryBranchId: branches.recoveryBranchId,
    },
  });
}

function normalizeObservationAttestation(value, context, trustAnchorValue) {
  assertExactKeys(
    value,
    ["algorithm", "signatureBase64", "statement"],
    "RECOVERY_EXTERNAL_OBSERVER_ATTESTATION",
  );
  invariant(value.algorithm === "Ed25519", "RECOVERY_EXTERNAL_OBSERVER_ALGORITHM_INVALID");
  const trustAnchor = normalizeTrustAnchor(trustAnchorValue);
  const signature = canonicalBase64(
    value.signatureBase64,
    signatureBase64Pattern,
    "RECOVERY_EXTERNAL_OBSERVER_SIGNATURE_INVALID",
  );
  assertExactKeys(
    value.statement,
    [
      "observationWindow",
      "observer",
      "provider",
      "requestLineage",
      "schemaVersion",
      "statementType",
      "subject",
    ],
    "RECOVERY_EXTERNAL_OBSERVER_STATEMENT",
  );
  assertExactKeys(
    value.statement.observer,
    ["identity", "keyId", "publicKeySha256"],
    "RECOVERY_EXTERNAL_OBSERVER_IDENTITY",
  );
  invariant(
    value.statement.observer.identity === trustAnchor.expectedSignerIdentity,
    "RECOVERY_EXTERNAL_OBSERVER_IDENTITY_MISMATCH",
  );
  invariant(
    value.statement.observer.keyId === trustAnchor.expectedKeyId,
    "RECOVERY_EXTERNAL_OBSERVER_KEY_ID_MISMATCH",
  );
  invariant(
    value.statement.observer.publicKeySha256 === trustAnchor.expectedPublicKeySha256,
    "RECOVERY_EXTERNAL_OBSERVER_KEY_DIGEST_MISMATCH",
  );
  assertExactKeys(
    value.statement.observationWindow,
    ["endedAt", "startedAt"],
    "RECOVERY_EXTERNAL_OBSERVATION_WINDOW",
  );
  const started = requireIsoTimestamp(
    value.statement.observationWindow.startedAt,
    "RECOVERY_EXTERNAL_OBSERVATION_WINDOW_START_INVALID",
  );
  const ended = requireIsoTimestamp(
    value.statement.observationWindow.endedAt,
    "RECOVERY_EXTERNAL_OBSERVATION_WINDOW_END_INVALID",
  );
  invariant(ended.epoch >= started.epoch, "RECOVERY_EXTERNAL_OBSERVATION_WINDOW_ORDER_INVALID");
  invariant(
    ended.epoch - started.epoch <= maximumObservationWindowMilliseconds,
    "RECOVERY_EXTERNAL_OBSERVATION_WINDOW_TOO_WIDE",
  );
  const observedEpochs = [
    context.timings.productionSnapshotAt,
    context.timings.branchCreateStartedAt,
    context.timings.branchReadyAt,
    context.timings.migrationStartedAt,
    context.timings.migrationFinishedAt,
    context.timings.preserveStartedAt,
    context.timings.preserveReadyAt,
    context.timings.resetStartedAt,
    context.timings.resetReadyAt,
    context.timings.postResetSnapshotAt,
    context.schemaDiff.observedAt,
    context.queryExecution.executedAt,
  ].map(Date.parse);
  invariant(
    started.epoch <= Math.min(...observedEpochs) && ended.epoch >= Math.max(...observedEpochs),
    "RECOVERY_EXTERNAL_OBSERVATION_WINDOW_INCOMPLETE",
  );
  const expectedStatement = buildRecoveryObservationStatement({
    branches: context.branches,
    candidateCommit: context.candidateCommit,
    controlPlane: context.controlPlane,
    databaseName: context.databaseName,
    observationWindow: value.statement.observationWindow,
    observer: value.statement.observer,
    projectId: context.projectId,
    queryExecution: context.queryExecution,
    schemaDiff: context.schemaDiff,
  });
  assertSame(value.statement, expectedStatement, "RECOVERY_EXTERNAL_OBSERVER_STATEMENT_MISMATCH");
  invariant(
    verifySignature(
      null,
      Buffer.from(canonicalJson(expectedStatement), "utf8"),
      trustAnchor.publicKey,
      signature,
    ),
    "RECOVERY_EXTERNAL_OBSERVER_SIGNATURE_VERIFICATION_FAILED",
  );
  return canonicalize(value);
}

function normalizeProvenance(value, context, trustAnchor) {
  assertExactKeys(
    value,
    [
      "controlPlane",
      "externalAttestation",
      "queryExecution",
      "queryPackSha256",
      "queryPackVersion",
      "status",
    ],
    "RECOVERY_PROVENANCE",
  );
  invariant(value.queryPackVersion === recoveryQueryPackVersion, "RECOVERY_PROVENANCE_PACK_VERSION_INVALID");
  invariant(value.queryPackSha256 === recoveryQueryPackSha256, "RECOVERY_PROVENANCE_PACK_DIGEST_INVALID");
  invariant(value.status === "VERIFIED" || value.status === "UNVERIFIED", "RECOVERY_PROVENANCE_STATUS_INVALID");
  if (value.status === "UNVERIFIED") {
    invariant(value.controlPlane === null, "RECOVERY_UNVERIFIED_CONTROL_PLANE_MUST_BE_NULL");
    invariant(value.queryExecution === null, "RECOVERY_UNVERIFIED_QUERY_EXECUTION_MUST_BE_NULL");
    invariant(value.externalAttestation === null, "RECOVERY_UNVERIFIED_ATTESTATION_MUST_BE_NULL");
    return { ...value };
  }
  invariant(value.controlPlane !== null, "RECOVERY_VERIFIED_CONTROL_PLANE_REQUIRED");
  invariant(value.queryExecution !== null, "RECOVERY_VERIFIED_QUERY_EXECUTION_REQUIRED");
  invariant(value.externalAttestation !== null, "RECOVERY_VERIFIED_EXTERNAL_ATTESTATION_REQUIRED");
  const controlPlane = normalizeControlPlane(value.controlPlane, context);
  const queryExecution = normalizeQueryExecution(value.queryExecution, context);
  invariant(
    Date.parse(queryExecution.executedAt) >= Date.parse(context.schemaDiff.observedAt),
    "RECOVERY_QUERY_EXECUTION_BEFORE_SCHEMA_DIFF",
  );
  invariant(
    !new Set([
      ...Object.values(controlPlane.receipts).map((receipt) => receipt.requestId),
      queryExecution.requestId,
      context.schemaDiff.requestId,
    ]).has(undefined),
    "RECOVERY_REQUEST_LINEAGE_INCOMPLETE",
  );
  invariant(
    new Set([
      ...Object.values(controlPlane.receipts).map((receipt) => receipt.requestId),
      queryExecution.requestId,
      context.schemaDiff.requestId,
    ]).size === 6,
    "RECOVERY_REQUEST_LINEAGE_NOT_DISTINCT",
  );
  return {
    ...value,
    controlPlane,
    externalAttestation: normalizeObservationAttestation(
      value.externalAttestation,
      {
        ...context,
        controlPlane,
        queryExecution,
      },
      trustAnchor,
    ),
    queryExecution,
  };
}

export function buildDatabaseRecoveryLiveEvidence({
  expectedCandidateCommit,
  generatedAt = new Date().toISOString(),
  input,
  migrationPlan,
  trustAnchor = null,
}) {
  invariant(/^[a-f0-9]{40}$/u.test(expectedCandidateCommit), "RECOVERY_EXPECTED_CANDIDATE_INVALID");
  scanForSecretMaterial(input);
  assertExactKeys(
    input,
    [
      "action",
      "assertions",
      "branches",
      "candidateCommit",
      "databaseName",
      "environment",
      "migrationTransformations",
      "productionAliasOrEnvironmentChanged",
      "productionMutationPerformed",
      "projectId",
      "provenance",
      "schemaDiff",
      "schemaVersion",
      "snapshots",
      "timings",
    ],
    "RECOVERY_INPUT",
  );
  invariant(input.schemaVersion === 2, "RECOVERY_INPUT_SCHEMA_UNSUPPORTED");
  invariant(input.action === "FINAL_RECOVERY_READ_ONLY_EVIDENCE", "RECOVERY_INPUT_ACTION_INVALID");
  invariant(input.environment === "RECOVERY_BRANCH_ONLY", "RECOVERY_INPUT_ENVIRONMENT_INVALID");
  invariant(input.candidateCommit === expectedCandidateCommit, "RECOVERY_INPUT_CANDIDATE_MISMATCH");
  invariant(input.productionMutationPerformed === false, "RECOVERY_PRODUCTION_MUTATION_RECORDED");
  invariant(
    input.productionAliasOrEnvironmentChanged === false,
    "RECOVERY_PRODUCTION_ALIAS_OR_ENVIRONMENT_CHANGED",
  );
  invariant(input.projectId === recoveryExpectedProjectId, "RECOVERY_PROJECT_ID_INVALID");
  invariant(input.databaseName === recoveryExpectedDatabaseName, "RECOVERY_DATABASE_NAME_INVALID");
  assertExactKeys(
    input.branches,
    ["preservedMigratedBranchId", "productionBranchId", "recoveryBranchId"],
    "RECOVERY_BRANCHES",
  );
  for (const branchId of Object.values(input.branches)) {
    invariant(branchIdPattern.test(branchId), "RECOVERY_BRANCH_ID_INVALID");
  }
  invariant(
    new Set(Object.values(input.branches)).size === 3,
    "RECOVERY_BRANCHES_MUST_BE_DISTINCT",
  );
  invariant(
    input.branches.productionBranchId === recoveryExpectedProductionBranchId,
    "RECOVERY_PRODUCTION_BRANCH_NOT_ALLOWLISTED",
  );
  assertExactKeys(
    input.snapshots,
    [
      "baselineProduction",
      "baselineRecovery",
      "migratedRecovery",
      "postResetProduction",
      "postResetRecovery",
      "preservedMigrated",
    ],
    "RECOVERY_SNAPSHOTS",
  );

  const plan = normalizeMigrationPlan(migrationPlan);
  const assertions = normalizeAssertions(input.assertions, input.candidateCommit);
  const timings = normalizeTimings(input.timings);
  const schemaDiff = normalizeSchemaDiff(input.schemaDiff, input.branches);
  invariant(
    Date.parse(schemaDiff.observedAt) >= Date.parse(timings.postResetSnapshotAt),
    "RECOVERY_SCHEMA_DIFF_BEFORE_POST_RESET_SNAPSHOT",
  );
  const snapshotObservedAt = {
    baselineProduction: timings.productionSnapshotAt,
    baselineRecovery: timings.branchReadyAt,
    migratedRecovery: timings.migrationFinishedAt,
    postResetProduction: timings.resetSourceProductionAt,
    postResetRecovery: timings.postResetSnapshotAt,
    preservedMigrated: timings.preserveReadyAt,
  };
  const snapshots = Object.fromEntries(
    Object.entries(input.snapshots).map(([name, snapshot]) => [
      name,
      normalizeSnapshot(snapshot, `RECOVERY_${name.toUpperCase()}`, {
        allowExpectedProductionSessions: name === "baselineProduction" || name === "postResetProduction",
        expectedObservedAt: snapshotObservedAt[name],
      }),
    ]),
  );
  const identityBase = { databaseName: input.databaseName, projectId: input.projectId };
  for (const name of ["baselineProduction", "postResetProduction"]) {
    assertSnapshotIdentity(
      snapshots[name],
      { ...identityBase, branchId: input.branches.productionBranchId },
      `RECOVERY_${name.toUpperCase()}`,
    );
  }
  for (const name of ["baselineRecovery", "migratedRecovery", "postResetRecovery"]) {
    assertSnapshotIdentity(
      snapshots[name],
      { ...identityBase, branchId: input.branches.recoveryBranchId },
      `RECOVERY_${name.toUpperCase()}`,
    );
  }
  assertSnapshotIdentity(
    snapshots.preservedMigrated,
    { ...identityBase, branchId: input.branches.preservedMigratedBranchId },
    "RECOVERY_PRESERVED_MIGRATED",
  );
  invariant(
    new Set(Object.values(snapshots).map((snapshot) => snapshot.identity.serverVersionNum)).size === 1,
    "RECOVERY_SERVER_VERSION_DRIFT",
  );

  const migrationTransformations = normalizeMigrationTransformations(
    input.migrationTransformations,
    snapshots,
  );
  const observationBundle = {
    assertions,
    migrationTransformations,
    schemaDiff,
    snapshots,
  };
  const provenance = normalizeProvenance(input.provenance, {
    branches: input.branches,
    candidateCommit: expectedCandidateCommit,
    databaseName: input.databaseName,
    observationBundle,
    projectId: input.projectId,
    schemaDiff,
    snapshots,
    timings,
  }, trustAnchor);

  const targetVersions = plan.map((migration) => migration.version);
  assertBaselineLedger(snapshots.baselineProduction.ledger, targetVersions);
  assertSame(
    snapshots.baselineProduction.ledger,
    snapshots.baselineRecovery.ledger,
    "RECOVERY_BASELINE_LEDGER_MISMATCH",
  );
  assertMigrationDelta(snapshots.baselineRecovery.ledger, snapshots.migratedRecovery.ledger, plan);
  assertSame(
    snapshots.migratedRecovery.ledger,
    snapshots.preservedMigrated.ledger,
    "RECOVERY_PRESERVED_LEDGER_MISMATCH",
  );
  assertSame(
    snapshots.baselineProduction.ledger,
    snapshots.postResetProduction.ledger,
    "RECOVERY_PRODUCTION_LEDGER_CHANGED",
  );
  assertSame(
    snapshots.postResetProduction.ledger,
    snapshots.postResetRecovery.ledger,
    "RECOVERY_POST_RESET_LEDGER_MISMATCH",
  );
  assertExcludedMigrationsAbsent(Object.values(snapshots));

  assertSame(
    snapshots.baselineProduction.tables,
    snapshots.baselineRecovery.tables,
    "RECOVERY_BASELINE_TABLE_FINGERPRINT_MISMATCH",
  );
  assertSame(
    snapshots.migratedRecovery.tables,
    snapshots.preservedMigrated.tables,
    "RECOVERY_PRESERVED_TABLE_FINGERPRINT_MISMATCH",
  );
  assertSame(
    snapshots.postResetProduction.tables,
    snapshots.postResetRecovery.tables,
    "RECOVERY_POST_RESET_TABLE_FINGERPRINT_MISMATCH",
  );
  assertMigrationTableStates(snapshots);

  for (const field of ["catalogInventory", "grantInventory"]) {
    assertSame(
      snapshots.baselineProduction[field],
      snapshots.baselineRecovery[field],
      `RECOVERY_BASELINE_${field.toUpperCase()}_MISMATCH`,
    );
    assertSame(
      snapshots.migratedRecovery[field],
      snapshots.preservedMigrated[field],
      `RECOVERY_PRESERVED_${field.toUpperCase()}_MISMATCH`,
    );
    assertSame(
      snapshots.baselineProduction[field],
      snapshots.postResetProduction[field],
      `RECOVERY_PRODUCTION_${field.toUpperCase()}_CHANGED`,
    );
    assertSame(
      snapshots.postResetProduction[field],
      snapshots.postResetRecovery[field],
      `RECOVERY_POST_RESET_${field.toUpperCase()}_MISMATCH`,
    );
  }
  assertMigratedCatalogAndGrants(snapshots.migratedRecovery, assertions);
  assertMigratedCatalogAndGrants(snapshots.preservedMigrated, assertions);

  const generatedTimestamp = requireIsoTimestamp(generatedAt, "RECOVERY_GENERATED_AT_INVALID");
  invariant(
    generatedTimestamp.epoch >= Date.parse(timings.postResetSnapshotAt),
    "RECOVERY_GENERATED_BEFORE_POST_RESET_SNAPSHOT",
  );
  const generated = generatedTimestamp.value;
  invariant(
    generatedTimestamp.epoch >= Date.parse(schemaDiff.observedAt),
    "RECOVERY_GENERATED_BEFORE_SCHEMA_DIFF",
  );
  if (provenance.queryExecution) {
    invariant(
      generatedTimestamp.epoch >= Date.parse(provenance.queryExecution.executedAt),
      "RECOVERY_GENERATED_BEFORE_QUERY_EXECUTION",
    );
  }
  if (provenance.externalAttestation) {
    const observationEndedAt = Date.parse(
      provenance.externalAttestation.statement.observationWindow.endedAt,
    );
    invariant(
      generatedTimestamp.epoch >= observationEndedAt,
      "RECOVERY_GENERATED_BEFORE_EXTERNAL_OBSERVATION_ENDED",
    );
    invariant(
      generatedTimestamp.epoch - observationEndedAt <= maximumEvidenceFinalizationLagMilliseconds,
      "RECOVERY_EXTERNAL_OBSERVATION_STALE_AT_FINALIZATION",
    );
  }
  const blockers = [];
  if (provenance.status !== "VERIFIED") blockers.push("NEON_PROVENANCE_UNVERIFIED");
  if (schemaDiff.status !== "PASS_EMPTY") blockers.push("SCHEMA_DIFF_UNAVAILABLE");
  const passEligible = blockers.length === 0;
  const evidence = {
    assertions,
    baselineMigrationPlan: recoveryBaselineMigrationPlan,
    blockers,
    branches: { ...input.branches },
    candidateCommit: expectedCandidateCommit,
    comparisons: {
      baselineCatalogAndGrants: "PASS",
      baselineLedgerAndTables: "PASS",
      excludedMigrationsAbsent: "PASS",
      migratedStatePreserved: "PASS",
      postResetCatalogAndGrants: "PASS",
      postResetLedgerAndTables: "PASS",
      targetMigrationDeltaAndChecksums: "PASS",
    },
    databaseName: input.databaseName,
    environment: "RECOVERY_BRANCH_ONLY",
    explicitlyExcludedMigrations: [...excludedRecoveryMigrations],
    generatedAt: generated,
    migrationTransformations,
    migrationPlan: plan,
    migrationPlanContract: recoveryMigrationPlanContract,
    passEligible,
    productionAliasOrEnvironmentChanged: false,
    productionMutationPerformed: false,
    projectId: input.projectId,
    provenance,
    queryPack: {
      sha256: recoveryQueryPackSha256,
      tableCount: recoveryDatabaseQueryPack.tableQueries.length,
      transformationCount: recoveryTransformationTableNames.length,
      version: recoveryQueryPackVersion,
    },
    schemaDiff,
    schemaVersion: 2,
    snapshots,
    status: passEligible ? "PASS" : "BLOCKED",
    timings,
    tool: "scripts/database-recovery-live-evidence.mjs",
    verificationStatus: passEligible ? "VERIFIED" : "UNPROVEN",
  };
  scanForSecretMaterial(evidence);
  return canonicalize(evidence);
}

export function verifyDatabaseRecoveryLiveEvidence({
  evidence,
  expectedCandidateCommit,
  trustAnchor = null,
}) {
  invariant(/^[a-f0-9]{40}$/u.test(expectedCandidateCommit), "RECOVERY_EXPECTED_CANDIDATE_INVALID");
  assertExactKeys(
    evidence,
    [
      "assertions",
      "baselineMigrationPlan",
      "blockers",
      "branches",
      "candidateCommit",
      "comparisons",
      "databaseName",
      "environment",
      "explicitlyExcludedMigrations",
      "generatedAt",
      "migrationTransformations",
      "migrationPlan",
      "migrationPlanContract",
      "passEligible",
      "productionAliasOrEnvironmentChanged",
      "productionMutationPerformed",
      "projectId",
      "provenance",
      "queryPack",
      "schemaDiff",
      "schemaVersion",
      "snapshots",
      "status",
      "timings",
      "tool",
      "verificationStatus",
    ],
    "RECOVERY_LIVE_EVIDENCE",
  );
  invariant(evidence.candidateCommit === expectedCandidateCommit, "RECOVERY_LIVE_EVIDENCE_CANDIDATE_MISMATCH");
  invariant(
    evidence.migrationPlanContract === recoveryMigrationPlanContract,
    "RECOVERY_LIVE_EVIDENCE_PLAN_CONTRACT_INVALID",
  );
  invariant(evidence.schemaVersion === 2, "RECOVERY_LIVE_EVIDENCE_SCHEMA_UNSUPPORTED");
  invariant(evidence.status === "PASS" || evidence.status === "BLOCKED", "RECOVERY_LIVE_EVIDENCE_STATUS_INVALID");
  invariant(typeof evidence.passEligible === "boolean", "RECOVERY_LIVE_EVIDENCE_PASS_ELIGIBILITY_INVALID");
  invariant(Array.isArray(evidence.blockers), "RECOVERY_LIVE_EVIDENCE_BLOCKERS_INVALID");
  invariant(
    (evidence.status === "PASS"
      && evidence.passEligible === true
      && evidence.verificationStatus === "VERIFIED"
      && evidence.blockers.length === 0)
      || (evidence.status === "BLOCKED"
        && evidence.passEligible === false
        && evidence.verificationStatus === "UNPROVEN"
        && evidence.blockers.length > 0),
    "RECOVERY_LIVE_EVIDENCE_PASS_STATE_INCONSISTENT",
  );
  assertSame(
    evidence.baselineMigrationPlan,
    recoveryBaselineMigrationPlan,
    "RECOVERY_LIVE_EVIDENCE_BASELINE_PLAN_INVALID",
  );
  assertExactKeys(
    evidence.queryPack,
    ["sha256", "tableCount", "transformationCount", "version"],
    "RECOVERY_LIVE_EVIDENCE_QUERY_PACK",
  );
  invariant(evidence.queryPack.version === recoveryQueryPackVersion, "RECOVERY_LIVE_EVIDENCE_QUERY_PACK_VERSION_INVALID");
  invariant(evidence.queryPack.sha256 === recoveryQueryPackSha256, "RECOVERY_LIVE_EVIDENCE_QUERY_PACK_DIGEST_INVALID");
  invariant(
    evidence.queryPack.tableCount === recoveryTableQuerySpecs.length
      && evidence.queryPack.transformationCount === recoveryTransformationTableNames.length,
    "RECOVERY_LIVE_EVIDENCE_QUERY_PACK_COUNTS_INVALID",
  );
  invariant(
    evidence.tool === "scripts/database-recovery-live-evidence.mjs",
    "RECOVERY_LIVE_EVIDENCE_TOOL_INVALID",
  );
  assertSame(
    evidence.explicitlyExcludedMigrations,
    excludedRecoveryMigrations,
    "RECOVERY_LIVE_EVIDENCE_EXCLUSIONS_INVALID",
  );
  const snapshots = Object.fromEntries(Object.entries(evidence.snapshots).map(([name, snapshot]) => {
    assertExactKeys(
      snapshot,
      [
        "catalog",
        "catalogInventory",
        "grantInventory",
        "grants",
        "identity",
        "ledger",
        "locks",
        "tables",
      ],
      `RECOVERY_LIVE_EVIDENCE_${name.toUpperCase()}`,
    );
    assertExactKeys(snapshot.catalog, ["entryCount", "sha256"], "RECOVERY_LIVE_EVIDENCE_CATALOG_DIGEST");
    assertExactKeys(snapshot.grants, ["entryCount", "sha256"], "RECOVERY_LIVE_EVIDENCE_GRANT_DIGEST");
    invariant(
      snapshot.catalog.entryCount === snapshot.catalogInventory.length
        && snapshot.catalog.sha256 === sha256(canonicalJson(snapshot.catalogInventory)),
      "RECOVERY_LIVE_EVIDENCE_CATALOG_DIGEST_MISMATCH",
    );
    invariant(
      snapshot.grants.entryCount === snapshot.grantInventory.length
        && snapshot.grants.sha256 === sha256(canonicalJson(snapshot.grantInventory)),
      "RECOVERY_LIVE_EVIDENCE_GRANT_DIGEST_MISMATCH",
    );
    return [name, {
      catalogInventory: snapshot.catalogInventory,
      grantInventory: snapshot.grantInventory,
      identity: snapshot.identity,
      ledger: snapshot.ledger,
      locks: snapshot.locks,
      tables: snapshot.tables,
    }];
  }));
  assertExactKeys(
    evidence.timings,
    [
      "branchCreateStartedAt",
      "branchReadyAt",
      "migrationFinishedAt",
      "migrationStartedAt",
      "observedBranchReadySeconds",
      "observedMigrationSeconds",
      "observedPreserveReadySeconds",
      "observedResetReadySeconds",
      "postResetSnapshotAt",
      "preserveReadyAt",
      "preserveStartedAt",
      "productionSnapshotAt",
      "resetReadyAt",
      "resetSourceProductionAt",
      "resetStartedAt",
    ],
    "RECOVERY_LIVE_EVIDENCE_TIMINGS",
  );
  const inputTimings = Object.fromEntries(
    Object.entries(evidence.timings).filter(([key]) => !key.startsWith("observed")),
  );
  const rebuilt = buildDatabaseRecoveryLiveEvidence({
    expectedCandidateCommit,
    generatedAt: evidence.generatedAt,
    input: {
      action: "FINAL_RECOVERY_READ_ONLY_EVIDENCE",
      assertions: evidence.assertions,
      branches: evidence.branches,
      candidateCommit: evidence.candidateCommit,
      databaseName: evidence.databaseName,
      environment: evidence.environment,
      migrationTransformations: evidence.migrationTransformations,
      productionAliasOrEnvironmentChanged: evidence.productionAliasOrEnvironmentChanged,
      productionMutationPerformed: evidence.productionMutationPerformed,
      projectId: evidence.projectId,
      provenance: evidence.provenance,
      schemaDiff: evidence.schemaDiff,
      schemaVersion: 2,
      snapshots,
      timings: inputTimings,
    },
    migrationPlan: evidence.migrationPlan,
    trustAnchor,
  });
  assertSame(rebuilt, evidence, "RECOVERY_LIVE_EVIDENCE_REBUILD_MISMATCH");
  return Object.freeze({
    candidateCommit: expectedCandidateCommit,
    migrationCount: rebuilt.migrationPlan.length,
    ok: true,
    status: rebuilt.status,
  });
}
