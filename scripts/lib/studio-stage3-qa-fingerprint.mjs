import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { neon061SourceChecksum, renderNeon061Compatibility } from './neon-061-compat.mjs';
export const qaProject = 'weathered-term-98273025', sourceBranch = 'br-spring-snow-alupo8u4';
export const restoreProject = 'super-block-59791927', restoreBranch = 'br-ancient-term-awip1q3q';
const sourceDatabase = 'qa_g24_pr63_20260917_r3', seedWorkspace = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101';
const identifier = (value) => '"' + value.replaceAll('"', '""') + '"';
export const canonical = (value) => value instanceof Date ? JSON.stringify(value.toISOString()) : value === null || typeof value !== 'object' ? JSON.stringify(value) :
  Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
    '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const safe = (condition, code) => { assert.ok(condition, code); };
export function validateTarget(target) {
  safe(target?.roleName === 'neondb_owner', 'PINNED_QA_OWNER_REQUIRED');
  safe(['source', 'restore'].includes(target.mode), 'EXPLICIT_CAPTURE_MODE_REQUIRED');
  safe(/^[a-z][a-z0-9_]{0,62}$/u.test(target.databaseName || ''), 'INVALID_DATABASE_NAME');
  safe(/^br-[a-z0-9-]{8,90}$/u.test(target.branchId || ''), 'INVALID_BRANCH_ID');
  if (target.mode === 'source') safe(target.projectId === qaProject && target.branchId === sourceBranch &&
    target.databaseName === sourceDatabase, 'PINNED_G24_SOURCE_REQUIRED');
  else safe(target.projectId === restoreProject && target.branchId === restoreBranch &&
    target.databaseName === 'neondb', 'PINNED_G27_RESTORE_REQUIRED');
  return target;
}
const knownTables = new Set(['novalure_schema_migrations', 'novalure_migration_execution_receipts',
  'workspaces', 'projects', 'workspace_users', 'project_pipeline_permissions', 'organizations', 'contacts',
  'tasks', 'property_units', 'leads', 'crm_command_receipts', 'crm_pipelines', 'crm_pipeline_stages',
  'workspace_lead_sources', 'workspace_module_settings', 'bots', 'knowledge_sources', 'funnels', 'audit_logs', 'company_profiles', 'auth_identities']);
