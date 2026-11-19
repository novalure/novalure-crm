import 'server-only';
import type {AppSession} from './auth/session';
import {assertCrmFields,assertCrmUuid,crmPayloadDigest,CrmCommandError} from './crm-command';
import {mailboxProviderId,type MailboxProvider} from './crm-mailbox';
import {personalInternetId,personalMailAddress} from './crm-mailbox-reply';
export type MailQaImportScope={workspaceId:string;actorId:string;identityId:string;connectionId:string;provider:MailboxProvider;providerAccountId:string;accountLabel:string;qaBatchId:string;providerMessageId:string;participantAddresses:string[];expectedBodySha256:string;expectedAttachmentManifestSha256:string;allowedReferenceIds:string[];verificationReference:string;expiresAt:string};
/** Host/operator pin only. Never accepts authority from a body/header/URL or the append-only QA ledger alone. */
export function configuredMailQaImportScope(session:AppSession,request:{connectionId:string;batchId:string;providerId:string},hostRegistry=process.env.NOVALURE_MAIL_QA_IMPORT_SCOPES):MailQaImportScope{
 const denied=()=>new CrmCommandError('MAIL_QA_HOST_SCOPE_REQUIRED','Dieser exakte Testimport benötigt eine aktuelle serverseitige Freigabe aus verifizierten Testressourcen.',403);
 if(!hostRegistry||Buffer.byteLength(hostRegistry)>32768)throw denied();
 let parsed:unknown;try{parsed=JSON.parse(hostRegistry);}catch{throw denied();}
 if(!Array.isArray(parsed)||parsed.length<1||parsed.length>16)throw denied();
 const scopes:MailQaImportScope[]=[];
 try{for(const raw of parsed){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw denied();
  assertCrmFields(raw,['workspaceId','actorId','identityId','connectionId','provider','providerAccountId','accountLabel','qaBatchId','providerMessageId','participantAddresses','expectedBodySha256','expectedAttachmentManifestSha256','allowedReferenceIds','verificationReference','expiresAt']);
  for(const key of ['workspaceId','actorId','identityId','connectionId','qaBatchId'])assertCrmUuid(raw[key]);
  if(!['google','microsoft'].includes(raw.provider)||typeof raw.providerAccountId!=='string'||!raw.providerAccountId||raw.providerAccountId.length>512)throw denied();
  mailboxProviderId(raw.providerMessageId);personalMailAddress(raw.accountLabel);
  if(!Array.isArray(raw.participantAddresses)||raw.participantAddresses.length<1||raw.participantAddresses.length>10)throw denied();
  const addresses=raw.participantAddresses.map(personalMailAddress);
  if(new Set(addresses).size!==addresses.length||!addresses.includes(raw.accountLabel)||!Array.isArray(raw.allowedReferenceIds)||raw.allowedReferenceIds.length>10)throw denied();
  raw.allowedReferenceIds.forEach(personalInternetId);
  if(!/^[a-f0-9]{64}$/u.test(raw.expectedBodySha256)||!/^[a-f0-9]{64}$/u.test(raw.expectedAttachmentManifestSha256)||!/^sha256:[a-f0-9]{64}$/u.test(raw.verificationReference))throw denied();
  const expiration=Date.parse(raw.expiresAt);if(!Number.isFinite(expiration)||expiration<=Date.now()||expiration>Date.now()+86400000)throw denied();
  scopes.push({...raw,participantAddresses:addresses});
 }}catch{throw denied();}
 const matches=scopes.filter(s=>s.workspaceId===session.workspaceId&&s.actorId===session.userId&&s.identityId===session.authIdentityId&&s.connectionId===request.connectionId&&s.qaBatchId===request.batchId&&s.providerMessageId===request.providerId);
 if(matches.length!==1)throw denied();return matches[0];
}
export const mailQaImportScopeDigest=(scope:MailQaImportScope)=>crmPayloadDigest(scope);
