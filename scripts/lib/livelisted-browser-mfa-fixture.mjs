import path from 'node:path';
import {createTotpSecret,encryptMfaSecret,decryptMfaSecret} from '../../src/lib/auth/mfa.ts';

/** Initial state of this helper's newly created synthetic account only.
 * No login/session/challenge is forged. The browser still performs real MFA.
 * Return the secret only to the ignored confidential fixture; never log it.
 */
export async function seedSyntheticLivelistedMfa(db,fixture,encryptionKey){
 const expectedEmail=`synthetic-sales-${String(fixture.userId).replaceAll('-','')}@example.invalid`;
 const directory=typeof db.directory==='string'?path.resolve(db.directory):'',prefix=path.resolve('.npm-cache','qa')+path.sep+'sales-pg-';
 if(!directory.startsWith(prefix)||db.admin?.options?.host!=='127.0.0.1'||!Number.isInteger(db.port)||db.port<1||!/^sales_qa_[a-f0-9]{12}$/.test(db.role)||fixture.email!==expectedEmail||typeof encryptionKey!=='string'||encryptionKey.length<32)throw new Error('MFA fixture requires the owned disposable loopback account');
 const oldKey=process.env.NOVALURE_AUTH_ENCRYPTION_KEY;process.env.NOVALURE_AUTH_ENCRYPTION_KEY=encryptionKey;
 const secret=createTotpSecret();let ciphertext;
 try{ciphertext=encryptMfaSecret(secret);if(decryptMfaSecret(ciphertext)!==secret)throw new Error('Synthetic MFA encryption failed');}
 finally{if(oldKey===undefined)delete process.env.NOVALURE_AUTH_ENCRYPTION_KEY;else process.env.NOVALURE_AUTH_ENCRYPTION_KEY=oldKey;}
 const result=await db.admin.query(`update auth_identities a set mfa_secret_ciphertext=$5,mfa_enabled_at=clock_timestamp(),updated_at=clock_timestamp()
  from workspace_users u join workspaces w on w.id=u.workspace_id
  where a.id=$1::uuid and u.id=$2::uuid and w.id=$3::uuid and u.auth_identity_id=a.id and u.email=$4 and a.normalized_email=lower($4)
   and w.name='SYNTHETIC SALES QA' and u.name='Synthetic sales owner' and u.role='owner' and u.product_role='novalureAdmin' and u.status='active'
   and a.credential_state='active' and a.disabled_at is null and a.mfa_enabled_at is null and a.mfa_secret_ciphertext is null
   and not exists(select 1 from auth_sessions s where s.auth_identity_id=a.id) returning a.id`,[fixture.authIdentityId,fixture.userId,fixture.workspaceId,expectedEmail,ciphertext]);
 if(result.rowCount!==1)throw new Error('Synthetic MFA initial state cannot replace an existing identity or session');
 return{mfaTotpSecret:secret,mfaFixtureState:'synthetic_initial_totp_enrolled',mfaSeededSessions:0};
}
