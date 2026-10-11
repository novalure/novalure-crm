import assert from 'node:assert/strict';
import test from 'node:test';
import { runProductionMediaPreflight } from './production-media-schema-preflight.mjs';
const env={VERCEL_ENV:'production',DATABASE_URL:'postgres://fixture:fixture@fixture.neon.tech/test'};
const referenceRows=()=>[
  ['bot_document_sends',['media_asset_id'],['id'],'n'],
  ['media_asset_shares',['asset_id','workspace_id'],['id','workspace_id'],'c'],
  ['property_documents',['media_asset_id'],['id'],'n'],
  ['property_media',['media_asset_id'],['id'],'n'],
].map(([table_name,columns,target_columns,delete_action])=>({schema_name:'public',table_name,columns,target_columns,delete_action,validated:true,deferrable:false,rls_active:false}));
function client(rows=referenceRows(),readOnly='on') {
  const queries=[];
  const makeSql=url=>{assert.equal(url,env.DATABASE_URL);return {
    query(sql){assert.match(sql,/^select\s/);queries.push(sql);return {sql};},
    async transaction(items,options){assert.equal(items.length,2);assert.equal(options.readOnly,true);return [[{read_only:readOnly}],rows];},
  };};
  return {makeSql,queries};
}
test('local and preview builds do not connect to production',async()=>{
  for(const VERCEL_ENV of [undefined,'preview','development']) assert.equal((await runProductionMediaPreflight({env:{VERCEL_ENV},makeSql(){throw Error('No connection expected');}})).status,'SKIPPED_NON_PRODUCTION');
});
test('production requires a configured provider URL before IO',async()=>{
  for(const DATABASE_URL of ['', 'postgres://fixture:fixture@localhost/test']) await assert.rejects(runProductionMediaPreflight({env:{VERCEL_ENV:'production',DATABASE_URL},makeSql(){throw Error('No connection expected');}}),/database unavailable/);
});
test('production gate uses exact application contract and a read-only catalog transaction',async()=>{
  const c=client();const result=await runProductionMediaPreflight({env,makeSql:c.makeSql});
  assert.equal(result.status,'PASS_PRODUCTION_READ_ONLY_MEDIA_SCHEMA');assert.equal(result.referenceCount,4);assert.equal(c.queries.length,2);
  assert.match(c.queries[1],/pg_constraint/);assert.doesNotMatch(JSON.stringify(result),/fixture|postgres:\/\//);
});
test('unknown references or active RLS fail closed without storage or DDL',async()=>{
  for(const rows of [[...referenceRows(),{table_name:'unknown'}], referenceRows().map((r,i)=>i===0?{...r,rls_active:true}:r)]) {
    const c=client(rows);await assert.rejects(runProductionMediaPreflight({env,makeSql:c.makeSql}),/contract not satisfied/);assert.equal(c.queries.length,2);
  }
});
test('a read-write database response never passes the build gate',async()=>{
  const c=client(referenceRows(),'off');await assert.rejects(runProductionMediaPreflight({env,makeSql:c.makeSql}),/contract not satisfied/);
});
