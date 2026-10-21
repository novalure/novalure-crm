/**
 * Explicit Package 4 synthetic recovery drill. Importing this module does no IO.
 * A caller must supply independently verified, newly provisioned QA bindings,
 * connected TLS clients, a new empty restore database, and private storage ports.
 * It never creates/drops a database, changes roles, disables triggers or rewrites SQL.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonical, catalogQueries } from "./lib/studio-stage3-qa-fingerprint.mjs";

// linux/amd64 manifest, resolved from official postgres:18 on 2026-10-20.
// A tag alone is deliberately insufficient for the fallback native clients.
export const package4PostgresClientImage = "postgres@sha256:885953109528ad3dfc90362b1a6f50a78620b5315be19f187753d267e484dc5b";
const hash = value => createHash("sha256").update(value).digest("hex");
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const required = (condition, code) => assert.ok(condition, code);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const systemEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|home|systemroot|windir|temp|tmp|tmpdir|userprofile|localappdata|appdata|comspec|pathext|lang|lc_all)$/iu.test(key)));

export function validatePackage4RestoreBinding(binding) {
  required(binding?.syntheticOnly === true && binding?.newIsolatedResource === true, "EXPLICIT_FRESH_SYNTHETIC_BINDING_REQUIRED");
  required(typeof binding.projectId === "string" && /^[a-z0-9][a-z0-9-]{8,99}$/u.test(binding.projectId), "EXACT_NEON_PROJECT_REQUIRED");
  required(/^br-[a-z0-9-]{8,99}$/u.test(binding.branchId || ""), "EXACT_NEON_BRANCH_REQUIRED");
  required(/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/u.test(binding.host || "") && !binding.host.includes("-pooler."), "EXACT_DIRECT_NEON_ENDPOINT_REQUIRED");
  required(/^[a-z_][a-z0-9_]{0,62}$/u.test(binding.databaseName || "") && binding.owner === "neondb_owner", "EXACT_OWNER_DATABASE_REQUIRED");
  required(Array.isArray(binding.workspaceIds) && binding.workspaceIds.length >= 2 && binding.workspaceIds.every(value => uuid.test(value)) && new Set(binding.workspaceIds).size === binding.workspaceIds.length, "EXPLICIT_SYNTHETIC_WORKSPACE_ALLOWLIST_REQUIRED");
  return binding;
}

export async function assertPackage4RestoreIdentity(client, binding) {
  validatePackage4RestoreBinding(binding);
  const actual = (await client.query(`select current_setting('neon.project_id',true) as project,
    current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role,
    session_user as session_role,(select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as owner`)).rows[0];
  required(actual?.project === binding.projectId && actual.branch === binding.branchId && actual.database === binding.databaseName &&
    actual.role === binding.owner && actual.session_role === binding.owner && actual.owner === binding.owner, "CONNECTED_RESTORE_IDENTITY_MISMATCH");
  return actual;
}

async function privateDirectory(directory, create = false) {
  const base = await realpath(path.resolve(".npm-cache/qa"));
  const absolute = path.resolve(directory);
  const parent = await realpath(path.dirname(absolute));
  required(parent === base || parent.startsWith(base + path.sep), "IGNORED_PRIVATE_QA_DIRECTORY_REQUIRED");
  execFileSync("git", ["check-ignore", "--quiet", absolute], { stdio: "ignore" });
  if (create) {
    try { await lstat(absolute); throw new Error("NEW_PRIVATE_ARTIFACT_DIRECTORY_REQUIRED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(absolute, { mode: 0o700 });
  }
  const info = await lstat(absolute);
  required(info.isDirectory() && !info.isSymbolicLink(), "PRIVATE_DIRECTORY_REQUIRED");
  if (process.platform !== "win32") await chmod(absolute, 0o700);
  return absolute;
}

export const preparePackage4RecoveryDirectory = directory => privateDirectory(directory, true);

/** Stable catalog/ACL/RLS/ledger and every public stored row; no row payload returned. */
export async function snapshotPackage4RecoveryDatabase(client, binding) {
  await client.query("begin isolation level repeatable read read only");
  try {
    await assertPackage4RestoreIdentity(client, binding);
    await client.query("set local search_path=pg_catalog,public");
    await client.query("set local timezone='UTC'");
    const catalog = {};
    for (const [name, sql] of Object.entries(catalogQueries)) catalog[name] = (await client.query(sql)).rows;
    // Do not return secret-valued role settings in an otherwise shareable report.
    for (const role of catalog.roles) if (role.rolconfig) role.rolconfig = role.rolconfig.map(value => ({ name: value.split("=", 1)[0], sha256: hash(value) }));
    required(catalog.extensions.some(extension => extension.extname === "vector"), "GENUINE_PGVECTOR_REQUIRED");
    const workspaces = (await client.query("select id from public.workspaces order by id")).rows.map(row => row.id);
    required(workspaces.length === binding.workspaceIds.length && workspaces.every(id => binding.workspaceIds.includes(id)), "SYNTHETIC_WORKSPACE_ALLOWLIST_MISMATCH");
    const ledger = (await client.query("select version,name,checksum,applied_at from public.novalure_schema_migrations order by version")).rows;
    const data = [];
    for (const table of catalog.tables.filter(table => ["r", "p", "m"].includes(table.relkind))) {
      const rows = (await client.query(`select to_jsonb(t)::text as canonical from public.${identifier(table.relname)} t order by (to_jsonb(t)::text) collate "C" limit 10001`)).rows;
      required(rows.length <= 10000, "SYNTHETIC_TABLE_ROW_BOUND_EXCEEDED");
      const digest = createHash("sha256");
      for (const row of rows) digest.update(row.canonical + "\n");
      data.push({ table: table.relname, rows: rows.length, sha256: digest.digest("hex") });
    }
    required(data.reduce((sum, table) => sum + table.rows, 0) <= 100000, "SYNTHETIC_DATABASE_ROW_BOUND_EXCEEDED");
    const snapshot = { format: "package4-recovery-database-v1", catalog, ledger, data };
    await client.query("rollback");
    return { ...snapshot, sha256: hash(canonical(snapshot)) };
  } catch (error) { await client.query("rollback"); throw error; }
}

