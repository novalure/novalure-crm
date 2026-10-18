#!/usr/bin/env node
// Prepared QA tooling. No database or HTTP operation runs on import.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCACertificates } from 'node:tls';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { hashPassword } from '../src/lib/auth/passwords.ts';
import { createTotpCode } from '../src/lib/auth/mfa-core.ts';

const run = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = (ok, reason) => assert.ok(ok, reason);
export const fixtureTarget = Object.freeze({projectId:'super-block-59791927',branchId:'br-ancient-term-awip1q3q',databaseName:'neondb',role:'neondb_owner'});
// Root's read-only provider-role-provenance.json confirms this unchanged parent/
// owned-branch administrator profile. It is never an application runtime role.
export const providerAdminProfile = Object.freeze({rolsuper:false,rolbypassrls:true,rolcanlogin:true,rolcreatedb:true,rolcreaterole:true});
export const migrationChecksum = sql => createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex');
const workspaceId = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101';
const actorId = '6122a6da-e7f4-47fa-bc55-e296bb01af62';
const schemaVersion = 'studio-stage3-normal-login-v1';
function stableUuid(key) {
  const h=createHash('sha256').update(schemaVersion+':'+fixtureTarget.branchId+':'+key).digest('hex').split('');
  h[12]='4';h[16]=((parseInt(h[16],16)&3)|8).toString(16);
  const s=h.join('');return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');
}
export const loginPlan = Object.freeze({
  sameWorkspace:Object.freeze({email:'st1-studio-owner@example.invalid',userId:stableUuid('studio-owner'),workspaceId,name:'SYNTHETIC ST1 Studio QA owner'}),
  foreignWorkspace:Object.freeze({email:'st1-foreign-owner@example.invalid',userId:stableUuid('foreign-owner'),workspaceId:stableUuid('foreign-workspace'),name:'SYNTHETIC ST1 Foreign QA owner'}),
});
export function validateFixtureConfig(config) {
  check(config&&Object.keys(fixtureTarget).every(key=>config.target?.[key]===fixtureTarget[key]),'PINNED_STAGE3_QA_TARGET_REQUIRED');
  check(typeof config.approvalId==='string'&&config.approvalId.trim(),'FIXTURE_APPROVAL_REQUIRED');
  check(typeof config.adminUriFile==='string'&&typeof config.credentialsFile==='string','PRIVATE_FILES_REQUIRED');
  check(config.adminUriFile!==config.credentialsFile,'DISTINCT_PRIVATE_FILES_REQUIRED');
  return config;
}
export function makeCredentials() {
  return {schemaVersion,target:fixtureTarget,qaEmail:'st1-qa@example.invalid',qaPhone:'+353000000000',
    logins:Object.fromEntries(Object.entries(loginPlan).map(([label,value])=>[label,{...value,password:randomBytes(32).toString('base64url')}]))};
}
export function validateAccount(label, account) {
  const expected=loginPlan[label];
  check(expected&&account&&['email','userId','workspaceId'].every(key=>account[key]===expected[key]),'SYNTHETIC_LOGIN_BINDING_REQUIRED');
  check(typeof account.password==='string'&&account.password.length>=32,'SYNTHETIC_PASSWORD_REQUIRED');
}
export async function assertFixtureTarget(client) {
  const row=(await client.query("select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role,session_user as session_role,(select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as owner,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolcreatedb,r.rolcreaterole from pg_roles r where r.rolname=current_user")).rows[0];
  check(row?.project===fixtureTarget.projectId&&row.branch===fixtureTarget.branchId&&row.database===fixtureTarget.databaseName&&
    row.role===fixtureTarget.role&&row.session_role===fixtureTarget.role&&row.owner===fixtureTarget.role&&Object.entries(providerAdminProfile).every(([key,value])=>row[key]===value),'ACTUAL_STAGE3_OWNER_TARGET_MISMATCH');
  const checksum=migrationChecksum(await readFile(path.join(repository,'migrations/098_studio_enquiry_handoff.sql'),'utf8'));
  const ready=(await client.query("select exists(select 1 from novalure_schema_migrations where version='098_studio_enquiry_handoff' and checksum=$1) and exists(select 1 from workspace_users where id=$2::uuid and workspace_id=$3::uuid and status='active' and role='agent' and product_role='novalure_operator') and (select count(*)=3 and bool_and(pg_get_userbyid(c.relowner)='neondb_owner') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('workspaces','workspace_users','auth_identities')) as ready",
    [checksum,actorId,workspaceId])).rows[0];
  check(ready?.ready===true,'CANONICAL_STAGE3_SCHEMA_AND_OWNER_REQUIRED');
}
export async function seedLoginFixtures(client, credentials, {persistPrivateCredentials}={}) {
  check(credentials?.schemaVersion===schemaVersion,'FIXTURE_VERSION_REQUIRED');
  for(const label of Object.keys(loginPlan))validateAccount(label,credentials.logins?.[label]);
  check(typeof persistPrivateCredentials==='function','PRIVATE_CREDENTIAL_PERSISTENCE_REQUIRED');
  await assertFixtureTarget(client);
  // Save newly generated passwords before any write. Never rotate/adopt an existing identity.
  await persistPrivateCredentials(credentials);
  await client.query('begin');
  try {
    await assertFixtureTarget(client);
    await client.query("select pg_advisory_xact_lock(hashtextextended('studio-stage3-normal-login-v1',0))");
    const collision=(await client.query('select exists(select 1 from workspace_users where id=any($1::uuid[]) or lower(btrim(email))=any($2::text[])) or exists(select 1 from auth_identities where normalized_email=any($2::text[])) or exists(select 1 from workspaces where id=$3::uuid) as collision',
      [Object.values(loginPlan).map(v=>v.userId),Object.values(loginPlan).map(v=>v.email),loginPlan.foreignWorkspace.workspaceId])).rows[0];
    check(collision?.collision===false,'FIXTURE_ALREADY_EXISTS_OR_IDENTITY_COLLISION');
    await client.query("insert into workspaces(id,name,operating_model,customer_type,active_calendar_provider,setup_state) values($1::uuid,'SYNTHETIC ST1 Foreign QA workspace','novalure_internal','novalure_internal','none',$2::jsonb)",
      [loginPlan.foreignWorkspace.workspaceId,JSON.stringify({syntheticQa:true,studioStage3LoginFixture:schemaVersion})]);
    for(const label of Object.keys(loginPlan)) {
      const account=credentials.logins[label];
      const hashed=await hashPassword(account.password);
      // The existing trigger alone creates/links the central auth identity.
      await client.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,password_hash) values($1::uuid,$2::uuid,$3,$4,'owner','customer_owner','active',$5)",
        [account.userId,account.workspaceId,account.name,account.email,hashed]);
      const verified=(await client.query("select u.role='owner' and u.product_role='customer_owner' and u.status='active' and a.normalized_email=$2 and a.password_hash=$3 and a.credential_state='active' and a.mfa_enabled_at is null and a.mfa_secret_ciphertext is null and (select count(*)=1 from workspace_users other where other.auth_identity_id=a.id) as verified from workspace_users u join auth_identities a on a.id=u.auth_identity_id where u.id=$1::uuid",
        [account.userId,account.email,hashed])).rows[0];
      check(verified?.verified===true,'NORMAL_LOGIN_IDENTITY_NOT_VERIFIED');
    }
    await client.query('commit');
    return {status:'PREPARED_NORMAL_LOGIN_MFA_REQUIRED',created:{workspaces:1,users:2},target:fixtureTarget,logins:loginPlan};
  } catch(error) {await client.query('rollback');throw error;}
}
function headerValues(response,name) {
  const value=response.headers?.get(name);
  return value==null?[]:Array.isArray(value)?value:[value];
}
function readCookie(response,name) {
  const values=headerValues(response,'set-cookie').map(v=>v.split(';')[0]).filter(v=>v.startsWith(name+'=')&&v.length>name.length+1);
  check(values.length===1,'EXPECTED_NORMAL_AUTH_COOKIE_REQUIRED');return values[0];
}
export function parseEnrollmentHtml(html) {
  check(typeof html==='string'&&Buffer.byteLength(html)<=2_000_000,'BOUNDED_ENROLLMENT_PAGE_REQUIRED');
  const codes=[...html.matchAll(/<code(?:\s[^>]*)?>([^<]+)<\/code>/g)].map(v=>v[1]);
  const secret=codes.filter(v=>/^[A-Z2-7]{32}$/.test(v));
  const recoveryCodes=codes.filter(v=>/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/.test(v));
  check(secret.length===1&&recoveryCodes.length===10&&new Set(recoveryCodes).size===10,'NORMAL_ENROLLMENT_PAGE_NOT_RECOGNIZED');
  return {secret:secret[0],recoveryCodes};
}
/** Host-only capability: caller supplies exact-Preview-verified HTTP and ACL-private persistence.
 * Returns a sensitive ordinary session cookie to the caller; never log the result. */
