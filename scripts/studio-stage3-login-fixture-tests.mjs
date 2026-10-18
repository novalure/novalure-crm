import assert from 'node:assert/strict';
import { test } from 'node:test';
import {hasProductCapability,mapProductRoleToTechnicalRole} from '../src/lib/product-model.ts';
import { mkdir, mkdtemp, writeFile, realpath, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecoveryCodes, createTotpSecret, verifyTotpCode } from '../src/lib/auth/mfa-core.ts';
import { validateFixtureConfig, makeCredentials, loginPlan, fixtureTarget, seedLoginFixtures, parseEnrollmentHtml, normalQaLogin, providerAdminProfile, migrationChecksum, assertPrivateQaPath } from './studio-stage3-login-fixture.mjs';

test('actual private QA access accepts restricted files and rejects an additional reader',async()=>{
  const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const base=path.join(repository,'.npm-cache','qa');await mkdir(base,{recursive:true,mode:0o700});
  const scratch=await mkdtemp(path.join(base,'synthetic-login-acl-'));
  const narrow=path.join(scratch,'private.txt'),wide=path.join(scratch,'extra-reader.txt');
  try {
    if(process.platform==='win32') {
      const env={...process.env,STUDIO_LOGIN_TEST_DIRECTORY:scratch};
      for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
      const setup="$ErrorActionPreference='Stop';$p=$env:STUDIO_LOGIN_TEST_DIRECTORY;$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object System.Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false);$a.SetOwner($s);foreach($i in @($s,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($i,'FullControl','ContainerInherit, ObjectInherit','None','Allow'))};Set-Acl -LiteralPath $p -AclObject $a";
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(setup,'utf16le').toString('base64')],{env,windowsHide:true,stdio:'ignore'});
    }
    await writeFile(narrow,'synthetic non-secret',{mode:0o600});await writeFile(wide,'synthetic non-secret',{mode:0o600});
    assert.equal(await assertPrivateQaPath(narrow),await realpath(narrow));
    if(process.platform==='win32') {
      const env={...process.env,STUDIO_LOGIN_TEST_FILE:wide};
      for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
      const widen="$ErrorActionPreference='Stop';$p=$env:STUDIO_LOGIN_TEST_FILE;$a=Get-Acl -LiteralPath $p;$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','Allow'));Set-Acl -LiteralPath $p -AclObject $a";
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(widen,'utf16le').toString('base64')],{env,windowsHide:true,stdio:'ignore'});
    } else await chmod(wide,0o644);
    await assert.rejects(assertPrivateQaPath(wide));
    await assert.rejects(assertPrivateQaPath(path.join(scratch,'does-not-exist')));
  } finally {
    const resolved=await realpath(scratch),relative=path.relative(await realpath(base),resolved);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'cleanup stays within the synthetic QA directory');
    await rm(resolved,{recursive:true,force:true});
  }
});