async function assertEmptyTarget(client, binding) {
  await assertPackage4RestoreIdentity(client, binding);
  const schemas = (await client.query("select nspname from pg_namespace where nspname !~ '^pg_' and nspname<>'information_schema' order by nspname")).rows;
  const tables = (await client.query("select count(*)::int as count from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p','v','m','S','f')")).rows[0].count;
  const functions = (await client.query("select count(*)::int as count from pg_proc where pronamespace='public'::regnamespace")).rows[0].count;
  const extensions = (await client.query("select extname from pg_extension where extname<>'plpgsql'")).rows;
  required(schemas.length === 1 && schemas[0].nspname === "public" && tables === 0 && functions === 0 && extensions.length === 0, "NEW_EMPTY_RESTORE_DATABASE_REQUIRED");
}

function nativeUri(uri, binding) {
  const parsed = new URL(uri);
  required(["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.hostname === binding.host &&
    parsed.pathname === "/" + binding.databaseName && decodeURIComponent(parsed.username) === binding.owner && parsed.password &&
    (!parsed.port || parsed.port === "5432"), "NATIVE_CLIENT_URI_BINDING_MISMATCH");
  return parsed;
}

function runNative(command, args, environment, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", finished = false;
    const timer = setTimeout(() => { child.kill(); if (!finished) { finished = true; reject(new Error("NATIVE_RECOVERY_TOOL_TIMEOUT")); } }, 180000);
    child.stdout.on("data", chunk => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on("data", chunk => { if (stderr.length < 262144) stderr += chunk; });
    child.once("error", () => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error("NATIVE_RECOVERY_TOOL_START_FAILED")); } });
    child.once("exit", async exitCode => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      try {
        await writeFile(logFile, stderr, { mode: 0o600, flag: "wx" });
        if (exitCode === 0) resolve(stdout); else reject(new Error("NATIVE_RECOVERY_TOOL_EXIT_FAILURE"));
      } catch { reject(new Error("NATIVE_RECOVERY_PRIVATE_LOG_FAILED")); }
    });
  });
}