export const originalOperatorSeed = Object.freeze({
  profile_scope: 'platform_operator', workspace_id: null, organization_id: null,
  legal_name: 'Novalure CLG', display_name: 'Novalure CLG',
  legal_form: 'A company limited by guarantee incorporated under the laws of Ireland',
  country_code: 'IE', jurisdiction: 'Dublin, Ireland', registration_number: '796735',
  registration_authority: 'Companies Registration Office (CRO), Ireland',
  register_court: '', vat_id: '', tax_number: '',
  registered_office_address: '20 Harcourt Street, Dublin 2, D02 H364, Ireland',
  business_address: '20 Harcourt Street, Dublin 2, D02 H364, Ireland', billing_address: '',
  public_email: 'hello@novalure.eu', public_phone: '+353 (0)89 269 5248', website: 'https://www.novalure-crm.app',
  representatives: [], privacy_contact: 'hello@novalure.eu', dpo_contact: '', licenses: {},
  brand: { businessName: 'Novalure CLG' },
  usage_settings: { imprint: true, privacy: true, emails: true, legalFooter: true, botDisclosures: true },
  // Original 078 revokes the unverified approval created by 036.
  status: 'needs_review', approved_by_user_id: null, approved_at: null
});
export function matchesOriginalOperatorSeed(row) {
  const metadata = new Set(['id', 'created_at', 'updated_at', 'approved_at', 'version']);
  return Object.entries(originalOperatorSeed).every(([key, value]) => canonical(row[key]) === canonical(value)) &&
    Object.keys(row).every((key) => key in originalOperatorSeed || metadata.has(key)) &&
    (row.version === undefined || row.version === 1);
}
export function classifyAuthIdentityLinks(identities, users) {
  if (!identities.length && !users.length) return { status: 'NOT_PRESENT', identities: 0, users: 0, linked: 0 };
  const linked = users.filter((user) => user.name?.startsWith('SYNTHETIC ') && /^[^\s@]+@[^\s@]+\.invalid$/iu.test(user.email || '') &&
    identities.filter((identity) => identity.id === user.auth_identity_id &&
      identity.normalized_email === user.email.trim().toLowerCase() && identity.display_email === user.email.trim()).length === 1).length;
  const valid = identities.length === 3 && users.length === 3 && linked === 3 &&
    new Set(identities.map((identity) => identity.id)).size === 3 && new Set(users.map((user) => user.auth_identity_id)).size === 3;
  return { status: valid ? 'PASS' : 'FAIL', identities: identities.length, users: users.length, linked };
}
export function classifyQaRows(table, rows) {
  let unknownMarkers = 0, contactExceptions = 0, credentialFields = 0;
  const inspect = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string' && entry.trim() && /(?:^|_)(?:email|phone|mobile|password_hash|access_token|refresh_token|client_secret|api_key|mfa_secret_ciphertext)$/iu.test(key)) {
        if (/email$/iu.test(key)) { if (!/^[^\s@]+@[^\s@]+\.invalid$/iu.test(entry)) contactExceptions += 1; }
        else if (/(?:phone|mobile)$/iu.test(key)) contactExceptions += 1;
        else credentialFields += 1;
      } else if (entry && typeof entry === 'object') inspect(entry);
    }
  };
  for (const row of rows) {
    const exactOperator = table === 'company_profiles' && rows.length === 1 && matchesOriginalOperatorSeed(row);
    if (!exactOperator) inspect(row);
    if (table === 'company_profiles' && !exactOperator) unknownMarkers += 1;
    if (table === 'workspaces' && !(row.id === seedWorkspace && row.name === 'Novalure Growth' &&
        row.setup_state?.createdByMigration === '030_novalure_growth_workspace') &&
        !(row.name?.startsWith('SYNTHETIC ') && row.setup_state?.syntheticQa === true)) unknownMarkers += 1;
    if (['workspace_users', 'contacts', 'organizations'].includes(table) && !row.name?.startsWith('SYNTHETIC ')) unknownMarkers += 1;
    if (table === 'projects' && row.id !== 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2' && !row.name?.startsWith('SYNTHETIC ')) unknownMarkers += 1;
    if (table === 'tasks' && !row.title?.startsWith('SYNTHETIC ')) unknownMarkers += 1;
    if (table === 'property_units' && !row.unit_number?.startsWith('SYNTHETIC-')) unknownMarkers += 1;
    if (table === 'crm_command_receipts' && !row.operation?.startsWith('SYNTHETIC_')) unknownMarkers += 1;
    if (table === 'audit_logs' && row.action !== 'workspace.seeded' && !row.action?.startsWith('SYNTHETIC_')) unknownMarkers += 1;
  }
  return { table, rows: rows.length, knownSeedOrFixtureTable: knownTables.has(table), unknownMarkers, contactExceptions, credentialFields };
}
export const databaseQueries = Object.freeze({
  properties: "select owner.rolname as owner,pg_encoding_to_char(d.encoding) as encoding,d.datcollate as collation,d.datctype as ctype,d.datlocprovider as locale_provider,coalesce(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale') as locale,to_jsonb(d)->>'daticurules' as icu_rules,d.datcollversion as collation_version,d.datallowconn as allow_connections,d.datistemplate as is_template,d.datconnlimit as connection_limit from pg_database d join pg_roles owner on owner.oid=d.datdba where d.datname=current_database()",
  acl: "select case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_database d cross join lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where d.datname=current_database() order by grantee,grantor,a.privilege_type,a.is_grantable",
  settings: "select case when s.setdatabase=0 then 'ALL_DATABASES' else 'CURRENT_DATABASE' end as database_scope,case when s.setrole=0 then 'ALL_ROLES' else role.rolname end as role_name,setting.value as setting from pg_db_role_setting s left join pg_roles role on role.oid=s.setrole cross join lateral unnest(s.setconfig) as setting(value) where s.setdatabase in (0,(select oid from pg_database where datname=current_database())) order by database_scope,role_name,setting.value"
});
export async function captureDatabaseMetadata(client) {
  const properties = (await client.query(databaseQueries.properties)).rows;
  safe(properties.length === 1 && typeof properties[0].owner === 'string', 'DATABASE_OWNER_METADATA_MISSING');
  const acl = (await client.query(databaseQueries.acl)).rows;
  safe(acl.length > 0, 'EFFECTIVE_DATABASE_ACL_MISSING');
  const rawSettings = (await client.query(databaseQueries.settings)).rows;
  const settings = rawSettings.map((row) => {
    const equal = typeof row.setting === 'string' ? row.setting.indexOf('=') : -1;
    safe(equal > 0, 'DATABASE_SETTING_METADATA_INVALID');
    return { database_scope: row.database_scope, role_name: row.role_name,
      name: row.setting.slice(0, equal), valueSha256: hash(row.setting.slice(equal + 1)) };
  }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const normalized = { properties: properties[0], acl, settings };
  return { ...normalized, owner: properties[0].owner, sha256: hash(canonical(normalized)) };
}
export const catalogQueries = {
      namespaces: "select n.nspname,r.rolname as owner from pg_namespace n join pg_roles r on r.oid=n.nspowner where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' order by n.nspname",
      enums: "select t.typname,e.enumlabel,e.enumsortorder from pg_type t join pg_enum e on e.enumtypid=t.oid where t.typnamespace='public'::regnamespace order by t.typname,e.enumsortorder",
      domains: "select t.typname,format_type(t.typbasetype,t.typtypmod) as base,t.typnotnull,t.typdefault from pg_type t where t.typnamespace='public'::regnamespace and t.typtype='d' order by t.typname",
      extensions: "select e.extname,e.extversion,n.nspname as schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname",
      tables: "select c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,r.rolname as owner,c.reloptions,pg_get_partkeydef(c.oid) as partition_key from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','S','f') order by c.relname",
      columns: "select c.relname,(row_number() over(partition by c.relname order by a.attnum))::int as ordinal_position,a.attname,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) as default_expression,case when a.attcollation=0 then null else cn.nspname||'.'||co.collname end as collation from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum left join pg_collation co on co.oid=a.attcollation left join pg_namespace cn on cn.oid=co.collnamespace where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','f') and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum",
      constraints: "select c.conname,coalesce(r.relname,'') as relation,c.contype,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid,false) as definition from pg_constraint c left join pg_class r on r.oid=c.conrelid where c.connamespace='public'::regnamespace order by relation,c.conname",
      indexes: "select t.relname as relation,i.relname as name,x.indisunique,x.indisprimary,x.indisvalid,x.indisready,x.indimmediate,x.indnullsnotdistinct,pg_get_indexdef(i.oid) as definition from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid where t.relnamespace='public'::regnamespace order by t.relname,i.relname",
      policies: "select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname",
      functions: "select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,r.rolname as owner,p.prosecdef,p.proleakproof,p.provolatile,p.proparallel,p.proconfig,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_roles r on r.oid=p.proowner where p.pronamespace='public'::regnamespace and p.prokind in('f','p') order by p.proname,arguments",
      triggers: "select c.relname as relation,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,false) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by c.relname,t.tgname",
      views: "select c.relname,pg_get_viewdef(c.oid,false) as definition from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('v','m') order by c.relname",
      roles: "select rolname,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolconfig from pg_roles where rolname !~ '^pg_' order by rolname",
      memberships: "select parent.rolname as parent,member.rolname as member,grantor.rolname as grantor,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member join pg_roles grantor on grantor.oid=m.grantor order by parent.rolname,member.rolname,grantor.rolname",
      relationGrants: "select c.relname,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::\"char\" else 'r'::\"char\" end,c.relowner))) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where c.relnamespace='public'::regnamespace and c.relkind in('r','p','v','m','S','f') order by c.relname,grantee,grantor,a.privilege_type",
      columnGrants: "select c.relname,col.attname,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_attribute col join pg_class c on c.oid=col.attrelid cross join lateral aclexplode(col.attacl) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where c.relnamespace='public'::regnamespace and col.attnum>0 and not col.attisdropped order by c.relname,col.attname,grantee,grantor,a.privilege_type",
      functionGrants: "select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where p.pronamespace='public'::regnamespace order by p.proname,arguments,grantee,grantor,a.privilege_type",
      schemaGrants: "select n.nspname,owner.rolname as owner,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_namespace n join pg_roles owner on owner.oid=n.nspowner cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where n.nspname='public' order by grantee,grantor,a.privilege_type",
      defaultGrants: "select owner.rolname as owner,coalesce(n.nspname,'ALL_SCHEMAS') as schema,d.defaclobjtype,case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable from pg_default_acl d join pg_roles owner on owner.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor where d.defaclnamespace=0 or n.nspname='public' order by owner.rolname,schema,d.defaclobjtype,grantee,grantor,a.privilege_type",
      sequences: "select sequencename,sequenceowner,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value from pg_sequences where schemaname='public' order by sequencename",
};

// The restore profile is deliberately limited to the two verified G24 extensions.
// PostgreSQL's native archive does not pin CREATE EXTENSION to the source version.
export const sourceExtensions = Object.freeze([
  Object.freeze({ name: 'pgcrypto', version: '1.3', schema: 'public', owner: 'neondb_owner' }),
  Object.freeze({ name: 'vector', version: '0.8.0', schema: 'public', owner: 'neondb_owner' })
]);
const extensionMembers = `with recursive members(classid,objid,objsubid) as (
  select d.classid,d.objid,d.objsubid from pg_depend d join pg_extension e on d.refclassid='pg_extension'::regclass and d.refobjid=e.oid
  where d.deptype='e' and e.extname in ('pgcrypto','vector')
  union
  select d.classid,d.objid,d.objsubid from pg_depend d join members m on d.refclassid=m.classid and d.refobjid=m.objid
  where d.deptype in ('i','a')
)`;
const objectIdentity = "m.classid::regclass::text as catalog,i.type as object_type,i.schema as schema,i.name as name,i.identity as identity";
export const extensionQueries = {
  server: "select current_setting('server_version') as version,current_setting('server_version_num')::int as version_num",
  installed: "select e.extname as name,e.extversion as version,n.nspname as schema,r.rolname as owner from pg_extension e join pg_namespace n on n.oid=e.extnamespace join pg_roles r on r.oid=e.extowner order by e.extname",
  available: "select name,version from pg_available_extension_versions where name in ('pgcrypto','vector') order by name,version",
  // OIDs differ between projects: retain semantic identities, definitions and owners.
  members: extensionMembers + ` select ${objectIdentity},case m.classid
    when 'pg_proc'::regclass then (select case when p.prokind='a' then
      jsonb_build_object('owner',pg_get_userbyid(p.proowner),'kind',p.prokind,
        'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid),
        'security_definer',p.prosecdef,'leakproof',p.proleakproof,'strict',p.proisstrict,
        'volatility',p.provolatile,'parallel',p.proparallel,'configuration',p.proconfig,
        'aggregate',(select jsonb_build_object('kind',a.aggkind,'direct_arguments',a.aggnumdirectargs,
          'transition',a.aggtransfn::regprocedure::text,'final',a.aggfinalfn::regprocedure::text,
          'combine',a.aggcombinefn::regprocedure::text,'serialize',a.aggserialfn::regprocedure::text,
          'deserialize',a.aggdeserialfn::regprocedure::text,'moving_transition',a.aggmtransfn::regprocedure::text,
          'moving_inverse',a.aggminvtransfn::regprocedure::text,'moving_final',a.aggmfinalfn::regprocedure::text,
          'final_extra',a.aggfinalextra,'moving_final_extra',a.aggmfinalextra,
          'final_modify',a.aggfinalmodify,'moving_final_modify',a.aggmfinalmodify,
          'sort_operator',a.aggsortop::regoperator::text,'transition_type',format_type(a.aggtranstype,null),
          'transition_space',a.aggtransspace,'moving_transition_type',format_type(a.aggmtranstype,null),
          'moving_transition_space',a.aggmtransspace,'initial_value',a.agginitval,'moving_initial_value',a.aggminitval)
          from pg_aggregate a where a.aggfnoid=p.oid))
      else jsonb_build_object('owner',pg_get_userbyid(p.proowner),'definition',pg_get_functiondef(p.oid)) end
      from pg_proc p where p.oid=m.objid)
    when 'pg_type'::regclass then (select jsonb_build_object('owner',pg_get_userbyid(t.typowner),'length',t.typlen,'by_value',t.typbyval,'kind',t.typtype,'category',t.typcategory,'preferred',t.typispreferred,'defined',t.typisdefined,'delimiter',t.typdelim,'element',format_type(t.typelem,null),'base',format_type(t.typbasetype,t.typtypmod),'input',t.typinput::regprocedure::text,'output',t.typoutput::regprocedure::text,'receive',t.typreceive::regprocedure::text,'send',t.typsend::regprocedure::text,'modifier_in',t.typmodin::regprocedure::text,'modifier_out',t.typmodout::regprocedure::text,'analyze',t.typanalyze::regprocedure::text,'subscript',t.typsubscript::regprocedure::text,'alignment',t.typalign,'storage',t.typstorage,'not_null',t.typnotnull,'default',t.typdefault) from pg_type t where t.oid=m.objid)
    when 'pg_operator'::regclass then (select jsonb_build_object('owner',pg_get_userbyid(o.oprowner),'kind',o.oprkind,'merge',o.oprcanmerge,'hash',o.oprcanhash,'left',format_type(o.oprleft,null),'right',format_type(o.oprright,null),'result',format_type(o.oprresult,null),'function',o.oprcode::regprocedure::text,'commutator',o.oprcom::regoperator::text,'negator',o.oprnegate::regoperator::text,'restriction',o.oprrest::regprocedure::text,'join',o.oprjoin::regprocedure::text) from pg_operator o where o.oid=m.objid)
    when 'pg_cast'::regclass then (select jsonb_build_object('source',format_type(c.castsource,null),'target',format_type(c.casttarget,null),'function',c.castfunc::regprocedure::text,'context',c.castcontext,'method',c.castmethod) from pg_cast c where c.oid=m.objid)
    when 'pg_am'::regclass then (select jsonb_build_object('type',a.amtype,'handler',a.amhandler::regprocedure::text) from pg_am a where a.oid=m.objid)
    when 'pg_opclass'::regclass then (select jsonb_build_object('owner',pg_get_userbyid(c.opcowner),'method',a.amname,'family',n.nspname||'.'||f.opfname,'input',format_type(c.opcintype,null),'default',c.opcdefault,'key',format_type(c.opckeytype,null)) from pg_opclass c join pg_am a on a.oid=c.opcmethod join pg_opfamily f on f.oid=c.opcfamily join pg_namespace n on n.oid=f.opfnamespace where c.oid=m.objid)
    when 'pg_opfamily'::regclass then (select jsonb_build_object('owner',pg_get_userbyid(f.opfowner),'method',a.amname) from pg_opfamily f join pg_am a on a.oid=f.opfmethod where f.oid=m.objid)
    when 'pg_amop'::regclass then (select jsonb_build_object('family',n.nspname||'.'||f.opfname,'method',a.amname,'left',format_type(o.amoplefttype,null),'right',format_type(o.amoprighttype,null),'strategy',o.amopstrategy,'purpose',o.amoppurpose,'operator',o.amopopr::regoperator::text,'sort_family',sn.nspname||'.'||sf.opfname) from pg_amop o join pg_opfamily f on f.oid=o.amopfamily join pg_namespace n on n.oid=f.opfnamespace join pg_am a on a.oid=o.amopmethod left join pg_opfamily sf on sf.oid=o.amopsortfamily left join pg_namespace sn on sn.oid=sf.opfnamespace where o.oid=m.objid)
    when 'pg_amproc'::regclass then (select jsonb_build_object('family',n.nspname||'.'||f.opfname,'left',format_type(p.amproclefttype,null),'right',format_type(p.amprocrighttype,null),'number',p.amprocnum,'function',p.amproc::regprocedure::text) from pg_amproc p join pg_opfamily f on f.oid=p.amprocfamily join pg_namespace n on n.oid=f.opfnamespace where p.oid=m.objid)
    else null end as definition
    from members m cross join lateral pg_identify_object(m.classid,m.objid,m.objsubid) i
    order by catalog,identity,object_type`,
  privileges: extensionMembers + ` select m.classid::regclass::text as catalog,i.identity as identity,
    case when a.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,grantor.rolname as grantor,a.privilege_type,a.is_grantable
    from members m cross join lateral pg_identify_object(m.classid,m.objid,m.objsubid) i
    left join pg_proc p on m.classid='pg_proc'::regclass and p.oid=m.objid
    left join pg_type t on m.classid='pg_type'::regclass and t.oid=m.objid
    cross join lateral aclexplode(case when p.oid is not null then coalesce(p.proacl,acldefault('f',p.proowner)) when t.oid is not null then coalesce(t.typacl,acldefault('T',t.typowner)) else null end) a
    left join pg_roles grantee on grantee.oid=a.grantee join pg_roles grantor on grantor.oid=a.grantor
    order by catalog,identity,grantee,grantor,a.privilege_type`,
  userObjects: `with recursive objects(classid,objid,objsubid) as (
    select d.classid,d.objid,d.objsubid from pg_depend d join pg_namespace n on d.refclassid='pg_namespace'::regclass and d.refobjid=n.oid
    where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
    union
    select d.classid,d.objid,d.objsubid from pg_depend d join objects o on d.refclassid=o.classid and d.refobjid=o.objid
  ) select ${objectIdentity} from objects m cross join lateral pg_identify_object(m.classid,m.objid,m.objsubid) i order by catalog,identity,object_type`,
  globalObjects: "select (select count(*)::int from pg_event_trigger)+(select count(*)::int from pg_foreign_data_wrapper)+(select count(*)::int from pg_foreign_server)+(select count(*)::int from pg_publication)+(select count(*)::int from pg_default_acl)+(select count(*)::int from pg_largeobject_metadata) as count"
};
export const identityHash = (rows) => hash(canonical(rows.map(({ catalog, object_type, schema, name, identity }) =>
  ({ catalog, object_type, schema, name, identity })).sort((a, b) => canonical(a).localeCompare(canonical(b)))));
export async function captureExtensionMetadata(client) {
  const server = (await client.query(extensionQueries.server)).rows[0];
  safe(server && Number.isInteger(server.version_num), 'SERVER_VERSION_METADATA_REQUIRED');
  const extensions = (await client.query(extensionQueries.installed)).rows;
  const members = (await client.query(extensionQueries.members)).rows;
  safe(members.every((row) => row.definition !== null && row.definition !== undefined), 'EXTENSION_MEMBER_CATALOG_UNSUPPORTED');
  const privileges = (await client.query(extensionQueries.privileges)).rows;
  const namespaces = (await client.query(catalogQueries.namespaces)).rows;
  const schemaGrants = (await client.query(catalogQueries.schemaGrants)).rows;
  const normalized = { extensions, memberCount: members.length, structureSha256: hash(canonical(members)),
    memberIdentitiesSha256: identityHash(members), privileges, namespaces, schemaGrants };
  return { format: 'studio-stage3-source-extension-profile-v1', server, ...normalized, sha256: hash(canonical(normalized)) };
}

/** Read-only SQL only: never creates ledger rows, schema, roles, credentials or fixtures. */
export async function captureQaDatabase({ client, target, manifest, sql061 }) {
  validateTarget(target);
  await client.query('begin isolation level repeatable read read only');
  try {
    await client.query('set local search_path=pg_catalog,public');
    await client.query("set local timezone='UTC'");
    await client.query("set local statement_timeout='30s'");
    const identity = (await client.query("select current_setting('neon.project_id',true) as project,current_setting('neon.branch_id',true) as branch,current_database() as database,current_user as role,session_user as session_role,current_setting('transaction_read_only') as read_only")).rows[0];
    safe(identity?.project === target.projectId && identity.branch === target.branchId && identity.database === target.databaseName &&
      identity.role === target.roleName && identity.session_role === target.roleName && identity.read_only === 'on', 'CONNECTED_QA_READONLY_IDENTITY_MISMATCH');
    const database = await captureDatabaseMetadata(client);
    safe(database.owner === 'neondb_owner', 'PINNED_DATABASE_OWNER_REQUIRED');
    const catalog = {};
    for (const [name, sql] of Object.entries(catalogQueries)) catalog[name] = (await client.query(sql)).rows;
    const extensionProfile = await captureExtensionMetadata(client);
    const categories = Object.fromEntries(Object.entries(catalog).map(([name, rows]) => [name, { count: rows.length, sha256: hash(canonical(rows)) }]));
    const exists = async (name) => Boolean((await client.query('select to_regclass($1) as relation', ['public.' + name])).rows[0]?.relation);
    const ledger = await exists('novalure_schema_migrations') ? (await client.query('select version,name,checksum,applied_at from public.novalure_schema_migrations order by version')).rows : [];
    const receipts = await exists('novalure_migration_execution_receipts') ? (await client.query('select * from public.novalure_migration_execution_receipts order by source_version,id')).rows : [];
    const expected = new Map(manifest.map((item) => [item.version, item]));
    const ledgerVerified = ledger.length > 0 && ledger.every((row) => expected.get(row.version)?.checksum === row.checksum && expected.get(row.version)?.name === row.name);
    const through = Math.max(0, ...ledger.map((row) => Number(String(row.version).slice(0, 3)) || 0));
    const expectedLedger = manifest.filter((item) => item.number >= 41 && item.number <= through);
    const completeLedger = ledgerVerified && expectedLedger.length === ledger.length && expectedLedger.every((item) => ledger.some((row) => row.version === item.version));
    const ledger061 = ledger.find((row) => row.version === '061_validate_and_activate_tenant_rls_pilot');
    const receipt061 = receipts.filter((row) => row.source_version === '061_validate_and_activate_tenant_rls_pilot');
    const executed061 = renderNeon061Compatibility(sql061).executedSqlChecksum;
    const receiptVerified = Boolean(ledger061 && ledger061.checksum === neon061SourceChecksum && receipt061.length === 1 &&
      receipt061[0].source_checksum === neon061SourceChecksum && receipt061[0].executed_sql_checksum === executed061 &&
      receipt061[0].target?.projectId === qaProject && receipt061[0].target?.branchId === sourceBranch && receipt061[0].target?.databaseName === sourceDatabase);
    const data = [], markers = [], linkageRows = {};
    let totalRows = 0;
    for (const table of catalog.tables.filter((row) => ['r', 'p', 'm'].includes(row.relkind))) {
      const rows = (await client.query('select to_jsonb(t)::text as canonical from public.' + identifier(table.relname) + ' t order by (to_jsonb(t)::text) collate "C" limit 10001')).rows;
      safe(rows.length <= 10000, 'QA_TABLE_ROW_BOUND_EXCEEDED'); totalRows += rows.length;
      safe(totalRows <= 100000, 'QA_DATABASE_ROW_BOUND_EXCEEDED');
      const digest = createHash('sha256'); for (const row of rows) digest.update(row.canonical + '\n');
      data.push({ table: table.relname, rows: rows.length, sha256: digest.digest('hex') });
      const parsed = rows.map((row) => JSON.parse(row.canonical));
      markers.push(classifyQaRows(table.relname, parsed));
      if (['auth_identities', 'workspace_users'].includes(table.relname)) linkageRows[table.relname] = parsed;
    }
    const active = markers.filter((row) => row.rows > 0);
    const identityLinks = classifyAuthIdentityLinks(linkageRows.auth_identities || [], linkageRows.workspace_users || []);
    const exceptions = (identityLinks.status === 'FAIL' ? 1 : 0) + active.reduce((sum, row) => sum + row.unknownMarkers + row.contactExceptions + row.credentialFields, 0);
    const unclassifiedTables = active.filter((row) => !row.knownSeedOrFixtureTable).map((row) => row.table);
    const unclassifiedSchemas = catalog.namespaces.filter((row) => row.nspname !== 'public').map((row) => row.nspname);
    const databaseCatalog = Object.fromEntries(Object.entries(catalog).filter(([name]) => !['roles', 'memberships'].includes(name)));
    const report = { format: 'studio-stage3-qa-readonly-fingerprint-v3', databaseName: target.databaseName,
      projectId: target.projectId, branchId: target.branchId, readOnlyTransaction: true, database, extensionProfile,
      schema: { sha256: hash(canonical(databaseCatalog)), categories,
        clusterRolesSha256: hash(canonical({ roles: catalog.roles, memberships: catalog.memberships })) },
      ledger: { rows: ledger.length, through, sha256: hash(canonical(ledger)), verifiedCommittedChecksums: ledgerVerified, completeCanonicalCoverage: completeLedger },
      executionReceipts: { rows: receipts.length, sha256: hash(canonical(receipts)), original061Verified: receiptVerified },
      data: { tables: data.length, rows: totalRows, sha256: hash(canonical(data)), fingerprints: data },
      classification: { markerChecks: exceptions === 0 && unclassifiedTables.length === 0 && unclassifiedSchemas.length === 0 ? 'PASS_NARROW_MARKER_CHECKS' : 'REVIEW_REQUIRED',
        markerExceptions: exceptions, unclassifiedTables, unclassifiedSchemas, authIdentityLinkage: identityLinks, tableChecks: active,
        historicalG24CountsMatch: catalog.tables.length === 143 && catalog.columns.length === 2238 && catalog.constraints.length === 993 && ledger.length === 42 && data.length === 141 && totalRows === 118 },
      limitations: [
        'Marker checks are not a complete PII or free-text classification. Unknown/unclassified data requires host-side owner review before cloning.',
        'No ledger is inserted or re-created. The 061 receipt preserves its actual original execution target.',
        'Fingerprints cover all public stored rows and the listed OID-free public catalog/role/ACL categories, not native restore or provider parent/LSN proof.',
        'Matching counts do not prove matching data. Compare source-before, source-after and restored hashes before later migrations.',
        'Cluster role hashes can differ across projects; independently attest each required safe role/membership and preserve all database ACLs.',
        'No schema, role, provider, credential or application binding is mutated.'
      ] };
    await client.query('rollback'); return report;
  } catch (error) { await client.query('rollback'); throw error; }
}
