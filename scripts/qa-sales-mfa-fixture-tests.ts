import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {startLocalSalesDb,applySalesSchema} from './lib/local-sales-db.mjs';
import {seedSalesBrowser} from './lib/sales-browser-fixture.mjs';
import {seedSyntheticLivelistedMfa} from './lib/livelisted-browser-mfa-fixture.mjs';
import {createTotpCode,decryptMfaSecret,verifyTotpCode} from '../src/lib/auth/mfa';

test('synthetic MFA fixture refuses a foreign or remote target before touching storage',async()=>{
 let calls=0;const db={directory:'C:/not-an-owned-qa-cluster',port:5432,role:'customer',admin:{options:{host:'remote.invalid'},query:async()=>{calls++;return{rowCount:1};}}};
 await assert.rejects(seedSyntheticLivelistedMfa(db,{userId:'not-a-fixture',email:'person@example.invalid'},'synthetic-key-not-used-outside-this-test'),/owned disposable/);assert.equal(calls,0);
});
test('only a fresh owned synthetic identity receives encrypted TOTP state, without a session or login bypass',async()=>{
 const db=await startLocalSalesDb(),oldKey=process.env.NOVALURE_AUTH_ENCRYPTION_KEY;try{
  await applySalesSchema(db,{maxMigrationNumber:106});const fixture=await seedSalesBrowser(db),key=randomBytes(40).toString('hex'),seed=await seedSyntheticLivelistedMfa(db,fixture,key);
  assert.equal(seed.mfaSeededSessions,0);assert.equal(seed.mfaFixtureState,'synthetic_initial_totp_enrolled');assert.equal(process.env.NOVALURE_AUTH_ENCRYPTION_KEY,oldKey);
  const row=(await db.admin.query('select mfa_secret_ciphertext,mfa_enabled_at is not null as enabled from auth_identities where id=$1',[fixture.authIdentityId])).rows[0];assert.equal(row.enabled,true);
  process.env.NOVALURE_AUTH_ENCRYPTION_KEY=key;assert.ok(decryptMfaSecret(row.mfa_secret_ciphertext)===seed.mfaTotpSecret);const code=createTotpCode(seed.mfaTotpSecret);assert.ok(code&&verifyTotpCode(seed.mfaTotpSecret,code));
  assert.equal((await db.admin.query('select id from auth_sessions where auth_identity_id=$1',[fixture.authIdentityId])).rowCount,0);
  await assert.rejects(seedSyntheticLivelistedMfa(db,fixture,key),/cannot replace/);assert.ok((await db.admin.query('select mfa_secret_ciphertext from auth_identities where id=$1',[fixture.authIdentityId])).rows[0].mfa_secret_ciphertext===row.mfa_secret_ciphertext);
 }finally{if(oldKey===undefined)delete process.env.NOVALURE_AUTH_ENCRYPTION_KEY;else process.env.NOVALURE_AUTH_ENCRYPTION_KEY=oldKey;await db.stop();}
});