const config=()=>({approvalId:'SYNTHETIC_ST3_ONLY',target:{...fixtureTarget},adminUriFile:'private/admin.txt',credentialsFile:'private/new-logins.json'});
test('every actual login-plan identifier is a 36-character UUIDv4 and stable across fresh module evaluation',async()=>{
  const ids=Object.values(loginPlan).flatMap(account=>[account.userId,account.workspaceId]);
  assert.equal(ids.length,4);
  assert.equal(new Set(ids).size,4);
  for(const id of ids){
    assert.equal(id.length,36);
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  }
  const fresh=await import('./studio-stage3-login-fixture.mjs?uuid-contract');
  assert.deepEqual(fresh.loginPlan,loginPlan);
});
test('fixture is pinned to the exact disposable QA target and requires distinct private files',()=>{
  assert.equal(validateFixtureConfig(config()).target.branchId,fixtureTarget.branchId);
  for(const [key,value] of [['projectId','foreign'],['branchId','br-foreign'],['databaseName','customer'],['role','novalure_app']]){
    const c=config();c.target[key]=value;assert.throws(()=>validateFixtureConfig(c),/PINNED/);
  }
  const c=config();c.credentialsFile=c.adminUriFile;assert.throws(()=>validateFixtureConfig(c),/DISTINCT/);
  c.credentialsFile='new';c.approvalId='';assert.throws(()=>validateFixtureConfig(c),/APPROVAL/);
});
function database({identity={},collision=false,verified=true}={}){
  const calls=[];
  return {calls,async query(sql,params){
    calls.push({sql,params});
    if(sql.includes("current_setting('neon.project_id'"))return {rows:[{project:fixtureTarget.projectId,branch:fixtureTarget.branchId,database:'neondb',role:'neondb_owner',session_role:'neondb_owner',owner:'neondb_owner',...providerAdminProfile,...identity}]};
    if(sql.includes('as ready'))return {rows:[{ready:true}]};
    if(sql.includes('as collision'))return {rows:[{collision}]};
    if(sql.includes('as verified'))return {rows:[{verified}]};
    return {rows:[],rowCount:1};
  }};
}
test('fixture creates only two normal memberships and one foreign workspace after private credential persistence',async()=>{
  const db=database();let saved=false;
  const result=await seedLoginFixtures(db,makeCredentials(),{persistPrivateCredentials:async data=>{
    assert.equal(db.calls.some(v=>/^(?:begin|insert|update|delete)/i.test(v.sql)),false);
    assert.equal(data.qaEmail,'st1-qa@example.invalid');assert.equal(data.qaPhone,'+353000000000');
    saved=true;
  }});
  assert.equal(saved,true);assert.deepEqual(result.created,{workspaces:1,users:2});
  const inserts=db.calls.filter(v=>/^insert/i.test(v.sql));
  assert.equal(inserts.length,3);
  assert.equal(inserts.filter(v=>v.sql.startsWith('insert into workspace_users')).length,2);
  assert.ok(inserts.every(v=>/insert into (?:workspaces|workspace_users)\b/.test(v.sql)));
  assert.ok(inserts.filter(v=>v.sql.includes('workspace_users')).every(v=>String(v.params[4]).startsWith('scrypt:')));
  assert.equal(db.calls.some(v=>/^(?:update|delete|grant|alter|create role)/i.test(v.sql)),false);
  assert.equal(db.calls.at(-1).sql,'commit');
});
test('exact pre-existing provider administrator profile is pinned; any role or target drift fails before credentials or writes',async()=>{
  for(const identity of [{owner:'foreign'},{project:'foreign'},{branch:'foreign'},{database:'foreign'},{role:'novalure_app'},{role:'cloud_admin'},{session_role:'novalure_app'},...Object.entries(providerAdminProfile).map(([key,value])=>({[key]:!value}))]){
    const db=database({identity});let saved=false;
    await assert.rejects(seedLoginFixtures(db,makeCredentials(),{persistPrivateCredentials:async()=>{saved=true;}}),/ACTUAL/);
    assert.equal(saved,false);assert.equal(db.calls.some(v=>v.sql==='begin'),false);
  }
});
test('existing identity collision is never adopted or rekeyed; postinsert verification rolls back',async()=>{
  for(const options of [{collision:true},{verified:false}]){
    const db=database(options);
    await assert.rejects(seedLoginFixtures(db,makeCredentials(),{persistPrivateCredentials:async()=>{}}),/COLLISION|NOT_VERIFIED/);
    assert.equal(db.calls.at(-1).sql,'rollback');
    assert.equal(db.calls.some(v=>/^update|on conflict/i.test(v.sql)),false);
  }
});
test('private write failure prevents even beginning the fixture mutation transaction',async()=>{
  const db=database();await assert.rejects(seedLoginFixtures(db,makeCredentials(),{persistPrivateCredentials:async()=>{throw new Error('synthetic private write failure');}}),/private write failure/);
  assert.equal(db.calls.some(v=>v.sql==='begin'),false);
});
const origin='https://synthetic-stage3.vercel.app', now=1_790_000_000_000;
function authentication({label='sameWorkspace',verification=false,badSession=false,privateFailure=false,externalRedirect=false}={}){
  const account=makeCredentials().logins[label],secret=createTotpSecret(),recoveryCodes=createRecoveryCodes();
  if(verification)account.mfa={secret};
  let persisted=false;const calls=[];
  const response=(status,headers={},body='')=>({status,headers:new Map(Object.entries(headers)),body:Buffer.from(body)});
  const http=async(pathname,options={})=>{
    calls.push({pathname,options});
    if(pathname==='/api/auth/login'&&!options.body.includes('flow=challenge')){
      return response(303,{location:[externalRedirect?'https://foreign.example/login?step=mfa_enrollment':origin+'/login?step='+(verification?'mfa_verification':'mfa_enrollment')],
        'set-cookie':['novalure_login_challenge=SYNTHETIC_CHALLENGE; HttpOnly']});
    }
    if(pathname.startsWith('/login?')){
      assert.equal(options.headers.Cookie,'novalure_login_challenge=SYNTHETIC_CHALLENGE');
      return response(200,{},'<code>'+secret+'</code>'+recoveryCodes.map(v=>'<li><code>'+v+'</code></li>').join(''));
    }
    if(pathname==='/api/auth/login'){
      const body=new URLSearchParams(options.body);
      assert.equal(verifyTotpCode(secret,body.get('code'),now),true);
      assert.equal(options.headers.Cookie,'novalure_login_challenge=SYNTHETIC_CHALLENGE');
      assert.equal(body.get('recoveryCodesSaved'),verification?'0':'1');
      assert.equal(verification||persisted,true,'recovery material saved before enrollment confirmation');
      return response(303,{'set-cookie':['novalure_session=SYNTHETIC_SESSION; Secure; HttpOnly'],location:[origin+'/']});
    }
    assert.equal(pathname,'/api/auth/session');
    return response(200,{},JSON.stringify({authenticated:true,source:'cookie',user:{id:account.userId,role:'owner'},workspace:{id:badSession?loginPlan.foreignWorkspace.workspaceId:account.workspaceId},trustedAuthHeaders:false,demoAuth:false}));
  };
  const savePrivateEnrollment=async(savedLabel,data)=>{
    assert.equal(savedLabel,label);assert.equal(data.secret===secret,true);assert.equal(data.recoveryCodes.length,10);
    if(privateFailure)throw new Error('private storage rejected');persisted=true;
  };
  return {calls,account,http,savePrivateEnrollment,label,origin,now:()=>now};
}
test('ordinary owner enrollment uses password, rendered challenge, persisted recovery, TOTP and exact cookie session',async()=>{
  const ctx=authentication();const result=await normalQaLogin(ctx);
  assert.equal(result.verified,'PASS_NORMAL_PASSWORD_AND_MFA');
  assert.deepEqual(ctx.calls.map(v=>v.pathname),['/api/auth/login','/login?step=mfa_enrollment','/api/auth/login','/api/auth/session']);
  assert.equal(JSON.stringify(result).includes('secret'),false);
  assert.ok(ctx.calls.filter(v=>v.options.method==='POST').every(v=>v.options.headers.Origin===origin));
});
test('existing MFA uses stored synthetic TOTP and never changes or reenrolls the identity',async()=>{
  const ctx=authentication({verification:true});await normalQaLogin(ctx);
  assert.deepEqual(ctx.calls.map(v=>v.pathname),['/api/auth/login','/api/auth/login','/api/auth/session']);
});
test('foreign synthetic owner stays bound to its own workspace; wrong session cannot pass',async()=>{
  await normalQaLogin(authentication({label:'foreignWorkspace'}));
  await assert.rejects(normalQaLogin(authentication({badSession:true})),/BINDING/);
});
test('no MFA confirmation after private persistence failure, no external redirect, no account impersonation',async()=>{
  const failed=authentication({privateFailure:true});await assert.rejects(normalQaLogin(failed),/private storage/);
  assert.equal(failed.calls.filter(v=>v.pathname==='/api/auth/login').length,1);
  const redirected=authentication({externalRedirect:true});await assert.rejects(normalQaLogin(redirected),/CHALLENGE/);
  assert.equal(redirected.calls.length,1);
  const impersonated=authentication();impersonated.account.email='someone@example.com';
  await assert.rejects(normalQaLogin(impersonated),/SYNTHETIC_LOGIN/);assert.equal(impersonated.calls.length,0);
});
test('bounded rendered enrollment rejects missing, duplicate and unexpected recovery material',()=>{
  assert.throws(()=>parseEnrollmentHtml('<code>'+createTotpSecret()+'</code>'),/NOT_RECOGNIZED/);
  assert.throws(()=>parseEnrollmentHtml('x'.repeat(2_000_001)),/BOUNDED/);
});

test('migration checksum matches db-migrate LF normalization without ignoring real SQL changes',()=>{
  const lf="select 1;\n-- canonical migration\n";
  assert.equal(migrationChecksum(lf),migrationChecksum(lf.replaceAll('\n','\r\n')));
  assert.notEqual(migrationChecksum(lf),migrationChecksum(lf.replace('select 1','select 2')));
  assert.notEqual(migrationChecksum(lf),migrationChecksum(lf+' '));
});

test('internal fixture technical owners use existing novalureAdmin rather than a customer category',async()=>{
  const db=database();await seedLoginFixtures(db,makeCredentials(),{persistPrivateCredentials:async()=>{}});
  const inserts=db.calls.filter(c=>c.sql.startsWith('insert into workspace_users'));
  assert.equal(inserts.length,2);assert.ok(inserts.every(c=>c.sql.includes("'owner','novalureAdmin','active'")));
  assert.equal(hasProductCapability('novalureAdmin','novalure:internal'),true);
  assert.equal(mapProductRoleToTechnicalRole('novalureAdmin'),'owner');
  assert.equal(hasProductCapability('customer_owner','novalure:internal'),false);
});
