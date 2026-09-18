import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const neon061SourceChecksum = '0fdd95faee430de5b6e1ea0d22d477099ff151c5583476bdb542b6e00dcb5d23';
export const neon061ProfileId = 'neon-provider-creator-admin-only-061-v1';
export const neon061QaTarget = Object.freeze({ projectId: 'weathered-term-98273025', branchId: 'br-spring-snow-alupo8u4', databaseName: 'qa_g24_pr63_20260917_r3', runtimeRole: 'g24_qa_20260917_r3' });
const predecessorChecksum = 'b037f00c56daf6af4a12b7641bd60fe6e3b981240859800d3f62a21b68a31baf';
const version = '061_validate_and_activate_tenant_rls_pilot';
const pilot = ['audit_logs', 'contacts', 'deals', 'leads', 'projects'];
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value).replace(/\r\n/g, '\n');
function fail(message) { throw new Error('G24_061: ' + message); }
function name(value) { if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) fail('invalid role identifier'); return value; }
const identifier = value => '"' + name(value) + '"';
const literal = value => "'" + name(value) + "'";
const elevated = role => role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls;

/** Pure rendering only; execution ALWAYS re-attests the connected catalog below. */
export function renderNeon061Compatibility(sql, { ownerRole = 'neondb_owner', grantorRole = 'cloud_admin' } = {}) {
  const source = normalize(sql);
  if (hash(source) !== neon061SourceChecksum) fail('historical source checksum mismatch');
  name(ownerRole); name(grantorRole);
  const excluded = `\n      and not (\n        membership.member = (select oid from pg_roles where rolname = ${literal(ownerRole)})\n        and membership.grantor = (select oid from pg_roles where rolname = ${literal(grantorRole)})\n        and membership.admin_option and not membership.inherit_option and not membership.set_option\n        and current_user = ${literal(ownerRole)} and session_user = ${literal(ownerRole)}\n        and (select datdba from pg_database where datname = current_database()) = membership.member\n        and not pg_has_role(membership.member, tenant_role_oid, 'USAGE')\n        and not pg_has_role(membership.member, tenant_role_oid, 'SET')\n      )`;
  const direct = '    where membership.roleid = tenant_role_oid\n      and (';
  const owner = '      and membership.roleid = tenant_role_oid\n  ) then';
  if (source.split(direct).length !== 2 || source.split(owner).length !== 2) fail('historical guard structure changed');
  const executedSql = source.replace(direct, () => '    where membership.roleid = tenant_role_oid' + excluded + '\n      and (').replace(owner, () => '      and membership.roleid = tenant_role_oid' + excluded + '\n  ) then');
  return Object.freeze({ sourceChecksum: neon061SourceChecksum, executedSqlChecksum: hash(executedSql), executedSql });
}

async function catalog(client, runtimeRole) {
  const identity = (await client.query(`select current_user as "currentUser",session_user as "sessionUser",current_database() as "databaseName",current_setting('server_version_num')::int as "serverVersionNum",current_setting('neon.project_id',true) as "projectId",current_setting('neon.branch_id',true) as "branchId",host(inet_server_addr()) as "serverAddress",host(inet_client_addr()) as "clientAddress",inet_server_port() as port,extract(epoch from pg_postmaster_start_time()) as "startedAt",(select datdba::int from pg_database where datname=current_database()) as "databaseOwner"`)).rows[0];
  const roles = (await client.query(`select oid::int,rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles order by oid`)).rows;
  const edges = (await client.query(`select roleid::int,member::int,grantor::int,admin_option,inherit_option,set_option,pg_has_role(member,roleid,'USAGE') as effective_usage,pg_has_role(member,roleid,'SET') as effective_set from pg_auth_members order by roleid,member,grantor`)).rows;
  const owners = (await client.query(`select c.relname,c.relowner::int as owner,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) order by c.relname`, [pilot])).rows;
  const ownership = (await client.query(`select distinct owner from (select datdba::int as owner from pg_database union select relowner::int from pg_class union select proowner::int from pg_proc union select nspowner::int from pg_namespace) x order by owner`)).rows.map(row => row.owner);
  const access = (await client.query(`select subject.oid::int as subject,object.oid::int,pg_has_role(subject.oid,object.oid,'USAGE') as usage,pg_has_role(subject.oid,object.oid,'SET') as set from pg_roles subject cross join pg_roles object where subject.rolname=$1 or subject.oid in(select member from pg_auth_members where roleid=(select oid from pg_roles where rolname='novalure_tenant_app')) order by subject.oid,object.oid`, [runtimeRole])).rows;
  return { identity, roles, edges, owners, ownership, access };
}

