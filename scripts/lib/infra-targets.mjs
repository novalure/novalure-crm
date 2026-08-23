// Expected target declarations are intentionally resolved only inside the exported
// functions so callers can load their selected env file before verification.
const targetDefinitions = Object.freeze({
  prod: Object.freeze({
    branchIdKey: "NOVALURE_PRODUCTION_BRANCH_ID",
    databaseNameKey: "NOVALURE_PRODUCTION_DATABASE_NAME",
    hostKey: "NOVALURE_PRODUCTION_DATABASE_HOST",
    migrationHostKey: "NOVALURE_PRODUCTION_MIGRATION_DATABASE_HOST",
    migrationRoleNameKey: "NOVALURE_PRODUCTION_MIGRATION_DATABASE_ROLE",
    projectFingerprintKey: "NOVALURE_PRODUCTION_PROJECT_FINGERPRINT",
    projectIdKey: "NOVALURE_PRODUCTION_PROJECT_ID",
    roleNameKey: "NOVALURE_PRODUCTION_DATABASE_ROLE",
  }),
  recovery: Object.freeze({
    branchIdKey: "NOVALURE_RECOVERY_BRANCH_ID",
    databaseNameKey: "NOVALURE_RECOVERY_DATABASE_NAME",
    hostKey: "NOVALURE_RECOVERY_DATABASE_HOST",
    migrationHostKey: "NOVALURE_RECOVERY_MIGRATION_DATABASE_HOST",
    migrationRoleNameKey: "NOVALURE_RECOVERY_MIGRATION_DATABASE_ROLE",
    projectFingerprintKey: "NOVALURE_RECOVERY_PROJECT_FINGERPRINT",
    projectIdKey: "NOVALURE_RECOVERY_PROJECT_ID",
    roleNameKey: "NOVALURE_RECOVERY_DATABASE_ROLE",
  }),
  test: Object.freeze({
    branchIdKey: "NOVALURE_QA_BRANCH_ID",
    databaseNameKey: "NOVALURE_QA_DATABASE_NAME",
    hostKey: "NOVALURE_QA_DATABASE_HOST",
    migrationHostKey: "NOVALURE_QA_MIGRATION_DATABASE_HOST",
    migrationRoleNameKey: "NOVALURE_QA_MIGRATION_DATABASE_ROLE",
    projectFingerprintKey: "NOVALURE_QA_PROJECT_FINGERPRINT",
    projectIdKey: "NOVALURE_QA_PROJECT_ID",
    roleNameKey: "NOVALURE_QA_DATABASE_ROLE",
  }),
});

function readConfiguredValue(env, key) {
  const value = env?.[key] ?? process.env[key];
  return typeof value === "string" ? value.trim() : "";
}

function requireTargetDefinition(target) {
  const definition = targetDefinitions[target];
  if (!definition) {
    throw new Error("Database target must be explicitly set to 'test', 'recovery', or 'prod'.");
  }
  return definition;
}

function assertRecoveryTargetDeclaration(env, connectionMode, expectedProject) {
  if (!expectedProject.exact) {
    throw new Error("Recovery requires an exact NOVALURE_RECOVERY_PROJECT_ID.");
  }
  const productionProjectId = readConfiguredValue(env, "NOVALURE_PRODUCTION_PROJECT_ID");
  if (!productionProjectId || productionProjectId !== expectedProject.value) {
    throw new Error("Recovery must use the exact declared Production Neon project.");
  }
  const recoveryBranchId = readConfiguredValue(env, "NOVALURE_RECOVERY_BRANCH_ID");
  const productionBranchId = readConfiguredValue(env, "NOVALURE_PRODUCTION_BRANCH_ID");
  if (!/^br-[A-Za-z0-9-]{8,128}$/.test(recoveryBranchId)) {
    throw new Error("NOVALURE_RECOVERY_BRANCH_ID must identify one explicit Neon child branch.");
  }
  if (!/^br-[A-Za-z0-9-]{8,128}$/.test(productionBranchId)) {
    throw new Error("NOVALURE_PRODUCTION_BRANCH_ID is required for the Recovery boundary.");
  }
  if (recoveryBranchId === productionBranchId) {
    throw new Error("Recovery branch must differ from Production Main.");
  }

  for (const target of ["prod", "test"]) {
    const definition = targetDefinitions[target];
    const key = connectionMode === "direct" ? definition.migrationHostKey : definition.hostKey;
    if (!readConfiguredValue(env, key)) {
      throw new Error(`${key} is required for Recovery host separation.`);
    }
  }
}

