/** Trusted synthetic provisioning only. No sessions, MFA material, grants or provider activation. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword } from "../src/lib/auth/passwords.ts";

export const package4SeedTarget = Object.freeze({ projectId: "green-thunder-49879900", branchId: "br-shiny-darkness-baz4524v",
  host: "ep-steep-shadow-bapfxomh.c-8.eu-central-1.aws.neon.tech", databaseName: "neondb", owner: "neondb_owner" });
const studioWorkspace = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const studioProject = "f7d83c6b-d08d-4d73-b822-1f1c0b4733d2";
const marker = "package4-hosted-20261020-v1";
const keys = { operator: "PACKAGE4_OPERATOR", customerA: "PACKAGE4_CUSTOMER_A", customerB: "PACKAGE4_CUSTOMER_B", viewer: "PACKAGE4_VIEWER", projectMember: "PACKAGE4_PROJECT_MEMBER" };
const required = (condition, message) => assert.ok(condition, message);

async function identity(client) {
  const row = (await client.query(`select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,
    current_database() as database,current_user as role,session_user as session_role,
    (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as owner`)).rows[0];
  assert.deepEqual(row, { project: package4SeedTarget.projectId, branch: package4SeedTarget.branchId, database: "neondb",
    role: "neondb_owner", session_role: "neondb_owner", owner: "neondb_owner" }, "Exact new isolated owner target required");
}

async function privateOutput(filename) {
  const root = await realpath(path.resolve(".npm-cache/qa"));
  const absolute = path.resolve(filename), parent = await realpath(path.dirname(absolute));
  required(parent === root || parent.startsWith(root + path.sep), "Seed outputs must remain in ignored private QA directory");
  execFileSync("git", ["check-ignore", "--quiet", absolute], { stdio: "ignore" });
  try { await lstat(absolute); throw new Error("Seed output already exists; never overwrite credentials or a previous run"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await chmod(parent, 0o700);
  return absolute;
}

/** owner is one transaction-capable checked-out client, not an autocommit pool adapter. */
export async function seedPackage4Neon({ owner, targetTemplate, implementationRevision, credentialsFile, manifestFile, evidenceFile }) {
  required(/^[a-f0-9]{40}$/u.test(implementationRevision || ""), "Exact implementation revision required");
  required(targetTemplate?.schema === "novalure.package4.hosted-target.v1" && targetTemplate.syntheticOnly === true && targetTemplate.target === "preview", "Synthetic Preview target template required");
  const outputs = { credentials: await privateOutput(credentialsFile), manifest: await privateOutput(manifestFile), evidence: await privateOutput(evidenceFile) };
  required(new Set(Object.values(outputs)).size === 3, "Three separate new seed outputs required");
  const accounts = {};
  const passwords = {};
  for (const key of Object.keys(keys)) {
    const userId = randomUUID();
    accounts[key] = { userId, workspaceId: randomUUID(), name: `SYNTHETIC PACKAGE4 ${key}`, email: `package4-${key.toLowerCase()}-${userId}@example.invalid`, credentialKey: keys[key],
      requiresMfa: !["viewer", "projectMember"].includes(key) };
    const password = randomBytes(32).toString("base64url");
    passwords[key] = { password, hash: await hashPassword(password) };
  }
  accounts.viewer.workspaceId = accounts.customerA.workspaceId;
  accounts.projectMember.workspaceId = accounts.customerA.workspaceId;
  let committed = false;
  const written = [];
  const evidence = { format: "package4-neon-synthetic-seed-v1", status: "RUNNING", implementationRevision,
    target: package4SeedTarget, marker, productionAccess: 0, providerActivations: 0, grantChanges: 0,
    seededSessions: 0, seededMfaSecrets: 0, startedAt: new Date().toISOString() };
  try {
    await owner.query("begin");
    await owner.query("set local search_path=pg_catalog,public");
    await owner.query("set local timezone='UTC'");
    await identity(owner);
    await owner.query("select pg_advisory_xact_lock(941407)");
    required((await owner.query("select count(*)::int as count from public.workspaces where id<>$1 or setup_state->>'package4HostedSeed'=$2", [studioWorkspace, marker])).rows[0].count === 0, "Only the original migration workspace may precede this fresh fixture");
    required((await owner.query("select count(*)::int as count from public.projects where id=$1 and workspace_id=$2", [studioProject, studioWorkspace])).rows[0].count === 1, "Original canonical Studio project required");
    required((await owner.query("select count(*)::int as count from public.workspace_users where email like 'package4-%@example.invalid' or name like 'SYNTHETIC PACKAGE4%' ")).rows[0].count === 0, "Fresh package4 accounts required; duplicate seeding refused");
    required((await owner.query("select count(*)::int as count from public.novalure_schema_migrations")).rows[0].count === 60, "Accepted 60-row migration ledger required");
    required((await owner.query("select count(*)::int as count from public.novalure_schema_migrations where version='106_crm_operational_readers'")).rows[0].count === 1, "Combined through106 schema required");
    const providerCounts = async () => (await owner.query("select (select count(*) from public.crm_service_principals)::int as principals,(select count(*) from public.knowledge_assistant_service_bindings)::int as assistant_bindings,(select count(*) from public.provider_connections)::int as providers")).rows[0];
    const providersBefore = await providerCounts();
    const addWorkspace = async (account, operatingModel) => {
      account.workspaceName = `SYNTHETIC PACKAGE4 ${account === accounts.operator ? "INTERNAL" : account === accounts.customerA ? "CUSTOMER A" : "CUSTOMER B"}`;
      await owner.query("insert into public.workspaces(id,name,operating_model,customer_type,setup_state) values($1,$2,$3,$4,$5::jsonb)",
        [account.workspaceId, account.workspaceName, operatingModel, operatingModel === "novalure_internal" ? "novalure_internal" : "property_developer", JSON.stringify({ syntheticQa: true, package4HostedSeed: marker })]);
    };
    for (const key of ["operator", "customerA", "customerB"]) await addWorkspace(accounts[key], key === "operator" ? "novalure_internal" : "self_service_customer");
    const addMembership = async (account, role, productRole) => {
      const result = await owner.query("insert into public.workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,$3,$4,$5,$6,'active',now()) returning auth_identity_id", [account.userId, account.workspaceId, account.name, account.email, role, productRole]);
      account.authIdentityId = result.rows[0].auth_identity_id;
      account.role = role; account.productRole = productRole;
    };
    for (const [key, role, productRole] of [["operator", "owner", "novalureAdmin"], ["customerA", "owner", "customer_owner"], ["customerB", "owner", "customer_owner"], ["viewer", "assistant", "viewer"], ["projectMember", "agent", "project_sales_member"]]) {
      await addMembership(accounts[key], role, productRole);
      await owner.query("update public.auth_identities set credential_state='active',password_hash=$2,password_changed_at=now() where id=$1", [accounts[key].authIdentityId, passwords[key].hash]);
    }
    const operatorMemberships = [];
    for (const [workspaceId, productRole] of [[accounts.customerA.workspaceId, "customer_owner"], [studioWorkspace, "novalureAdmin"]]) {
      const userId = randomUUID();
      const result = await owner.query("insert into public.workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,'SYNTHETIC PACKAGE4 scoped operator',$3,'owner',$4,'active',now()) returning auth_identity_id", [userId, workspaceId, accounts.operator.email, productRole]);
      assert.equal(result.rows[0].auth_identity_id, accounts.operator.authIdentityId, "Scoped operator memberships must share its native identity");
      operatorMemberships.push({ userId, workspaceId, productRole });
    }
    const addProject = async (account, operatingModel) => {
      account.projectId = randomUUID();
      await owner.query("insert into public.projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,$3,'Bauträger','property_developer',$4)", [account.projectId, account.workspaceId, `${account.workspaceName} PROJECT`, operatingModel]);
    };
    await addProject(accounts.operator, "novalure_internal");
    await addProject(accounts.customerA, "self_service_customer");
    await addProject(accounts.customerB, "self_service_customer");
    for (const key of ["customerA", "customerB"]) {
      const account = accounts[key];
      account.botId = randomUUID(); account.unitId = randomUUID(); account.contactId = randomUUID(); account.buildingId = randomUUID();
      await owner.query("insert into public.contacts(id,workspace_id,project_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,$6,'Käufer')", [account.contactId, account.workspaceId, account.projectId, account.userId,
        key === "customerB" ? "SYNTHETIC PACKAGE4 FOREIGN PRIVATE SENTINEL" : "SYNTHETIC PACKAGE4 CUSTOMER CONTACT", `contact-${account.contactId}@example.invalid`]);
      await owner.query("insert into public.property_buildings(id,workspace_id,project_id,name) values($1,$2,$3,'SYNTHETIC PACKAGE4 BUILDING')", [account.buildingId, account.workspaceId, account.projectId]);
      await owner.query("insert into public.property_units(id,workspace_id,project_id,building_id,unit_number,rooms,area_sqm,price_cents,status) values($1,$2,$3,$4,$5,3,82,49200000,'available')", [account.unitId, account.workspaceId, account.projectId, account.buildingId, key === "customerA" ? "SYNTHETIC-P4-A-01" : "SYNTHETIC-P4-FOREIGN-01"]);
      await owner.query("insert into public.bots(id,workspace_id,project_id,name,role,status) values($1,$2,$3,$4,'advisor','Entwurf')", [account.botId, account.workspaceId, account.projectId, `${account.workspaceName} ASSISTANT`]);
      await owner.query("insert into public.company_profiles(profile_scope,workspace_id,legal_name,display_name,country_code,public_email) values('workspace_owner',$1,$2,$2,'AT',$3)", [account.workspaceId, `${account.workspaceName} COMPANY`, `company-${account.workspaceId}@example.invalid`]);
      await owner.query("insert into public.workspace_module_settings(workspace_id,module_key,enabled,reason,metadata) values($1,'bots',true,'SYNTHETIC bounded QA fixture',$2::jsonb),($1,'knowledge',true,'SYNTHETIC bounded QA fixture',$2::jsonb)", [account.workspaceId, JSON.stringify({ package4HostedSeed: marker, syntheticQa: true })]);
      await owner.query(`insert into public.knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,features,limits,monitoring_intervals)
        values($1,true,20,67108864,$2,$3,$4::jsonb,$5::jsonb,$6::text[])`, [account.workspaceId, key === "customerA" ? 200 : 1, `SYNTHETIC-NONCOMMERCIAL-${marker}-${key}`,
        JSON.stringify({ websiteImport: true, monitoring: true, advancedMaintenance: true, webchatAccess: true, voiceAccess: key === "customerA" }),
        JSON.stringify({ maxAreas: 10, maxWebsites: 5, maxScansPerMonth: 10, maxUsers: 10, maxAssistants: 5 }), ["manual", "daily", "weekly", "monthly"]]);
    }
    // SQL forbids an enabled zero-query contract. Exhaust B's one-query contract
    // in the current UTC month so its remaining allowance is correctly zero.
    await owner.query("insert into public.knowledge_query_usage(workspace_id,month,query_count) values($1,date_trunc('month',now() at time zone 'UTC')::date,1)", [accounts.customerB.workspaceId]);
    const hiddenProjectId = randomUUID(), hiddenUnitId = randomUUID();
    await owner.query("insert into public.projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,'SYNTHETIC PACKAGE4 HIDDEN PROJECT','Bauträger','property_developer','self_service_customer')", [hiddenProjectId, accounts.customerA.workspaceId]);
    await owner.query("insert into public.property_units(id,workspace_id,project_id,unit_number,status) values($1,$2,$3,'SYNTHETIC-P4-HIDDEN-01','available')", [hiddenUnitId, accounts.customerA.workspaceId, hiddenProjectId]);
    for (const key of ["viewer", "projectMember"]) {
      const account = accounts[key]; account.projectId = accounts.customerA.projectId; account.workspaceName = accounts.customerA.workspaceName;
      await owner.query("insert into public.project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,$4)", [account.workspaceId, account.projectId, account.userId, key === "projectMember"]);
    }
    const internalTaskId = randomUUID();
    await owner.query("insert into public.tasks(id,workspace_id,project_id,owner_user_id,title,metadata) values($1,$2,$3,$4,'SYNTHETIC PACKAGE4 INTERNAL TASK',$5::jsonb)", [internalTaskId, accounts.operator.workspaceId, accounts.operator.projectId, accounts.operator.userId, JSON.stringify({ syntheticQa: true, package4HostedSeed: marker })]);
    const taskId = randomUUID(), taskTitle = "SYNTHETIC PACKAGE4 RECOVERY TASK ORIGINAL";
    await owner.query("insert into public.tasks(id,workspace_id,project_id,owner_user_id,title,metadata) values($1,$2,$3,$4,$5,$6::jsonb)", [taskId, accounts.customerA.workspaceId, accounts.customerA.projectId, accounts.customerA.userId, taskTitle, JSON.stringify({ syntheticQa: true, package4HostedSeed: marker })]);
    const identityIds = Object.values(accounts).map(account => account.authIdentityId);
    const authState = (await owner.query(`select
      (select count(*)::int from public.auth_sessions where auth_identity_id=any($1::uuid[])) as sessions,
      (select count(*)::int from public.auth_login_challenges where auth_identity_id=any($1::uuid[])) as challenges,
      (select count(*)::int from public.auth_mfa_recovery_codes where auth_identity_id=any($1::uuid[])) as recovery_codes,
      (select count(*)::int from public.auth_identities where id=any($1::uuid[]) and (mfa_enabled_at is not null or mfa_secret_ciphertext is not null)) as mfa_identities`, [identityIds])).rows[0];
    assert.deepEqual(authState, { sessions: 0, challenges: 0, recovery_codes: 0, mfa_identities: 0 });
    const memberships = (await owner.query("select workspace_id from public.workspace_users where auth_identity_id=$1 order by workspace_id", [accounts.operator.authIdentityId])).rows.map(row => row.workspace_id);
    assert.deepEqual(memberships, [studioWorkspace, accounts.operator.workspaceId, accounts.customerA.workspaceId].sort());
    required(!memberships.includes(accounts.customerB.workspaceId), "Operator must never receive foreign B membership");
    assert.deepEqual(await providerCounts(), providersBefore, "Provisioning must not activate providers or service bindings");
    const manifest = structuredClone(targetTemplate);
    manifest.sourceSha = implementationRevision;
    manifest.neon = { projectId: package4SeedTarget.projectId, branchId: package4SeedTarget.branchId, database: "neondb", runtimeRole: "novalure_app", migrationRole: "neondb_owner" };
    manifest.accounts = accounts;
    manifest.accounts.customerB.testContract = { botsModuleEnabled: true, webchatAccess: true, voiceAccess: false, maxQueriesPerMonth: 1, queryCountThisUtcMonth: 1, remainingQueries: 0 };
    manifest.studio = { workspaceId: studioWorkspace, projectId: studioProject, operatorMembershipUserId: operatorMemberships.find(item => item.workspaceId === studioWorkspace).userId };
    manifest.operatorMemberships = operatorMemberships;
    manifest.hidden = { workspaceId: accounts.customerA.workspaceId, projectId: hiddenProjectId, unitId: hiddenUnitId };
    manifest.accounts.customerA.hiddenProjectId = hiddenProjectId;
    manifest.accounts.customerA.hiddenUnitId = hiddenUnitId;
    manifest.accounts.operator.taskId = internalTaskId;
    manifest.recoveryTaskId = taskId;
    manifest.recoveryFixture = { workspaceId: accounts.customerA.workspaceId, projectId: accounts.customerA.projectId, taskId, title: taskTitle, ownerUserId: accounts.customerA.userId };
    manifest.fixture = { marker, syntheticOnly: true, workspaceIds: [studioWorkspace, accounts.operator.workspaceId, accounts.customerA.workspaceId, accounts.customerB.workspaceId] };
    manifest.allWorkspaceIds = manifest.fixture.workspaceIds;
    manifest.seededAt = new Date().toISOString();
    const credentials = Object.fromEntries(Object.entries(accounts).map(([key, account]) => [account.credentialKey, { password: passwords[key].password }]));
    for (const [filename, value] of [[outputs.credentials, credentials], [outputs.manifest, manifest]]) {
      await writeFile(filename, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); written.push(filename);
    }
    evidence.authState = authState; evidence.seededAt = manifest.seededAt; evidence.accountCount = 5; evidence.operatorMembershipCount = 3;
    evidence.foreignOperatorMemberships = 0; evidence.syntheticWorkspaceCount = 3; evidence.recoveryTaskId = taskId;
    evidence.providerCountsUnchanged = true; evidence.normalMfaEnrollmentRequired = true;
    await writeFile(outputs.evidence, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await owner.query("commit"); committed = true;
    evidence.status = "PASS"; evidence.committedAt = new Date().toISOString();
    await writeFile(outputs.evidence, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    return { evidence, manifest, credentialsFile: outputs.credentials, manifestFile: outputs.manifest };
  } catch (error) {
    if (!committed) {
      await owner.query("rollback");
      await Promise.allSettled(written.map(filename => unlink(filename)));
    }
    evidence.status = "FAIL"; evidence.committed = committed; evidence.failure = { code: error.code ?? null,
      message: String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[REDACTED]") };
    await writeFile(outputs.evidence, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    throw new Error("PACKAGE4_SYNTHETIC_SEED_FAILED; inspect the private seed evidence");
  }
}

async function main() {
  required(process.argv[4] === "--seed-authorized-qa" && process.argv.length === 5, "Usage: node --conditions=react-server --import tsx scripts/package4-neon-seed.mjs PRIVATE_CONFIG PUBLIC_TEMPLATE --seed-authorized-qa");
  const configFile = await realpath(process.argv[2]);
  const runRoot = path.dirname(configFile);
  const info = await lstat(configFile);
  required(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0, "Private owner-only seed config required");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  required(config.target.projectId === package4SeedTarget.projectId && config.target.branchId === package4SeedTarget.branchId && config.host === package4SeedTarget.host, "Pinned QA config required");
  const uriFile = await realpath(config.adminUrlFile);
  required(path.dirname(uriFile) === runRoot, "Owner URL must remain in the same private run directory");
  const uriInfo = await lstat(uriFile);
  required(uriInfo.isFile() && uriInfo.uid === process.getuid() && (uriInfo.mode & 0o077) === 0, "Owner URL must be private");
  const uri = new URL((await readFile(uriFile, "utf8")).trim());
  required(uri.hostname === package4SeedTarget.host && decodeURIComponent(uri.username) === "neondb_owner" && uri.pathname === "/neondb" && uri.password, "Pinned owner URL required");
  const { configurePackage4NeonTransport } = await import("./package4-neon-bootstrap.mjs");
  const { Pool } = await import("@neondatabase/serverless");
  configurePackage4NeonTransport();
  const pool = new Pool({ connectionString: uri.toString(), max: 1, connectionTimeoutMillis: 20_000, query_timeout: 120_000 });
  const client = await pool.connect();
  try {
    const implementationRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = await seedPackage4Neon({ owner: client, targetTemplate: JSON.parse(await readFile(process.argv[3], "utf8")), implementationRevision,
      credentialsFile: path.join(runRoot, "hosted-credentials.private.json"), manifestFile: path.join(runRoot, "hosted-target.json"), evidenceFile: path.join(runRoot, "seed-result.json") });
    console.log(JSON.stringify({ status: result.evidence.status, accounts: result.evidence.accountCount, seededSessions: 0, seededMfaSecrets: 0, grantChanges: 0 }));
  } finally { client.release(); await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message === "PACKAGE4_SYNTHETIC_SEED_FAILED; inspect the private seed evidence" ? error.message : "PACKAGE4_SYNTHETIC_SEED_START_FAILED"); process.exitCode = 1;
});
