import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { AppSession } from '../auth/session';
import type { TenantTransaction, TenantTransactionOptions } from '../crm-command';
import { CrmCommandError } from '../crm-command';
import { queryAuthenticationRows, withTenantTransaction } from './tenant-client';
import { advisoryBuyerProjectionSchema, advisoryBuyerCommandSchema, advisoryBuyerReceiptSchema, advisoryBuyerReconcileSchema, advisoryBuyerValueCaseSchema, type AdvisoryReference, type WebsiteSalesAdvisoryBuyerRead } from '../website-sales-advisory-types';
import { verifyWebsiteStudioArtifact } from '../website-sales-studio';
import { verifyWebsiteStudioQaCertificate } from '../website-sales-studio-qa';
import { websiteProspectInputSchema } from '../website-prospect';
import { advisoryDigest, advisoryReference, advisoryBuyerActorBindingHash } from '../website-sales-advisory-domain';
import { assertAdvisoryPublication } from './website-sales-advisory-sources';
import { advisoryBoundRecord, advisoryOwner, advisoryParams as params, advisoryIdentity as identity, advisoryIso as iso, advisoryFail as fail, advisoryRows, type AdvisoryScope as Scope, type AdvisoryJson as Json } from './website-sales-advisory-storage';

type BuyerOptions = TenantTransactionOptions & { session?: AppSession };
type Access = { public: WebsiteSalesAdvisoryBuyerRead; identity: ReturnType<typeof identity>; workflowId: string; packetRowId: string;renderProofs?:Array<{artifact:unknown;prospect:unknown;certificate:unknown;builderId:string;workflowId:string}> };
function tokenHash(token: string) {
 if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').length !== 32 || Buffer.from(token, 'base64url').toString('base64url') !== token) fail('ADVISORY_BUYER_UNAVAILABLE', 404);
 return createHash('sha256').update(token, 'utf8').digest('hex');
}
function nativeSession(s?: AppSession): s is AppSession & { authSessionId: string; authIdentityId: string } {
 return !!s?.authenticated && !s.serviceIdentity && ['cookie', 'database'].includes(s.source) && !!s.authSessionId && !!s.authIdentityId;
}
async function access(hash: string, options: BuyerOptions): Promise<Access | null> {
 const s = options.session;
 const args = nativeSession(s) ? [hash, s.userId, s.authIdentityId, s.authSessionId] : [hash, null, null, null];
 const rows = nativeSession(s) ? await withTenantTransaction({ actorId: s.userId, workspaceId: s.workspaceId }, tx => tx.query<{ value: Access | null }>('select crm_website_sales_advisory_buyer_access($1,$2,$3,$4) as value', args), options)
  : await queryAuthenticationRows<{ value: Access | null }>('select crm_website_sales_advisory_buyer_access($1,$2,$3,$4) as value', args, options);
 const value = rows[0]?.value ?? null; if (!value) return null;
 try{for(const proof of value.renderProofs??[]){const artifact=verifyWebsiteStudioArtifact(proof.artifact,websiteProspectInputSchema.parse(proof.prospect),new Date().toISOString());if(artifact.kind!=='DEMO')return null;verifyWebsiteStudioQaCertificate(proof.certificate,artifact,proof.workflowId,proof.builderId);}}catch{return null;}
 const parsed = advisoryBuyerProjectionSchema.parse(value.public);
 if (parsed.canWrite && (!nativeSession(s) || parsed.actorUserId !== s.userId || parsed.actorBindingHash !== advisoryBuyerActorBindingHash({ principalUserId: s.userId, authIdentityId: s.authIdentityId, workspaceId: value.identity.workspaceId, grantId: parsed.grantId, packetRef: parsed.packetRef }))) fail('ADVISORY_BUYER_BINDING_INVALID', 403);
 return { ...value, public: parsed };
}
export async function readWebsiteSalesBuyerRoom(token: string, options: BuyerOptions = {}) { return (await access(tokenHash(token), options))?.public ?? null; }