function normalizeExpectedHost(value, key, connectionMode) {
  const host = value.toLowerCase();
  const hostPattern = connectionMode === "direct"
    ? /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/
    : /^[a-z0-9-]+-pooler(?:\.[a-z0-9-]+)+\.neon\.tech$/;
  if (
    !host ||
    host.includes("://") ||
    host.includes("/") ||
    host.includes(":") ||
    !hostPattern.test(host) ||
    (connectionMode === "direct" && host.includes("-pooler.")) ||
    host !== new URL(`postgresql://guard@${host}/database`).hostname.toLowerCase()
  ) {
    throw new Error(
      `${key} must contain one bare ${connectionMode === "direct" ? "direct" : "pooled"} Neon database hostname.`,
    );
  }
  return host;
}

function resolveExpectedProject(definition, env) {
  const exactProjectId = readConfiguredValue(env, definition.projectIdKey);
  const fingerprint = readConfiguredValue(env, definition.projectFingerprintKey);

  if (exactProjectId && fingerprint) {
    throw new Error(
      `Configure only one of ${definition.projectIdKey} or ${definition.projectFingerprintKey}.`,
    );
  }

  const value = exactProjectId || fingerprint;
  const key = exactProjectId ? definition.projectIdKey : definition.projectFingerprintKey;
  if (!value) {
    throw new Error(
      `${definition.projectIdKey} or ${definition.projectFingerprintKey} is required; database access is fail-closed.`,
    );
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error(`${key} must be an 8-128 character project identifier or fingerprint.`);
  }

  return { exact: Boolean(exactProjectId), key, value };
}

export function resolveDatabaseTarget(target, env = process.env, connectionMode = "pooled") {
  const definition = requireTargetDefinition(target);
  if (connectionMode !== "pooled" && connectionMode !== "direct") {
    throw new Error("Database connection mode must be 'pooled' or 'direct'.");
  }
  const hostKey = connectionMode === "direct" ? definition.migrationHostKey : definition.hostKey;
  const expectedHostValue = readConfiguredValue(env, hostKey);
  if (!expectedHostValue) {
    throw new Error(`${hostKey} is required; database access is fail-closed.`);
  }

  const expectedHost = normalizeExpectedHost(expectedHostValue, hostKey, connectionMode);
  const expectedProject = resolveExpectedProject(definition, env);
  if (target === "recovery") {
    assertRecoveryTargetDeclaration(env, connectionMode, expectedProject);
  }
  for (const [otherTarget, otherDefinition] of Object.entries(targetDefinitions)) {
    if (otherTarget === target) continue;
    const otherHostKey = connectionMode === "direct"
      ? otherDefinition.migrationHostKey
      : otherDefinition.hostKey;
    const otherHostValue = readConfiguredValue(env, otherHostKey);
    if (
      otherHostValue &&
      normalizeExpectedHost(otherHostValue, otherHostKey, connectionMode) === expectedHost
    ) {
      throw new Error("Database target hosts must be different.");
    }
  }

  return Object.freeze({ connectionMode, expectedHost, expectedProject, target });
}

function assertResolvedDatabaseHost(databaseUrl, purpose, resolved) {
  let parsed;

  try {
    parsed = new URL(String(databaseUrl ?? "").trim());
  } catch {
    throw new Error(`Refusing ${purpose}: database URL is missing or invalid.`);
  }

  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error(`Refusing ${purpose}: database URL must use PostgreSQL.`);
  }

  const activeHost = parsed.hostname.toLowerCase();
  if (activeHost !== resolved.expectedHost) {
    throw new Error(
      `Refusing ${purpose}: active database host does not match the declared ${resolved.target} target.`,
    );
  }

  return activeHost;
}

export function assertDatabaseHost({
  connectionMode = "pooled",
  databaseUrl,
  env = process.env,
  purpose = "database access",
  target,
}) {
  const resolved = resolveDatabaseTarget(target, env, connectionMode);
  const host = assertResolvedDatabaseHost(databaseUrl, purpose, resolved);
  return Object.freeze({ host, target });
}

