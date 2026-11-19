import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedRecoveryTarget as target, assertIsolatedRestoreTarget, assertIsolatedConnectedDatabase,
  assertRestoreProviderRequest, assertRecoveryWorkerEnvironment } from './lib/isolated-application-restore.mjs';

test('provider capability cannot create builds, assign domains or change production endpoints', () => {
  for (const path of ['/v13/deployments', '/v2/deployments/dpl_example/aliases', '/v9/projects/prj_example/env', '/v9/projects/prj_example/domains', '/v10/projects/prj_example/promote']) {
    assert.throws(() => assertRestoreProviderRequest({provider:'vercel',method:'POST',path,body:{}}));
  }
  for (const path of [
    '/projects/misty-cloud-70835427/endpoints/ep-wandering-union-alem0781',
    '/projects/fragrant-fog-86629840/endpoints/ep-dawn-pond-b1f47mu3',
    '/projects/misty-cloud-70835427/snapshots/snap_example/restore',
    '/projects/misty-cloud-70835427/branches/br-spring-night-alyu48yp/finalize_restore',
  ]) assert.throws(() => assertRestoreProviderRequest({provider:'neon',method:'PATCH',path,body:{endpoint:{branch_id:target.branchId}}}));
});

test('only existing bounded restore compute enable is accepted, never branch reassignment or larger compute', () => {
  const request={provider:'neon',method:'PATCH',path:`/projects/${target.projectId}/endpoints/${target.endpointId}`,
    body:{endpoint:{disabled:false,autoscaling_limit_min_cu:0.25,autoscaling_limit_max_cu:0.25}}};
  assert.doesNotThrow(() => assertRestoreProviderRequest(request));
  for (const endpoint of [{...request.body.endpoint,branch_id:target.branchId},{...request.body.endpoint,autoscaling_limit_max_cu:8},{...request.body.endpoint,disabled:true}]) {
    assert.throws(() => assertRestoreProviderRequest({...request,body:{endpoint}}));
  }
  assert.throws(() => assertRestoreProviderRequest({...request,method:'POST'}));
  const cleanup={...request,body:{endpoint:{disabled:true}}};
  assert.throws(() => assertRestoreProviderRequest(cleanup));
  const prior={id:target.endpointId,branch_id:target.branchId,host:target.host,disabled:true};
  assert.doesNotThrow(() => assertRestoreProviderRequest(cleanup,prior));
  assert.throws(() => assertRestoreProviderRequest(cleanup,{...prior,disabled:false}));
});

test('both configured and connected identities reject a production branch and privileged runtime', () => {
  assert.doesNotThrow(() => assertIsolatedRestoreTarget({...target}));
  assert.throws(() => assertIsolatedRestoreTarget({...target,branchId:'br-spring-night-alyu48yp'}));
  const actual={projectId:target.projectId,branchId:target.branchId,database:target.database,role:'crm_restore_runtime_20261102',
    superuser:false,bypassRls:false,createDb:false,createRole:false,replication:false};
  assert.doesNotThrow(() => assertIsolatedConnectedDatabase(target,actual));
  for (const delta of [{branchId:'br-spring-night-alyu48yp'},{database:'neondb'},{role:'neondb_owner'},{bypassRls:true},{createRole:true}])
    assert.throws(() => assertIsolatedConnectedDatabase(target,{...actual,...delta}));
});

test('application worker cannot inherit deployment/provider keys or production identity', () => {
  const env={NOVALURE_AUTH_STRICT:'1',NOVALURE_WORKERS_PAUSED:'1',NOVALURE_APP_ORIGIN:'http://127.0.0.1:3199'};
  const uri=`postgresql://crm_restore_runtime_20261102:synthetic-not-a-real-password@${target.host}/${target.database}`;
  env.DATABASE_URL=uri;
  assert.doesNotThrow(() => assertRecoveryWorkerEnvironment(env,uri));
  for (const delta of [{VERCEL_TOKEN:'synthetic'},{NEON_API_KEY:'synthetic'},{RESEND_API_KEY:'synthetic'},{NOVALURE_AUTH_STRICT:'0'},
    {NOVALURE_TRUST_AUTH_HEADERS:'1'},{NOVALURE_SHARED_LEARNING_ENABLED:'1'},{NOVALURE_APP_ORIGIN:'https://www.novalure-crm.app'},
    {POSTGRES_URL:uri},{DATABASE_URL:uri.replace(target.host,'production.example')}])
    assert.throws(() => assertRecoveryWorkerEnvironment({...env,...delta},uri));
  assert.throws(() => assertRecoveryWorkerEnvironment(env,uri.replace(target.host,'ep-wandering-union-alem0781.c-3.eu-central-1.aws.neon.tech')));
  for (const suffix of ['?host=production.example&user=neondb_owner&sslmode=disable','?options=-c%20search_path%3Dpublic','?sslmode=disable','#production']) {
    assert.throws(() => assertRecoveryWorkerEnvironment({...env,DATABASE_URL:uri+suffix},uri+suffix));
  }
});