async function attestTarget(client, target, localTest, evidence) {
  if (!target || Object.keys(target).sort().join(',') !== 'branchId,databaseName,projectId,runtimeRole') fail('exact explicit target required');
  name(target.runtimeRole); const identity = evidence.identity;
  if (identity.serverVersionNum < 170000) fail('PostgreSQL 17 or later required');
  if (identity.databaseName !== target.databaseName || identity.currentUser !== identity.sessionUser) fail('database or session identity mismatch');
  if (!localTest) {
    if (Object.keys(neon061QaTarget).some(key => target[key] !== neon061QaTarget[key]) || identity.projectId !== target.projectId || identity.branchId !== target.branchId || identity.currentUser !== 'neondb_owner') fail('pinned Neon QA fingerprint mismatch');
    return { ownerRole: 'neondb_owner', grantorRole: 'cloud_admin', profileId: neon061ProfileId };
  }
  // A caller flag alone cannot opt a remote server into the local profile.
  if (localTest.profile !== 'disposable-loopback-postgresql' || !['127.0.0.1', '::1'].includes(client.connectionParameters?.host) || !['127.0.0.1', '::1'].includes(identity.serverAddress) || !['127.0.0.1', '::1'].includes(identity.clientAddress) || identity.projectId || identity.branchId || target.projectId !== 'local-disposable' || target.branchId !== 'local-disposable') fail('local profile requires a real loopback server without Neon fingerprints');
  const root = await realpath(path.resolve('.npm-cache/qa'));
  const directory = await realpath(localTest.directory);
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith('sales-pg-')) fail('local cluster is outside disposable QA root');
  const pid = (await readFile(path.join(directory, 'postmaster.pid'), 'utf8')).trim().split(/\r?\n/);
  if (await realpath(pid[1]) !== directory || Number(pid[3]) !== identity.port || Number(client.connectionParameters.port) !== identity.port || Math.abs(Number(pid[2]) - Number(identity.startedAt)) > 2 || Number(pid[0]) <= 1) fail('local postmaster identity does not match connected server');
  process.kill(Number(pid[0]), 0);
  if (!/^g24_owner_[a-f0-9]{8}$/.test(localTest.ownerRole) || localTest.grantorRole !== 'qa_admin' || identity.currentUser !== localTest.ownerRole) fail('local synthetic creator/grantor identity mismatch');
  return { ownerRole: localTest.ownerRole, grantorRole: localTest.grantorRole, profileId: 'local-test:' + neon061ProfileId };
}