export function assertDatabaseTarget({
  connectionMode = "pooled",
  databaseUrl,
  env = process.env,
  projectId,
  purpose = "database access",
  target,
}) {
  const resolved = resolveDatabaseTarget(target, env, connectionMode);
  const host = assertResolvedDatabaseHost(databaseUrl, purpose, resolved);

  const configuredProjectId =
    projectId ??
    env?.POSTGRES_NEON_PROJECT_ID ??
    env?.NEON_PROJECT_ID ??
    process.env.POSTGRES_NEON_PROJECT_ID ??
    process.env.NEON_PROJECT_ID ??
    "";
  const activeProjectId = String(configuredProjectId).trim();
  if (!activeProjectId) {
    throw new Error(`Refusing ${purpose}: active Neon project identity is missing.`);
  }

  const matchesProject = resolved.expectedProject.exact
    ? activeProjectId === resolved.expectedProject.value
    : activeProjectId.includes(resolved.expectedProject.value);
  if (!matchesProject) {
    throw new Error(`Refusing ${purpose}: active Neon project does not match the declared ${target} target.`);
  }

  return Object.freeze({ host, projectId: activeProjectId, target });
}

function requireConnectedIdentityValue(env, key) {
  const value = readConfiguredValue(env, key);
  if (!value) {
    throw new Error(`${key} is required; connected database verification is fail-closed.`);
  }
  if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${key} contains an invalid database identity value.`);
  }
  return value;
}

export function validateConnectedDatabaseTarget({
  actual,
  connectionMode = "pooled",
  env = process.env,
  minimumServerVersionNum = 0,
  target,
}) {
  const definition = requireTargetDefinition(target);
  if (connectionMode !== "pooled" && connectionMode !== "direct") {
    throw new Error("Database connection mode must be 'pooled' or 'direct'.");
  }
  const expectedProject = resolveExpectedProject(definition, env);
  if (target === "recovery") {
    assertRecoveryTargetDeclaration(env, connectionMode, expectedProject);
  }
  const roleNameKey = connectionMode === "direct"
    ? definition.migrationRoleNameKey
    : definition.roleNameKey;
  const expected = {
    branchId: requireConnectedIdentityValue(env, definition.branchIdKey),
    databaseName: requireConnectedIdentityValue(env, definition.databaseNameKey),
    roleName: requireConnectedIdentityValue(env, roleNameKey),
  };
  if (connectionMode === "direct") {
    const appRoleName = requireConnectedIdentityValue(env, definition.roleNameKey);
    if (expected.roleName === appRoleName) {
      throw new Error("Migration database role must differ from the pooled application role.");
    }
  }
  const projectId = String(actual?.projectId ?? "").trim();
  const serverVersionNum = Number(actual?.serverVersionNum ?? 0);
  const matchesProject = expectedProject.exact
    ? projectId === expectedProject.value
    : projectId.includes(expectedProject.value);

  if (
    !matchesProject ||
    String(actual?.branchId ?? "") !== expected.branchId ||
    String(actual?.databaseName ?? "") !== expected.databaseName ||
    String(actual?.roleName ?? "") !== expected.roleName
  ) {
    throw new Error(`Connected database fingerprint does not match the declared ${target} target.`);
  }
  if (
    !Number.isSafeInteger(serverVersionNum) ||
    serverVersionNum < minimumServerVersionNum
  ) {
    throw new Error("Connected PostgreSQL version does not meet the migration-runner requirement.");
  }

  return Object.freeze({
    branchId: expected.branchId,
    databaseName: expected.databaseName,
    projectId,
    roleName: expected.roleName,
    serverVersionNum,
    target,
  });
}

export async function assertConnectedDatabaseTarget({
  client,
  connectionMode = "pooled",
  env = process.env,
  minimumServerVersionNum = 0,
  purpose = "database access",
  target,
}) {
  if (!client || typeof client.query !== "function") {
    throw new Error(`Refusing ${purpose}: a connected PostgreSQL client is required.`);
  }

  const result = await client.query({
    query_timeout: 15_000,
    text: `
      select
        current_setting('neon.project_id', true) as "projectId",
        current_setting('neon.branch_id', true) as "branchId",
        current_setting('server_version_num') as "serverVersionNum",
        current_database() as "databaseName",
        current_user as "roleName"
    `,
  });
  const actual = result?.rows?.[0];
  if (!actual) {
    throw new Error(`Refusing ${purpose}: connected database identity is unavailable.`);
  }
  return validateConnectedDatabaseTarget({
    actual,
    connectionMode,
    env,
    minimumServerVersionNum,
    target,
  });
}