/** Secrets travel through a private env file or child env, never process argv or logs. */
export async function invokePackage4NativeClient({ tool, action, uri, binding, directory, caFile, pgBin = process.env.CRM_QA_PG_BIN }) {
  required(["pg_dump", "pg_restore"].includes(tool) && ["version", "dump", "restore"].includes(action), "BOUNDED_NATIVE_ACTION_REQUIRED");
  required(action === "version" || (tool === "pg_dump" && action === "dump") || (tool === "pg_restore" && action === "restore"), "NATIVE_ACTION_MISMATCH");
  validatePackage4RestoreBinding(binding);
  directory = await privateDirectory(directory);
  const parsed = nativeUri(uri, binding);
  required(path.dirname(await realpath(caFile)) === directory, "PRIVATE_TRUSTED_CA_FILE_REQUIRED");
  const logFile = path.join(directory, `${tool}-${action}-${Date.now()}.stderr.private.log`);
  const credentials = { PGHOST: binding.host, PGPORT: "5432", PGUSER: binding.owner, PGPASSWORD: decodeURIComponent(parsed.password), PGDATABASE: binding.databaseName,
    PGSSLMODE: "verify-full", PGSSLROOTCERT: caFile, PGCONNECT_TIMEOUT: "20" };
  // Dump/restore never receives --clean, --create, --no-owner or --no-acl.
  const argumentsFor = archive => action === "version" ? ["--version"] : tool === "pg_dump"
    ? ["--no-password", "--format=custom", "--file=" + archive]
    : ["--no-password", "--exit-on-error", "--single-transaction", archive];
  if (pgBin) {
    required(path.isAbsolute(pgBin), "ABSOLUTE_POSTGRESQL18_BIN_REQUIRED");
    return runNative(path.join(pgBin, tool + (process.platform === "win32" ? ".exe" : "")), argumentsFor(path.join(directory, "database.dump")),
      { ...systemEnvironment(), ...credentials }, logFile);
  }
  required(process.platform === "linux" && process.arch === "x64", "PINNED_DOCKER_CLIENT_PLATFORM_UNAVAILABLE");
  const envFile = path.join(directory, `native-${tool}-${action}-${Date.now()}.env.private`);
  credentials.PGSSLROOTCERT = "/qa/" + path.basename(caFile);
  required(Object.values(credentials).every(value => !/[\r\n]/u.test(value)), "NATIVE_ENV_NEWLINE_REJECTED");
  await writeFile(envFile, Object.entries(credentials).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  return runNative("docker", ["run", "--rm", "--platform=linux/amd64", "--user", `${process.getuid()}:${process.getgid()}`,
    "--env-file", envFile, "--mount", `type=bind,src=${directory},dst=/qa`, package4PostgresClientImage, tool, ...argumentsFor("/qa/database.dump")], systemEnvironment(), logFile);
}

/** Source/target storage ports must be separately bound to private QA stores. */
export async function archivePackage4PrivateDocuments({ client, binding, directory, readSource }) {
  await assertPackage4RestoreIdentity(client, binding);
  const rows = (await client.query(`select distinct m.id,m.workspace_id,m.relative_path,m.mime_type,m.size_bytes::text,
      m.storage_provider,m.storage_access,m.is_public,m.public_token
    from public.media_assets m join public.knowledge_source_versions v on v.media_asset_id=m.id
    order by m.id`)).rows;
  required(rows.length > 0 && rows.length <= 100, "BOUNDED_NONEMPTY_DOCUMENT_FIXTURE_REQUIRED");
  const files = [];
  for (const asset of rows) {
    required(binding.workspaceIds.includes(asset.workspace_id) && uuid.test(asset.id) && asset.storage_provider === "vercel-blob" &&
      asset.storage_access === "private" && !asset.is_public && asset.public_token === null, "PRIVATE_QA_DOCUMENT_REQUIRED");
    required(asset.relative_path === path.posix.normalize(asset.relative_path) && asset.relative_path.startsWith(asset.workspace_id + "/") && !asset.relative_path.includes("\0"), "IMMUTABLE_TENANT_OBJECT_KEY_REQUIRED");
    const bytes = Buffer.from(await readSource(asset));
    required(bytes.length === Number(asset.size_bytes) && bytes.length > 0 && bytes.length <= 10 * 1024 * 1024, "PRIVATE_DOCUMENT_SIZE_MISMATCH");
    const archiveName = `${asset.id}.document.private`;
    await writeFile(path.join(directory, archiveName), bytes, { mode: 0o600, flag: "wx" });
    files.push({ assetId: asset.id, workspaceId: asset.workspace_id, pathname: asset.relative_path, mimeType: asset.mime_type,
      bytes: bytes.length, sha256: hash(bytes), archiveName });
  }
  const versions = (await client.query(`select v.id,v.source_id,v.workspace_id,v.media_asset_id,v.status,
    s.draft_version_id,s.approved_version_id from public.knowledge_source_versions v
    join public.knowledge_sources s on s.id=v.source_id and s.workspace_id=v.workspace_id
    where v.media_asset_id is not null order by v.id`)).rows;
  return { format: "package4-private-document-archive-v1", files, versionBindingsSha256: hash(canonical(versions)) };
}

/**
 * Complete post-commit recovery into an independently created empty database and
 * private store. The app callback must use ordinary runtime rights and the exact
 * compatible implementation revision; the caller records its actual checks.
 */
export async function restorePackage4SyntheticRecovery({ source, target, sourceBinding, targetBinding, sourceUri, targetUri,
  artifactDirectory, trustedCa, readSourceDocument, writeTargetDocument, readTargetDocument, assertEmptyTargetStorage,
  verifyRestoredApplication, saveEvidence, implementationRevision, storageBinding, pgBin }) {
  validatePackage4RestoreBinding(sourceBinding); validatePackage4RestoreBinding(targetBinding);
  required(sourceBinding.projectId === targetBinding.projectId && sourceBinding.branchId === targetBinding.branchId &&
    sourceBinding.databaseName !== targetBinding.databaseName && /^package4_restore_[a-z0-9_]+$/u.test(targetBinding.databaseName) &&
    canonical([...sourceBinding.workspaceIds].sort()) === canonical([...targetBinding.workspaceIds].sort()), "ISOLATED_SAME_BRANCH_SEPARATE_RESTORE_DATABASE_REQUIRED");
  required(storageBinding?.syntheticOnly === true && storageBinding.access === "private" &&
    /^[a-z0-9_-]{5,100}$/iu.test(storageBinding.sourceStoreId || "") && /^[a-z0-9_-]{5,100}$/iu.test(storageBinding.targetStoreId || "") &&
    storageBinding.sourceStoreId !== storageBinding.targetStoreId, "TWO_EXACT_PRIVATE_QA_STORAGE_BINDINGS_REQUIRED");
  required(/^[a-f0-9]{40}$/u.test(implementationRevision || ""), "EXACT_COMPATIBLE_APPLICATION_REVISION_REQUIRED");
  required([readSourceDocument, writeTargetDocument, readTargetDocument, assertEmptyTargetStorage, verifyRestoredApplication, saveEvidence].every(fn => typeof fn === "function"), "EXPLICIT_RECOVERY_PORTS_REQUIRED");
  const directory = await privateDirectory(artifactDirectory, true);
  const evidence = { format: "package4-neon-synthetic-recovery-v1", status: "RUNNING", implementationRevision,
    source: sourceBinding, target: targetBinding, storage: storageBinding, productionAccess: 0, sourceWrites: 0, startedAt: new Date().toISOString(),
    limitations: ["Same isolated Neon branch; global roles already exist. No cross-cluster role or production disaster-recovery guarantee.",
      "Native complete database restore plus explicit private-object byte restore. Application rollback requires a separately verified schema-compatible revision."] };
  await saveEvidence(evidence);
  const started = performance.now();
  try {
    await assertPackage4RestoreIdentity(source, sourceBinding); await assertEmptyTarget(target, targetBinding);
    const emptyStorage = await assertEmptyTargetStorage();
    required(emptyStorage?.storeId === storageBinding.targetStoreId && emptyStorage?.access === "private" && emptyStorage?.objects === 0, "EXACT_EMPTY_PRIVATE_RESTORE_STORE_REQUIRED");
    const before = await snapshotPackage4RecoveryDatabase(source, sourceBinding);
    const caFile = path.join(directory, "trusted-ca.pem");
    await writeFile(caFile, trustedCa, { mode: 0o600, flag: "wx" });
    const native = (tool, action, binding, uri) => invokePackage4NativeClient({ tool, action, binding, uri, directory, caFile, pgBin });
    evidence.nativeClients = { dump: (await native("pg_dump", "version", sourceBinding, sourceUri)).trim(), restore: (await native("pg_restore", "version", targetBinding, targetUri)).trim() };
    required(/^pg_dump \(PostgreSQL\) 18\./u.test(evidence.nativeClients.dump) && /^pg_restore \(PostgreSQL\) 18\./u.test(evidence.nativeClients.restore), "POSTGRESQL18_NATIVE_CLIENTS_REQUIRED");
    const documents = await archivePackage4PrivateDocuments({ client: source, binding: sourceBinding, directory, readSource: readSourceDocument });
    await native("pg_dump", "dump", sourceBinding, sourceUri);
    if (process.platform !== "win32") await chmod(path.join(directory, "database.dump"), 0o600);
    const dumpBytes = await readFile(path.join(directory, "database.dump"));
    evidence.archive = { bytes: dumpBytes.length, sha256: hash(dumpBytes), format: "native-pg-custom" };
    required((await snapshotPackage4RecoveryDatabase(source, sourceBinding)).sha256 === before.sha256, "SOURCE_CHANGED_DURING_ARCHIVE");
    // pg_dump does not pin extension versions. Install only the actual source's
    // two known extension names at its exact versions before native restore.
    const extensions = before.catalog.extensions.filter(row => row.extname !== "plpgsql");
    required(extensions.length === 2 && extensions.every(row => ["vector", "pgcrypto"].includes(row.extname) && row.schema === "public" && /^[a-z0-9.]+$/u.test(row.extversion)), "UNREVIEWED_EXTENSION_PROFILE");
    await assertEmptyTarget(target, targetBinding);
    await target.query("begin");
    try {
      for (const extension of extensions) await target.query(`create extension ${identifier(extension.extname)} with schema public version '${extension.extversion}'`);
      await target.query("commit");
    } catch (error) { await target.query("rollback"); throw error; }
    await native("pg_restore", "restore", targetBinding, targetUri);
    const after = await snapshotPackage4RecoveryDatabase(target, targetBinding);
    required(after.sha256 === before.sha256, "RESTORED_SCHEMA_LEDGER_DATA_ACL_MISMATCH");
    for (const file of documents.files) {
      const bytes = await readFile(path.join(directory, file.archiveName));
      required(hash(bytes) === file.sha256 && bytes.length === file.bytes, "PRIVATE_ARCHIVE_BYTES_CHANGED");
      const receipt = await writeTargetDocument(file, bytes);
      required(receipt?.pathname === file.pathname && receipt?.access === "private" && receipt?.storeId === storageBinding.targetStoreId, "PRIVATE_RESTORE_OBJECT_KEY_CHANGED");
      const restoredBytes = Buffer.from(await readTargetDocument(file));
      required(restoredBytes.length === file.bytes && hash(restoredBytes) === file.sha256, "RESTORED_PRIVATE_DOCUMENT_MISMATCH");
    }
    evidence.recoveryPoint = { at: evidence.startedAt, schemaLedgerDataSha256: before.sha256, documents: documents.files.length,
      privateDocumentManifestSha256: hash(canonical(documents)), preservedVersionBindingsSha256: documents.versionBindingsSha256 };
    evidence.application = await verifyRestoredApplication({ targetBinding, implementationRevision, documents });
    required(evidence.application?.status === "PASS", "RESTORED_COMPATIBLE_APPLICATION_NOT_VERIFIED");
    required((await snapshotPackage4RecoveryDatabase(source, sourceBinding)).sha256 === before.sha256, "SOURCE_CHANGED_DURING_RECOVERY");
    evidence.elapsedMs = Math.round(performance.now() - started);
    evidence.completedAt = new Date().toISOString(); evidence.status = "PASS";
    await saveEvidence(evidence); return evidence;
  } catch (error) {
    evidence.status = "FAIL"; evidence.elapsedMs = Math.round(performance.now() - started);
    evidence.failureCode = /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.message || "") ? error.message : "PACKAGE4_SYNTHETIC_RECOVERY_FAILED";
    await saveEvidence(evidence); throw new Error(evidence.failureCode);
  }
}