function attestRoles(evidence, target, profile) {
  const { roles, edges, identity, owners, access, ownership } = evidence;
  const group = roles.find(role => role.rolname === 'novalure_tenant_app'), creator = roles.find(role => role.rolname === profile.ownerRole), grantor = roles.find(role => role.rolname === profile.grantorRole), runtime = roles.find(role => role.rolname === target.runtimeRole);
  if (!group || group.rolcanlogin || elevated(group)) fail('safe tenant group missing');
  if (!creator || !grantor || creator.oid !== identity.databaseOwner || owners.length !== 5 || owners.some(row => row.owner !== creator.oid)) fail('creator must own database and exactly the five pilot tables');
  if (!runtime || !runtime.rolcanlogin || !runtime.rolinherit || elevated(runtime) || ownership.includes(runtime.oid)) fail('runtime must be a safe non-owner LOGIN INHERIT role');
  const creatorEdges = edges.filter(edge => edge.roleid === group.oid && edge.member === creator.oid);
  if (creatorEdges.length !== 1) fail('exactly one provider creator edge required');
  const ignored = creatorEdges[0];
  if (ignored.grantor !== grantor.oid || !ignored.admin_option || ignored.inherit_option || ignored.set_option || ignored.effective_usage || ignored.effective_set) fail('creator edge is not provider-granted ADMIN-only without effective access');
  const direct = edges.filter(edge => edge.roleid === group.oid);
  for (const edge of direct) {
    if (edge === ignored) continue;
    const member = roles.find(role => role.oid === edge.member);
    if (!member?.rolcanlogin || elevated(member) || !edge.effective_usage || edge.admin_option || owners.some(row => row.owner === member.oid)) fail('unsafe additional tenant-group member');
  }
  if (!direct.some(edge => edge.member === runtime.oid && edge.inherit_option && edge.effective_usage && !edge.admin_option)) fail('explicit safe inheriting runtime membership required');
  for (const candidate of roles.filter(role => direct.some(edge => edge.member === role.oid && edge !== ignored))) {
    if (ownership.includes(candidate.oid)) fail('additional application member owns database objects');
    const controlled = new Set([candidate.oid, ...access.filter(row => row.subject === candidate.oid && (row.usage || row.set)).map(row => row.oid)]);
    let changed = true;
    while (changed) { changed = false; for (const edge of edges) if (controlled.has(edge.member) && (edge.admin_option || edge.inherit_option || edge.set_option) && !controlled.has(edge.roleid)) { controlled.add(edge.roleid); changed = true; } }
    if (edges.some(edge => edge.admin_option && controlled.has(edge.member))) fail('runtime has a reachable ADMIN path');
    if (roles.some(role => role.oid !== candidate.oid && controlled.has(role.oid) && (elevated(role) || ownership.includes(role.oid) || role.rolname.startsWith('pg_') || role.oid === creator.oid || role.oid === grantor.oid))) fail('runtime can reach a privileged or owning role');
  }
  return { group: group.rolname, creator: creator.rolname, grantor: grantor.rolname, runtime: runtime.rolname, ignoredCreatorEdge: { admin: true, inherit: false, set: false, effectiveUsage: false, effectiveSet: false }, directMembers: direct.map(edge => ({ role: roles.find(role => role.oid === edge.member).rolname, grantor: roles.find(role => role.oid === edge.grantor).rolname, admin: edge.admin_option, inherit: edge.inherit_option, set: edge.set_option })), pilotOwners: owners.map(row => ({ table: row.relname, owner: creator.rolname })), runtimePrivilegedReachability: false };
}