export async function createAdvisoryBuyerGrant(tx: TenantTransaction, s: AppSession, b: Scope, p: Json, commandId: string) {
 await advisoryOwner(tx, s); const packet = await advisoryBoundRecord(tx, s, b, p.packetRef as AdvisoryReference, ['BUYER_PACKET']);
 const approval = (await advisoryRows(tx, s, b, 'BUYER_PACKET_APPROVAL')).find(row => advisoryDigest(row.payload.recordRef) === advisoryDigest(p.packetRef) && Date.parse(iso(row.validUntil)) > Date.now());
 if (!approval || packet.record.payload.status !== 'READY') fail('ADVISORY_APPROVED_PACKET_REQUIRED');await assertAdvisoryPublication(tx,s,b,packet.record);
 if (Date.parse(String(p.expiresAt)) <= Date.now() || Date.parse(String(p.expiresAt)) > Math.min(Date.parse(packet.record.validUntil!), Date.parse(iso(approval.validUntil)))) fail('ADVISORY_GRANT_EXPIRY_INVALID');
 const principal = await tx.queryOne<{ id: string; email: string }>(`select u.id,lower(i.normalized_email) as email from workspace_users u join auth_identities i on i.id=u.auth_identity_id and i.normalized_email=lower(trim(u.email)) where u.workspace_id=$1 and u.id=$2 and u.status='active' and i.disabled_at is null`, [s.workspaceId, p.principalUserId]);
 if (!principal) fail('ADVISORY_BOUND_ACCOUNT_REQUIRED', 403);
 const value = packet.record.payload.value as Json, id = randomUUID();
 let valueCase: unknown = null;
 if (value.valueCaseRef) {
  const scenario = await advisoryBoundRecord(tx, s, b, value.valueCaseRef as AdvisoryReference, ['VALUE_CASE']), basis = scenario.record.payload.value as Json | null;
  if (scenario.record.payload.status === 'READY' && basis?.basisRef) {
   const original = await advisoryBoundRecord(tx, s, b, basis.basisRef as AdvisoryReference, ['VALUE_BASIS']), offer = original.record.payload.offerRef as AdvisoryReference;
   const approved = await tx.queryOne(`select o.id from crm_offers o join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision join crm_offer_approvals a on a.workspace_id=o.workspace_id and a.id=o.approval_id and a.offer_id=o.id and a.revision=o.revision and a.content_digest=r.content_digest and a.decision='APPROVED' join workspace_users u on u.workspace_id=a.workspace_id and u.id=a.actor_id and u.status='active' and u.role='owner' where o.workspace_id=$1 and o.project_id=$2 and o.organization_id=$3 and o.id=$4 and o.revision=$5 and r.content_digest=$6 and o.status in('APPROVED','QUEUED','SENT','ACCEPTED') and a.expires_at>clock_timestamp()`, [s.workspaceId, b.projectId, b.companyId, offer.id, offer.version, offer.digest]);
   if (approved) valueCase = advisoryBuyerValueCaseSchema.parse({ currency: 'EUR', amountBasis: 'NET', scenarioOnly: true, roiGuaranteed: false, approvedOfferRef: offer, horizonMonths: original.record.payload.horizonMonths, scenarios: (basis.scenarios as Json[]).map(row => ({ name: row.name, totalCostMinor: row.totalCostMinor, totalCashBenefitMinor: row.totalCashBenefitMinor, netCashMinor: row.netCashMinor, roiBps: row.roiBps, paybackMonth: row.paybackMonth })) });
  }
 }
 const snapshot = { title: value.title, summary: value.summary, decisionCriteria: value.decisionCriteria, options: value.options,
  steps: (value.steps as Json[]).map(step => ({ id: step.id, version: 1, label: step.label, responsible: step.responsible, dueAt: step.dueAt, status: 'PROPOSED' })), questions: [], valueCase, demo: null, video: null };
 // Whitelist the exact public projection before storing it; no brief, transcript, source body or CRM margin is copied.
 advisoryBuyerProjectionSchema.parse({ ...snapshot, contractVersion: 'website-sales-advisory-buyer-v1', grantId: id, expiresAt: p.expiresAt, grantVersion: 1, actorUserId: null, actorBindingHash: null, authAssurance: 'READ_ONLY_LINK', canWrite: false, blockers: [], packetRef: advisoryReference(packet.record) });
 await tx.execute('insert into crm_website_sales_advisory_buyer_grants(id,workspace_id,project_id,company_id,location_id,workflow_id,packet_record_id,token_hash,principal_user_id,principal_email,public_snapshot,created_by,expires_at,command_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)', [id, ...params(s, b), packet.row.rowId, p.tokenHash, principal.id, principal.email, JSON.stringify(snapshot), s.userId, p.expiresAt, commandId]);
 if (!(await tx.queryOne<{ value: unknown }>('select crm_website_sales_advisory_buyer_access($1,null,null,null) as value', [p.tokenHash]))?.value) fail('ADVISORY_PUBLICATION_SOURCE_CHANGED');
 return { id, digest: advisoryDigest({ id, packetRef: advisoryReference(packet.record), principalUserId: principal.id, expiresAt: p.expiresAt }) };
}
export async function revokeAdvisoryBuyerGrant(tx: TenantTransaction, s: AppSession, b: Scope, p: Json, commandId: string) {
 await advisoryOwner(tx, s); const found = await tx.queryOne('select id from crm_website_sales_advisory_buyer_grants where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and workflow_id=$5 and id=$6', [...params(s, b), p.grantId]);
 if (!found) fail('ADVISORY_GRANT_NOT_FOUND', 404);
 await tx.execute('insert into crm_website_sales_advisory_buyer_revocations(id,workspace_id,project_id,company_id,location_id,workflow_id,grant_id,revoked_by,reason,command_id)values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [randomUUID(), ...params(s, b), p.grantId, s.userId, p.reason, commandId]);
}
function sqlError(error: unknown): never {
 if (error && typeof error === 'object' && 'code' in error) { const code = String(error.code); if (code === '23505') fail('IDEMPOTENCY_CONFLICT'); if (code === '40001') fail('ADVISORY_BUYER_VERSION_CONFLICT'); if (code === '42501') fail('ADVISORY_BUYER_ACCOUNT_REQUIRED', 403); }
 throw error;
}
async function buyerCommand(s: AppSession, input: { token: string } & Record<string, unknown>, options: TenantTransactionOptions, reconcile: boolean) {
 if (!nativeSession(s)) fail('AUTHENTICATED_BOUND_ACCOUNT_REQUIRED', 401);
 const { token, ...body } = input, command = advisoryBuyerCommandSchema.parse(body), hash = tokenHash(token);
 try {
  return await withTenantTransaction({ actorId: s.userId, workspaceId: s.workspaceId }, async tx => {
   const row = await tx.queryOne<{ value: Json }>('select crm_website_sales_advisory_buyer_command($1,$2,$3,$4,$5::jsonb,$6) as value', [hash, s.userId, s.authIdentityId, s.authSessionId, JSON.stringify(command), reconcile]);
   if (!row) throw new CrmCommandError('ADVISORY_BUYER_UNAVAILABLE', 'Buyer operation unavailable', 404);
   if (!reconcile) return advisoryBuyerReceiptSchema.parse(row.value.receipt);
   return advisoryBuyerReconcileSchema.parse({ ...row.value, contractVersion: 'website-sales-advisory-buyer-reconcile-v1', correlationId: command.correlationId });
  }, options);
 } catch (error) { sqlError(error); }
}
export async function confirmWebsiteSalesBuyerStep(s: AppSession, input: { token: string } & Record<string, unknown>, options: TenantTransactionOptions = {}) { return advisoryBuyerReceiptSchema.parse(await buyerCommand(s,input,options,false)); }
export async function reconcileWebsiteSalesBuyerStep(s: AppSession, input: { token: string } & Record<string, unknown>, options: TenantTransactionOptions = {}) { return advisoryBuyerReconcileSchema.parse(await buyerCommand(s,input,options,true)); }

export async function readWebsiteSalesBuyerAsset(token: string, assetId: string, options: BuyerOptions = {}) {
 const admitted = await access(tokenHash(token), options); if (!admitted?.public.video || admitted.public.video.id !== assetId) return null;
 const rows = await queryAuthenticationRows<{ bytes: Buffer; sha256: string }>('select * from crm_website_sales_advisory_buyer_asset($1,$2)', [tokenHash(token), assetId], options), row = rows[0];
 return row ? { bytes: new Uint8Array(row.bytes), mediaType: 'video/webm' as const, sha256: row.sha256, filename: 'website-demo-explanation.webm' } : null;
}
