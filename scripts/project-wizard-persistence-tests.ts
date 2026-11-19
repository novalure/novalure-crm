import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { startLocalSalesDb, applySalesSchema } from './lib/local-sales-db.mjs';
import type { AppSession } from '../src/lib/auth/session';
import { getRolePermissions } from '../src/lib/auth/permissions';
import { getProductRoleCapabilities } from '../src/lib/product-model';
import { withCrmRead } from '../src/lib/crm-command';
import type { TenantPool } from '../src/lib/db/tenant-client';
import { createProjectRecord, updateProjectRecord } from '../src/lib/db/crm-write-repositories';
import { getProjectWizardOptions, getProjectWizardDetails, validateProjectWizardCreate } from '../src/lib/db/project-wizard-repository';
import { getCoreCrmData, loadProjects } from '../src/lib/db/crm-loaders';
import { executeSalesHttp, reconcileSalesHttp, type SalesHttpRequest } from '../src/lib/crm-sales-http';
import { getDefaultPipelineTemplates } from '../src/lib/db/pipeline-default-repositories';
import { projectWizardTypeKeys, type ProjectWizardInput } from '../src/lib/project-wizard';
import type { Project } from '../src/lib/crm-types';

test('project wizard: atomic local PostgreSQL persistence, references and actor-private notes', { timeout: 180000 }, async t => {
  const db = await startLocalSalesDb();
  const names = ['DATABASE_URL', 'CRM_LOCAL_TEST_DATABASE', 'NODE_ENV'];
  const oldEnv = Object.fromEntries(names.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw Error('Network forbidden in project wizard DB tests'); };
  try {
    await applySalesSchema(db, { maxMigrationNumber: 195 });
    await db.admin.query('begin');
    try { await db.admin.query(await readFile('migrations/197_project_wizard_fields.sql', 'utf8')); await db.admin.query('commit'); }
    catch (error) { await db.admin.query('rollback'); throw error; }
    Object.assign(process.env, { DATABASE_URL: `postgresql://${db.role}@127.0.0.1:${db.port}/postgres`, CRM_LOCAL_TEST_DATABASE: '1', NODE_ENV: 'test' });
    const options = { pool: db.pool as unknown as TenantPool };
    const ws = randomUUID(), otherWs = randomUUID(), actor = randomUUID(), peer = randomUUID(), reader = randomUUID(), foreign = randomUUID(), suspended = randomUUID(), partnerAdmin = randomUUID(), nonInternal = randomUUID();
    await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC Wizard','novalure_internal','novalure_internal'),($2,'SYNTHETIC Other','novalure_internal','novalure_internal')", [ws, otherWs]);
    for (const [id, workspace, role, productRole, status] of [[actor, ws, 'owner', 'novalureAdmin', 'active'], [peer, ws, 'admin', 'novalureAdmin', 'active'], [reader, ws, 'agent', 'team_member', 'active'], [foreign, otherWs, 'owner', 'novalureAdmin', 'active'], [suspended, ws, 'admin', 'novalureAdmin', 'suspended'], [partnerAdmin, ws, 'admin', 'external_partner', 'active'], [nonInternal, ws, 'admin', 'customer_owner', 'active']]) {
      await db.admin.query('insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,$3,$4,$5,$6,$7)', [id, workspace, 'SYNTHETIC '+id, id+'@example.invalid', role, productRole, status]);
    }
    const session = (userId = actor, workspaceId = ws): AppSession => ({ authenticated: true, source: 'database', userId, workspaceId, name: 'Synthetic', email: userId+'@example.invalid', workspaceName: 'Synthetic', role: 'owner', productRole: 'novalureAdmin', permissions: getRolePermissions('owner'), productPermissions: getProductRoleCapabilities('novalureAdmin'), workspaceCustomerType: 'novalure_internal', workspaceOperatingModel: 'novalure_internal' });
    const sourceProject = randomUUID(), sourceFunnel = randomUUID(), foreignProject = randomUUID(), foreignFunnel = randomUUID();
    await db.admin.query("insert into projects(id,workspace_id,name,type) values($1,$2,'SYNTHETIC source','Legacy unchanged'),($3,$4,'SYNTHETIC foreign','Legacy unchanged')", [sourceProject, ws, foreignProject, otherWs]);
    await db.admin.query("insert into funnels(id,workspace_id,project_id,owner_user_id,name,goal,audience,entry_channel,status,tracking) values($1,$2,$3,$4,'SOURCE_TITLE_NOT_IN_RECEIPT','Lead','Buyer','Website','entwurf','{}'),($5,$6,$7,$8,'FOREIGN_TITLE','Lead','Buyer','Website','entwurf','{}')", [sourceFunnel, ws, sourceProject, actor, foreignFunnel, otherWs, foreignProject, foreign]);
    const wizard = (patch: Partial<ProjectWizardInput> = {}): ProjectWizardInput => ({ schemaVersion: 1, expectedActorId: actor, typeKey: 'real_estate_project', responsibleUserId: peer, funnelReferenceId: sourceFunnel, pipelineTemplateKey: 'novalure_sales_pipeline', privateNotes: 'PRIVATE_WIZARD_TEXT_ÄÖÜ\nOnly its author may read this.', ...patch });
    const create = async (intent = wizard(), name = 'SYNTHETIC Wizard project') => createProjectRecord({ session: session(), project: { workspaceId: ws, name, type: intent.typeKey, customerType: 'novalure_internal', defaultOperatingModel: 'novalure_internal', setupDefaults: { calendarProvider: 'none', meetingProvider: 'manual-link', teamStructure: 'small_team' }, wizard: intent } }, options);
    let saved: Project;

    await t.test('options use current compatible catalogs and only eligible active responsible users', async () => {
      const result = await getProjectWizardOptions(session(), { customerType: 'novalure_internal', operatingModel: 'novalure_internal' }, options);
      assert.deepEqual(result.responsibleUsers.map(u => u.id).sort(), [actor, peer].sort());
      assert.ok(result.funnelReferences.some(f => f.id === sourceFunnel));
      assert.ok(!result.funnelReferences.some(f => f.id === foreignFunnel));
      for (const [customerType, operatingModel] of [['real_estate_broker', 'self_service_customer'], ['property_developer', 'self_service_customer'], ['novalure_internal', 'novalure_internal'], ['real_estate_broker', 'managed_by_novalure']] as const) {
        const catalog = await getProjectWizardOptions(session(), { customerType, operatingModel }, options);
        assert.deepEqual(catalog.pipelineTemplates.map(p => p.key), getDefaultPipelineTemplates(customerType, operatingModel).map(p => p.key));
      }
      await assert.rejects(getProjectWizardOptions(session(), { customerType: 'unknown' }, options), { code: 'INVALID_CUSTOMER_TYPE' });
      await assert.rejects(getProjectWizardOptions(session(), { operatingModel: 'unknown' }, options), { code: 'INVALID_OPERATING_MODEL' });
    });

    await t.test('preflight rejects stale actor, foreign or ineligible owner, source and incompatible pipeline before any project INSERT', async () => {
      const before = (await db.admin.query('select count(*)::int as n from projects')).rows[0].n;
      for (const patch of [{ expectedActorId: peer }, { responsibleUserId: foreign }, { responsibleUserId: suspended }, { responsibleUserId: reader }, { responsibleUserId: partnerAdmin }, { responsibleUserId: nonInternal }, { funnelReferenceId: foreignFunnel }, { pipelineTemplateKey: 'pipeline_buyer' }]) await assert.rejects(create(wizard(patch)));
      await assert.rejects(createProjectRecord({ session: session(), project: { name: 'No copied UUID', type: 'real_estate_project', defaultPipelineId: randomUUID(), wizard: wizard() } }, options));
      await assert.rejects(createProjectRecord({ session: session(), project: { name: 'No private defaults', type: 'real_estate_project', setupDefaults: { wizard: { privateNotes: 'PRIVATE_DEFAULTS' } }, wizard: wizard() } }, options));
      assert.equal((await db.admin.query('select count(*)::int as n from projects')).rows[0].n, before);
    });

    await t.test('one command saves actual pipeline/stages, safe immutable receipt and exact actor-only notes across reload', async () => {
      const intent = wizard();
      const project: Partial<Project> & { wizard: ProjectWizardInput } = { workspaceId: ws, name: 'SYNTHETIC persisted wizard', type: intent.typeKey, customerType: 'novalure_internal', defaultOperatingModel: 'novalure_internal', setupDefaults: { calendarProvider: 'none', meetingProvider: 'manual-link', teamStructure: 'small_team' }, wizard: intent };
      const request: SalesHttpRequest = { target: '/api/crm/projects?workspaceId='+ws, method: 'POST', body: { project }, idempotencyKey: randomUUID(), correlationId: randomUUID() };
      let creates = 0;
      const callback = async () => { creates++; const result = await createProjectRecord({ session: session(), project }, options); return Response.json(result.persisted ? { persisted: true, project: result.data } : { error: result.reason }, { status: result.persisted ? 200 : 400 }); };
      const response = await executeSalesHttp(session(), request, callback, options);assert.equal(response.status, 200, await response.clone().text());
      const first = await response.json(); saved = first.project;
      assert.equal(saved.wizard?.responsibleUserId, peer); assert.equal(saved.wizard?.funnelReferenceId, sourceFunnel);assert.equal(saved.wizard?.pipelineTemplateKey, intent.pipelineTemplateKey);
      assert.doesNotMatch(JSON.stringify(first), /PRIVATE_WIZARD_TEXT|SOURCE_TITLE_NOT_IN_RECEIPT|expectedActorId|privateNotes/);
      const repeated = await executeSalesHttp(session(), request, callback, options);assert.equal(repeated.status, 200);assert.equal(creates, 1);assert.equal((await repeated.json()).commandId, first.commandId);
      const receipt = await reconcileSalesHttp(session(), request, options);assert.equal(receipt.status, 'COMMITTED');assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_WIZARD_TEXT|SOURCE_TITLE_NOT_IN_RECEIPT|expectedActorId|privateNotes/);
      const row = (await db.admin.query('select p.type,p.version,p.default_pipeline_id,cp.key,(select count(*)::int from crm_pipeline_stages s where s.pipeline_id=cp.id and s.project_id=p.id) as stages from projects p join crm_pipelines cp on cp.id=p.default_pipeline_id and cp.workspace_id=p.workspace_id and cp.project_id=p.id where p.id=$1', [saved.id])).rows[0];
      assert.equal(row.type, intent.typeKey);assert.equal(Number(row.version), saved.version);assert.equal(row.default_pipeline_id, saved.defaultPipelineId);assert.equal(row.key, intent.pipelineTemplateKey);assert.ok(row.stages > 0);
      const loaded = await withCrmRead(session(), () => loadProjects(ws), options);assert.equal(loaded.find(p => p.id === saved.id)?.defaultPipelineId, saved.defaultPipelineId);
      const core = await withCrmRead(session(), () => getCoreCrmData(ws, { session: session() }), options);assert.equal(core.moduleSources.projects, 'database');assert.doesNotMatch(JSON.stringify(core), /PRIVATE_WIZARD_TEXT/);
      const own = await getProjectWizardDetails(session(), saved.id, options);assert.equal(own.privateNotes, intent.privateNotes);assert.equal(own.funnelReferenceTitle, 'SOURCE_TITLE_NOT_IN_RECEIPT');assert.ok(own.responsibleName);
      assert.equal((await getProjectWizardDetails(session(peer), saved.id, options)).privateNotes, '');
      const leaks = await db.admin.query("select to_jsonb(a)::text as text from audit_logs a where workspace_id=$1 union all select to_jsonb(c)::text from crm_command_receipts c where workspace_id=$1 union all select metadata::text from crm_pipelines where workspace_id=$1 union all select setup_defaults::text from projects where workspace_id=$1", [ws]);
      for (const row of leaks.rows) assert.doesNotMatch(row.text, /PRIVATE_WIZARD_TEXT/);
      assert.equal((await db.admin.query('select count(*)::int as n from project_pipeline_permissions where workspace_id=$1 and project_id=$2', [ws, saved.id])).rows[0].n, 0);
      assert.deepEqual((await db.admin.query('select project_id,status,tracking from funnels where id=$1', [sourceFunnel])).rows[0], { project_id: sourceProject, status: 'entwurf', tracking: {} });
    });

    await t.test('raw runtime RLS hides private text even from another manager and rejects forged authors and tenants', async () => {
      await withCrmRead(session(peer), async tx => { assert.equal((await tx.query('select private_notes from project_wizard_private_notes where workspace_id=$1', [ws])).length, 0); }, options);
      await assert.rejects(withCrmRead(session(peer), tx => tx.execute('insert into project_wizard_private_notes(workspace_id,project_id,actor_id,private_notes) values($1,$2,$3,$4)', [ws, saved.id, actor, 'FORGED']), options));
      await withCrmRead(session(foreign, otherWs), async tx => { assert.equal((await tx.query('select * from project_wizard_settings where project_id=$1', [saved.id])).length, 0);assert.equal((await tx.query('select * from project_wizard_private_notes where project_id=$1', [saved.id])).length, 0); }, options);
      await assert.rejects(getProjectWizardDetails(session(foreign, otherWs), saved.id, options));
      const flags = (await db.admin.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('project_wizard_settings','project_wizard_private_notes') order by relname")).rows;assert.equal(flags.length, 2);assert.ok(flags.every(r => r.relrowsecurity && r.relforcerowsecurity));
      for (const withStages of [true, false]) {
        const projectId = randomUUID(), pipelineId = randomUUID();
        await db.admin.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,'SYNTHETIC raw binding','real_estate_project',$3,$4)", [projectId, ws, withStages ? 'real_estate_broker' : 'novalure_internal', withStages ? 'self_service_customer' : 'novalure_internal']);
        await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name) values($1,$2,$3,$4,'SYNTHETIC raw pipeline')", [pipelineId, ws, projectId, withStages ? 'developer_project_pipeline' : 'novalure_sales_pipeline']);
        await db.admin.query('update projects set default_pipeline_id=$2 where id=$1', [projectId, pipelineId]);
        if (withStages) await db.admin.query("insert into crm_pipeline_stages(workspace_id,project_id,pipeline_id,key,name,position) values($1,$2,$3,'new','Neu',0)", [ws, projectId, pipelineId]);
        await assert.rejects(withCrmRead(session(), tx => tx.execute("insert into project_wizard_settings(workspace_id,project_id,schema_version,type_key,pipeline_template_key,created_by) values($1,$2,1,'real_estate_project',$3,$4)", [ws, projectId, withStages ? 'developer_project_pipeline' : 'novalure_sales_pipeline', actor]), options), { code: '23514' });
      }
    });

    await t.test('reference names disappear after source access or recipient eligibility is revoked', async () => {
      const readUser = randomUUID();
      await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC project reader',$3,'agent','novalure_sales','active')", [readUser, ws, readUser+'@example.invalid']);
      // A non-manager product role cannot enter internal data; use an internal
      // non-manager role with an explicit project-only grant.
      await db.admin.query("update workspace_users set product_role='novalureServiceOps' where id=$1", [readUser]);
      await db.admin.query('insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals) values($1,$2,$3,true,false)', [ws, saved.id, readUser]);
      const details = await getProjectWizardDetails(session(readUser), saved.id, options);assert.equal(details.funnelReferenceTitle, null);assert.equal(details.privateNotes, '');
      await db.admin.query("update workspace_users set status='suspended' where id=$1", [peer]);
      assert.equal((await getProjectWizardDetails(session(), saved.id, options)).responsibleName, null);
      await db.admin.query('update project_pipeline_permissions set can_read=false where workspace_id=$1 and project_id=$2 and user_id=$3', [ws, saved.id, readUser]);
      await assert.rejects(getProjectWizardDetails(session(readUser), saved.id, options));
      await db.admin.query("update workspace_users set status='active' where id=$1", [peer]);
    });

    await t.test('private-note failure rolls back project, pipelines, settings, audit and command receipt', async () => {
      await db.admin.query("create function qa_reject_wizard_note() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_NOTE_FAILURE';end$$; create trigger qa_reject_wizard_note before insert on project_wizard_private_notes for each row execute function qa_reject_wizard_note()");
      const tables = ['projects', 'crm_pipelines', 'crm_pipeline_stages', 'project_wizard_settings', 'project_wizard_private_notes', 'audit_logs', 'crm_command_receipts'];
      const counts = async () => Promise.all(tables.map(table => db.admin.query(`select count(*)::int as n from ${table} where workspace_id=$1`, [ws]).then(r => r.rows[0].n)));
      const before = await counts();
      const request: SalesHttpRequest = { target: '/api/crm/projects?workspaceId='+ws, method: 'POST', body: { project: { name: 'SYNTHETIC rollback', type: 'real_estate_project', wizard: wizard() } }, idempotencyKey: randomUUID(), correlationId: randomUUID() };
      const response = await executeSalesHttp(session(), request, async () => { const result = await createProjectRecord({ session: session(), project: request.body.project as Partial<Project> & { wizard: ProjectWizardInput } }, options);return Response.json(result.persisted ? { persisted: true, project: result.data } : { error: result.reason }); }, options);
      assert.notEqual(response.status, 200);assert.deepEqual(await counts(), before);
      await db.admin.query('drop trigger qa_reject_wizard_note on project_wizard_private_notes; drop function qa_reject_wizard_note()');
    });

    await t.test('explicit PATCH pipeline must belong to this exact project; legacy type and null choices remain supported', async () => {
      const legacy = await createProjectRecord({ session: session(), project: { name: 'SYNTHETIC Legacy', type: 'Freier Legacytyp' } }, options);assert.ok(legacy.persisted);if (!legacy.persisted) return;
      assert.equal(legacy.data.type, 'Freier Legacytyp');assert.equal((await getProjectWizardDetails(session(), legacy.data.id, options)).typeKey, null);
      await assert.rejects(updateProjectRecord({ session: session(), expectedVersion: saved.version, project: { id: saved.id, defaultPipelineId: legacy.data.defaultPipelineId } }, options), { code: 'PROJECT_PIPELINE_FORBIDDEN' });
      const chosen = randomUUID();
      await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name) values($1,$2,$3,'synthetic-legacy-choice','SYNTHETIC chosen legacy pipeline')", [chosen, ws, legacy.data.id]);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
      let currentVersion = legacy.data.version!;
      const patching = withCrmRead(session(), async () => {
        const result = await updateProjectRecord({ session: session(), expectedVersion: currentVersion, project: { id: legacy.data.id, defaultPipelineId: chosen } }, options);
        assert.ok(result.persisted);if (result.persisted) currentVersion = result.data.version!;
        entered();await gate;
      }, options);
      await ready;
      try {
        for (const mutation of ['delete', 'retarget']) {
          const client = await db.admin.connect();
          try {
            await client.query('begin');await client.query("set local lock_timeout='150ms'");
            await assert.rejects(mutation === 'delete' ? client.query('delete from crm_pipelines where id=$1', [chosen]) : client.query('update crm_pipelines set project_id=$2 where id=$1', [chosen, sourceProject]), { code: '55P03' });
            await client.query('rollback');
          } finally { client.release(); }
        }
      } finally { release();await patching; }
      assert.equal((await db.admin.query('select default_pipeline_id from projects where id=$1', [legacy.data.id])).rows[0].default_pipeline_id, chosen);
      // Reverse ordering: the validator waits for the prior actual row change,
      // then must re-check the same project binding before the PATCH can write.
      for (const mutation of ['retarget', 'delete']) {
        const candidate = randomUUID();
        await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name) values($1,$2,$3,$4,'SYNTHETIC pending legacy choice')", [candidate, ws, legacy.data.id, 'synthetic-pending-'+mutation]);
        const blocker = await db.admin.connect();
        try {
          await blocker.query('begin');
          if (mutation === 'retarget') await blocker.query('update crm_pipelines set project_id=$2 where id=$1', [candidate, sourceProject]);
          else await blocker.query('delete from crm_pipelines where id=$1', [candidate]);
          const pending = updateProjectRecord({ session: session(), expectedVersion: currentVersion, project: { id: legacy.data.id, defaultPipelineId: candidate } }, options);
          const rejected = assert.rejects(pending, { code: 'PROJECT_PIPELINE_FORBIDDEN' });
          let waiting = false;
          for (let n = 0; n < 100 && !waiting; n++) {
            waiting = (await db.admin.query("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'select id from crm_pipelines%for share') as waiting")).rows[0].waiting;
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(waiting, true, 'PATCH validation waits on its exact pipeline row');
          await blocker.query('commit');await rejected;
          const unchanged: { default_pipeline_id: string; version: number | string } = (await db.admin.query('select default_pipeline_id,version from projects where id=$1', [legacy.data.id])).rows[0];
          assert.equal(unchanged.default_pipeline_id, chosen);assert.equal(Number(unchanged.version), currentVersion);
        } finally { await blocker.query('rollback');blocker.release(); }
      }
      const nulled = await create(wizard({ responsibleUserId: null, funnelReferenceId: null, privateNotes: '' }), 'SYNTHETIC no optional relationships');assert.ok(nulled.persisted);if (nulled.persisted) { const details = await getProjectWizardDetails(session(), nulled.data.id, options);assert.equal(details.responsibleUserId, null);assert.equal(details.funnelReferenceId, null);assert.equal(details.privateNotes, ''); }
    });

    await t.test('all five stable types and all four real compatible pipeline catalogs persist their actual stages', async () => {
      for (const typeKey of projectWizardTypeKeys) {
        const result = await create(wizard({ typeKey, responsibleUserId: null, funnelReferenceId: null, privateNotes: '' }), 'SYNTHETIC stable '+typeKey);assert.ok(result.persisted);
        if (result.persisted) assert.equal((await getProjectWizardDetails(session(), result.data.id, options)).typeKey, typeKey);
      }
      for (const [customerType, defaultOperatingModel] of [['real_estate_broker', 'self_service_customer'], ['property_developer', 'self_service_customer'], ['novalure_internal', 'novalure_internal'], ['real_estate_broker', 'managed_by_novalure']] as const) {
        const expected = getDefaultPipelineTemplates(customerType, defaultOperatingModel)[0];
        const intent = wizard({ pipelineTemplateKey: expected.key, responsibleUserId: null, funnelReferenceId: null, privateNotes: '' });
        const result = await createProjectRecord({ session: session(), project: { name: 'SYNTHETIC catalog '+expected.key, type: intent.typeKey, customerType, defaultOperatingModel, wizard: intent } }, options);assert.ok(result.persisted);
        if (result.persisted) {
          const stages = (await db.admin.query('select key from crm_pipeline_stages where workspace_id=$1 and project_id=$2 and pipeline_id=$3 order by position', [ws, result.data.id, result.data.defaultPipelineId])).rows;
          assert.deepEqual(stages.map(row => row.key), expected.stages.map(stage => stage.key));
        }
      }
    });

    await t.test('responsible membership share lock fences a concurrent suspension until the create transaction ends', async () => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
      const checking = withCrmRead(session(), async () => { await validateProjectWizardCreate(session(), wizard(), { customerType: 'novalure_internal', operatingModel: 'novalure_internal' });entered();await gate; }, options);
      await ready;
      const client = await db.admin.connect();
      try { await client.query('begin');await client.query("set local lock_timeout='150ms'");await assert.rejects(client.query("update workspace_users set status='suspended' where id=$1", [peer]), { code: '55P03' });await client.query('rollback'); }
      finally { client.release();release();await checking; }
      const blocker = await db.admin.connect();
      try {
        await blocker.query('begin');await blocker.query("update workspace_users set status='suspended' where id=$1", [peer]);
        const pending = withCrmRead(session(), () => validateProjectWizardCreate(session(), wizard(), { customerType: 'novalure_internal', operatingModel: 'novalure_internal' }), options);
        const rejected = assert.rejects(pending, { code: 'PROJECT_RESPONSIBLE_FORBIDDEN' });
        let waiting = false;
        for (let n = 0; n < 100 && !waiting; n++) {
          waiting = (await db.admin.query("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%select crm_project_wizard_lock_responsible%') as waiting")).rows[0].waiting;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'the real runtime waits on the selected membership row');
        await blocker.query('commit');await rejected;
      } finally { await blocker.query('rollback');blocker.release();await db.admin.query("update workspace_users set status='active' where id=$1", [peer]); }
    });
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) { if (oldEnv[name] === undefined) delete process.env[name];else process.env[name] = oldEnv[name]; }
    await db.stop();
  }
});