/** Caller MUST own BEGIN, original-source ledger insert, and COMMIT/ROLLBACK. No provider-role SQL is executed. */
export async function applyNeon061Compatibility({ client, sql, target, localTest, executionContext }) {
  if (!executionContext || Object.keys(executionContext).sort().join(',') !== 'headCommit,planDigest' || !/^[a-f0-9]{40}$/.test(executionContext.headCommit) || !/^[a-f0-9]{64}$/.test(executionContext.planDigest)) fail('exact runner commit and plan digest required');
  const source = normalize(sql); if (hash(source) !== neon061SourceChecksum) fail('historical source checksum mismatch');
  await client.query('savepoint g24_neon_061_compat'); // PostgreSQL rejects calls outside a transaction.
  try {
    await client.query('select pg_advisory_xact_lock(941061)');
    const ledger = (await client.query("select version,checksum from public.novalure_schema_migrations where version ~ '^0*(60|61)(_|$)' order by version")).rows;
    if (ledger.some(row => /^0*61(?:_|$)/.test(row.version))) fail('061 already applied; no historical receipt may be invented');
    const predecessors = ledger.filter(row => /^0*60(?:_|$)/.test(row.version));
    if (predecessors.length !== 1 || predecessors[0].checksum !== predecessorChecksum) fail('exact checksummed 060 predecessor required');
    const before = await catalog(client, target?.runtimeRole);
    const profile = await attestTarget(client, target, localTest, before);
    const roleEvidence = attestRoles(before, target, profile);
    const prepared = renderNeon061Compatibility(source, profile);
    await client.query(prepared.executedSql);
    const after = await catalog(client, target.runtimeRole);
    attestRoles(after, target, profile);
    if (hash(JSON.stringify(before.roles)) !== hash(JSON.stringify(after.roles)) || hash(JSON.stringify(before.edges)) !== hash(JSON.stringify(after.edges)) || after.owners.some(row => !row.relrowsecurity || !row.relforcerowsecurity)) fail('role catalog changed or forced RLS is incomplete');
    const validation = (await client.query("select conname,convalidated from pg_constraint where connamespace='public'::regnamespace and conname = any($1::text[]) order by conname", [[...source.matchAll(/validate constraint ([a-z_]+);/g)].map(match => match[1])])).rows;
    if (validation.length !== 15 || validation.some(row => !row.convalidated)) fail('all fifteen tenant foreign keys must be validated');
    const receiptId = randomUUID();
    const evidence = { executionContext: { ...executionContext }, identity: { projectId: target.projectId, branchId: target.branchId, databaseName: target.databaseName, currentUser: after.identity.currentUser, sessionUser: after.identity.sessionUser, serverVersionNum: after.identity.serverVersionNum }, roles: roleEvidence, foreignKeysValidated: validation.map(row => row.conname), forcedRlsTables: after.owners.map(row => row.relname), historicalLedgerChecksumMeaning: 'unaltered source bytes normalized to LF', executedChecksumMeaning: 'actual SQL with only two narrowly qualified creator-edge exclusions' };
    await client.query(`create table public.novalure_migration_execution_receipts (id uuid primary key,source_version text not null unique,source_checksum text not null check(source_checksum ~ '^[a-f0-9]{64}$'),executed_sql_checksum text not null check(executed_sql_checksum ~ '^[a-f0-9]{64}$'),profile_id text not null,target jsonb not null,catalog_evidence jsonb not null,executed_at timestamptz not null default now(),executed_by text not null default current_user);
      create function public.novalure_migration_receipt_immutable() returns trigger language plpgsql set search_path=pg_catalog as $receipt$ begin raise exception using errcode = '55000', message = 'Migration execution receipts are append-only'; end $receipt$;
      create trigger novalure_migration_receipts_append_only before update or delete or truncate on public.novalure_migration_execution_receipts for each statement execute function public.novalure_migration_receipt_immutable();
      revoke all on public.novalure_migration_execution_receipts from public,novalure_tenant_app,${identifier(target.runtimeRole)}${before.roles.some(role => role.rolname === 'novalure_app') ? ',novalure_app' : ''};
      revoke all on function public.novalure_migration_receipt_immutable() from public;`);
    await client.query('insert into public.novalure_migration_execution_receipts(id,source_version,source_checksum,executed_sql_checksum,profile_id,target,catalog_evidence) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)', [receiptId, version, prepared.sourceChecksum, prepared.executedSqlChecksum, profile.profileId, JSON.stringify(target), JSON.stringify(evidence)]);
    const receiptAccess = (await client.query("select has_table_privilege($1,'public.novalure_migration_execution_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as allowed", [target.runtimeRole])).rows[0];
    if (receiptAccess.allowed) fail('runtime retains unexpected receipt privileges');
    await client.query('release savepoint g24_neon_061_compat');
    return Object.freeze({ receiptId, profileId: profile.profileId, sourceChecksum: prepared.sourceChecksum, executedSqlChecksum: prepared.executedSqlChecksum, evidence });
  } catch (error) { await client.query('rollback to savepoint g24_neon_061_compat'); await client.query('release savepoint g24_neon_061_compat'); throw error; }
}
