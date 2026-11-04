import 'server-only';
import type {AppSession} from '../auth/session';
import {assertCrmFields,assertCrmUuid,CrmCommandError,executeCrmCommand,withCrmRead,type TenantTransaction,type TenantTransactionOptions} from '../crm-command';
import {hasMailboxReadScope,mailboxProviderId,type MailboxProvider} from '../crm-mailbox';
import {personalMailAddress,personalSha256} from '../crm-mailbox-reply';
import {configuredMailQaImportScope,mailQaImportScopeDigest} from '../crm-mailbox-qa-import-scope';
import {crmPayloadDigest} from '../crm-command';
import {fetchMailboxAccountIdentity,type MailboxTransport} from '../integrations/mailbox-provider';
import {fetchMailboxMetadata,fetchMailboxKnownContent} from '../integrations/mailbox-sync-provider';
import {persistMailboxMessage,unprotectMailboxToken} from './crm-mailbox-repository';
type Connection={id:string;provider:MailboxProvider;accountLabel:string;accountId:string;status:string;access:string;expires:string;scopes:string[];revision:number};
/** QA-only exact read: no listing, delta, fallback search, auto-filing, reply or provider mutation. */
export async function importExactQaMailboxMessage(session:AppSession,raw:Record<string,unknown>,metadata:{idempotencyKey:string;correlationId:string},options:TenantTransactionOptions & {transport?:MailboxTransport;qaHostRegistry?:string}={}){
 assertCrmFields(raw,['connectionId','providerMessageId','qaBatchId','approvedAddresses','reviewed']);
 const connectionId=assertCrmUuid(raw.connectionId),batchId=assertCrmUuid(raw.qaBatchId),providerId=mailboxProviderId(raw.providerMessageId);
 if(raw.reviewed!==true||!Array.isArray(raw.approvedAddresses)||raw.approvedAddresses.length<1||raw.approvedAddresses.length>10)throw new CrmCommandError('MAIL_QA_SCOPE_REQUIRED','Bekannte Testnachricht und kontrollierte Teilnehmer ausdrücklich bestätigen.',409);
 const addresses=raw.approvedAddresses.map(personalMailAddress);if(new Set(addresses).size!==addresses.length)throw new CrmCommandError('MAIL_QA_SCOPE_REQUIRED','Testteilnehmer müssen eindeutig sein.',409);
 const prefix=`[NOVALURE-QA:${batchId}]`;
 const load=async(tx:TenantTransaction,s:AppSession)=>{
  if(s.serviceIdentity||s.productRole==='external_partner'||!s.permissions.includes('crm:write')||!s.productPermissions.includes('workspace:operate'))throw new CrmCommandError('FORBIDDEN','Persönlicher CRM-Auftrag erforderlich.',403);
  assertCrmUuid(s.authIdentityId);assertCrmUuid(s.authSessionId);
  const c=await tx.queryOne<Connection>('select id,provider,account_label as "accountLabel",provider_account_id as "accountId",status,access_token_encrypted as access,expires_at::text as expires,granted_scopes as scopes,revision from crm_mailbox_connections where id=$1::uuid and workspace_id=$2::uuid and user_id=$3::uuid for share',[connectionId,s.workspaceId,s.userId]);
  if(!c||c.status!=='connected'||!c.accountId||!addresses.includes(c.accountLabel)||!hasMailboxReadScope(c.provider,c.scopes)||Date.parse(c.expires)<Date.now()+30000)throw new CrmCommandError('MAIL_QA_CONNECTION_REQUIRED','Aktuelles eigenes, kontrolliertes Testpostfach erforderlich.',409);
  const qaScope=configuredMailQaImportScope(s,{connectionId,batchId,providerId},options.qaHostRegistry);
  if(qaScope.provider!==c.provider||qaScope.providerAccountId!==c.accountId||qaScope.accountLabel!==c.accountLabel||JSON.stringify([...qaScope.participantAddresses].sort())!==JSON.stringify([...addresses].sort()))throw new CrmCommandError('MAIL_QA_HOST_SCOPE_REQUIRED','Angegebene Filter stimmen nicht mit der serverseitig freigegebenen Testressource überein.',403);
  return {...c,qaScope};
 };
 const before=await withCrmRead(session,load,options),token=unprotectMailboxToken(session,before.provider,before.access,before.accountLabel);if(!token)throw new CrmCommandError('MAIL_REAUTH_REQUIRED','Persönliches Testpostfach erneut bestätigen.',409);
 const identity=await fetchMailboxAccountIdentity(before.provider,token,options.transport);
 if(identity.label!==before.accountLabel||identity.accountId!==before.accountId)throw new CrmCommandError('MAIL_ACCOUNT_CHANGED','Testpostfachidentität stimmt nicht überein.',409);
 const meta=await fetchMailboxMetadata(before.provider,token,providerId,options.transport,undefined,true);
 if(!meta||meta.providerId!==providerId||!meta.subject.startsWith(prefix)||!meta.fromAddress||!addresses.includes(meta.fromAddress)||!meta.toAddresses.includes(before.accountLabel)||!meta.participants.every(a=>addresses.includes(a)))throw new CrmCommandError('MAIL_QA_MARKER_REQUIRED','Bekannte ID ist keine eindeutig gekennzeichnete Testnachricht mit kontrollierten Teilnehmern. Inhalt wurde nicht geladen.',409);
 if([...(meta.inReplyTo?[meta.inReplyTo]:[]),...meta.references].some(reference=>!before.qaScope.allowedReferenceIds.includes(reference)))throw new CrmCommandError('MAIL_QA_REFERENCE_UNVERIFIED','Bezug auf nicht freigegebene Originalnachricht; kein Inhaltsimport.',409);
 const message=await fetchMailboxKnownContent(before.provider,token,providerId,options.transport,meta.participants);
 if(message.providerId!==providerId||message.subject!==meta.subject||message.fromAddress!==meta.fromAddress||message.threadId!==meta.threadId||message.internetMessageId!==meta.internetMessageId||!message.toAddresses.includes(before.accountLabel)||message.toAddresses.some(a=>!addresses.includes(a)))throw new CrmCommandError('MAIL_QA_SOURCE_CHANGED','Die Testnachricht wurde nach ihrer Metadatenprüfung geändert.',409);
 if(message.bodyTruncated||personalSha256(Buffer.from(message.bodyText))!==before.qaScope.expectedBodySha256||crmPayloadDigest(message.attachments.map(a=>({name:a.name,mimeType:a.mimeType,sizeBytes:a.sizeBytes})))!==before.qaScope.expectedAttachmentManifestSha256)throw new CrmCommandError('MAIL_QA_CONTENT_UNVERIFIED','Inhalt oder Anhangmanifest entspricht nicht dem hostseitig registrierten synthetischen Testinhalt; keine Übernahme.',409);
 return withCrmRead(session,async(tx,fresh)=>{
  const validateCurrent=async(t:TenantTransaction,s:AppSession)=>{const current=await load(t,s);if(current.revision!==before.revision||current.accountId!==before.accountId||mailQaImportScopeDigest(current.qaScope)!==mailQaImportScopeDigest(before.qaScope))throw new CrmCommandError('MAIL_QA_SOURCE_CHANGED','Testpostfach oder serverseitiger Testscope wurde inzwischen geändert.',409);};
  // Check current authority before receipt lookup too; keep this exact transaction's lock through commit.
  await validateCurrent(tx,fresh);
  return executeCrmCommand(fresh,{operation:'mailbox.qa.import_exact',capability:'workspace:operate',resourceId:connectionId,payload:{connectionId,providerId,batchId,addresses,reviewed:true,hostScopeDigest:mailQaImportScopeDigest(before.qaScope)},...metadata},async(tx,context)=>{
  await validateCurrent(tx,context.session);
  const count=await persistMailboxMessage(tx,context.session,connectionId,message);
  if(count&&before.provider==='microsoft')await tx.execute("update crm_mailbox_messages set provider_id_format='immutable',revision=revision+1 where workspace_id=$1::uuid and user_id=$2::uuid and connection_id=$3::uuid and provider_id=$4",[session.workspaceId,session.userId,connectionId,providerId]);
  const stored=await tx.queryOne<{id:string;subject:string;deleted:string|null}>('select id,subject,deleted_at::text as deleted from crm_mailbox_messages where workspace_id=$1::uuid and user_id=$2::uuid and connection_id=$3::uuid and provider_id=$4',[session.workspaceId,session.userId,connectionId,providerId]);
  if(!stored||stored.deleted||!stored.subject.startsWith(prefix))throw new CrmCommandError('MAIL_QA_COPY_UNAVAILABLE','Vorhandene Kopie ist gelöscht oder gehört nicht zu diesem Testbatch; keine Übernahme.',409);
  return {id:stored.id,connectionId,qaBatchId:batchId,importedCount:count,private:true,source:'exact_verified_qa_id',sent:false};
  },options);
 },options);
}