export async function normalQaLogin({label,account,origin,http,savePrivateEnrollment,now=()=>Date.now()}) {
  validateAccount(label,account);
  check(/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin),'PROTECTED_PREVIEW_ORIGIN_REQUIRED');
  check(typeof http==='function'&&typeof savePrivateEnrollment==='function','VERIFIED_HTTP_AND_PRIVATE_PERSISTENCE_REQUIRED');
  const headers={'Content-Type':'application/x-www-form-urlencoded',Origin:origin,Referer:origin+'/login','Sec-Fetch-Site':'same-origin'};
  const post=body=>http('/api/auth/login',{method:'POST',headers,body:new URLSearchParams({...body,returnTo:'/',language:'en'}).toString()});
  const first=await post({email:account.email,password:account.password});
  check(first.status===303,'NORMAL_PASSWORD_LOGIN_NOT_REDIRECTED');
  const location=headerValues(first,'location')[0];
  const next=new URL(location||'',origin);
  check(next.origin===origin&&next.pathname==='/login'&&['mfa_enrollment','mfa_verification'].includes(next.searchParams.get('step')),'NORMAL_OWNER_MFA_CHALLENGE_REQUIRED');
  const challengeCookie=readCookie(first,'novalure_login_challenge');
  let secret=account.mfa?.secret;
  const enrollment=next.searchParams.get('step')==='mfa_enrollment';
  if(enrollment) {
    const page=await http('/login?step=mfa_enrollment',{headers:{Cookie:challengeCookie}});
    check(page.status===200,'NORMAL_ENROLLMENT_PAGE_UNAVAILABLE');
    const material=parseEnrollmentHtml(Buffer.from(page.body).toString('utf8'));
    await savePrivateEnrollment(label,{...material,email:account.email,userId:account.userId,workspaceId:account.workspaceId});
    secret=material.secret;
  }
  check(typeof secret==='string'&&/^[A-Z2-7]{32}$/.test(secret),'EXISTING_QA_MFA_SECRET_REQUIRED');
  const code=createTotpCode(secret,now());check(code,'TOTP_CODE_UNAVAILABLE');
  const verified=await http('/api/auth/login',{method:'POST',headers:{...headers,Cookie:challengeCookie},
    body:new URLSearchParams({flow:'challenge',code,recoveryCodesSaved:enrollment?'1':'0',returnTo:'/',language:'en'}).toString()});
  check(verified.status===303,'NORMAL_MFA_NOT_REDIRECTED');
  const cookie=readCookie(verified,'novalure_session');
  const session=await http('/api/auth/session',{headers:{Cookie:cookie}});
  check(session.status===200,'NORMAL_SESSION_UNAVAILABLE');
  const data=JSON.parse(Buffer.from(session.body).toString('utf8'));
  check(data.authenticated===true&&data.source==='cookie'&&data.user?.id===account.userId&&data.workspace?.id===account.workspaceId&&
    data.user?.role==='owner'&&data.trustedAuthHeaders===false&&data.demoAuth===false,'NORMAL_SESSION_BINDING_MISMATCH');
  return {cookie,verified:'PASS_NORMAL_PASSWORD_AND_MFA',userId:account.userId,workspaceId:account.workspaceId};
}
export async function assertPrivateQaPath(filename,directory=false) {
  const base=await realpath(path.join(repository,'.npm-cache','qa'));
  const absolute=await realpath(path.resolve(filename));
  check(absolute.startsWith(base+path.sep),'IGNORED_QA_PRIVATE_PATH_REQUIRED');
  const info=await stat(absolute);check(directory?info.isDirectory():info.isFile(),'PRIVATE_PATH_TYPE_MISMATCH');
  if(process.platform==='win32') {
    const quoted=absolute.replaceAll("'","''");
    const code="$a=Get-Acl -LiteralPath '"+quoted+"';$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow'){$i=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($i -ne $s -and $i -ne 'S-1-5-18'){exit 1}}};'PRIVATE_OK'";
    const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,timeout:10000});
    check(result.stdout.trim()==='PRIVATE_OK','PRIVATE_WINDOWS_ACL_REQUIRED');
  } else check((info.mode&0o077)===0,'PRIVATE_POSIX_MODE_REQUIRED');
  return absolute;
}
export async function runFixture(configFile,authorized=false) {
  const filename=await assertPrivateQaPath(configFile);
  const config=validateFixtureConfig(JSON.parse(await readFile(filename,'utf8')));
  const uriFile=await assertPrivateQaPath(config.adminUriFile);
  const outputParent=await assertPrivateQaPath(path.dirname(path.resolve(config.credentialsFile)),true);
  const output=path.join(outputParent,path.basename(config.credentialsFile));
  check(output!==uriFile&&output!==filename,'PRIVATE_OUTPUT_MUST_BE_DISTINCT');
  check(authorized,'EXPLICIT_AUTHORIZED_FIXTURE_FLAG_REQUIRED');
  const u=new URL((await readFile(uriFile,'utf8')).trim());
  check(/^postgres(?:ql)?:$/.test(u.protocol)&&/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(u.hostname)&&
    !u.hostname.includes('-pooler.')&&(!u.port||u.port==='5432')&&decodeURIComponent(u.username)===fixtureTarget.role&&
    decodeURIComponent(u.pathname.slice(1))===fixtureTarget.databaseName&&u.searchParams.get('sslmode')==='verify-full'&&
    [...u.searchParams.keys()].every(k=>['sslmode','channel_binding'].includes(k)),'PINNED_ADMIN_URI_REQUIRED');
  const pool=new pg.Pool({host:u.hostname,port:5432,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:fixtureTarget.databaseName,
    ssl:{rejectUnauthorized:true,ca:getCACertificates('default')},max:1,connectionTimeoutMillis:10000,query_timeout:15000});
  let client;
  try {
    client=await pool.connect();
    return await seedLoginFixtures(client,makeCredentials(),{persistPrivateCredentials:async data=>writeFile(output,JSON.stringify(data,null,2),{flag:'wx',mode:0o600})});
  } finally {client?.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    check(process.argv.length===4&&process.argv[3]==='--run-authorized-fixture','Usage: node --import tsx scripts/studio-stage3-login-fixture.mjs <ACL-private-config.json> --run-authorized-fixture');
    console.log(JSON.stringify(await runFixture(process.argv[2],true)));
  } catch {console.error(JSON.stringify({status:'FAILED',reason:'stage3_normal_login_fixture_unconfirmed'}));process.exitCode=1;}
}
