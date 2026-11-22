import 'server-only';
import type { AppSession } from '../auth/session';
import { assertProjectGrant, CrmCommandError, type TenantTransaction } from '../crm-command';
import { websiteSalesResourceAuthority, websiteSalesEnablementSourceAuthority } from '../website-sales-machine-authority';
import { websiteSalesEnablementRecordDigest } from '../website-sales-enablement';
import { customerBriefSchema, type CanonicalEnablementRecord, type WebsiteCustomerBrief } from '../website-sales-enablement-types';
import type { WebsiteSalesEnablementScope } from '../website-sales-enablement-api-types';

/** Read-only source port; no Studio, lifecycle or write repository dependency. */
export async function resolveCurrentWebsiteSalesBrief(tx: TenantTransaction, session: AppSession, scope: WebsiteSalesEnablementScope, binding: { briefId: string; version: number; digest: string }): Promise<CanonicalEnablementRecord<WebsiteCustomerBrief>> {
 websiteSalesResourceAuthority(session, scope); websiteSalesEnablementSourceAuthority(session, scope); await assertProjectGrant(tx, session, scope.projectId);
 const found = await tx.queryOne<{ id: string; version: number; workflowVersion: number; currentWorkflowVersion: number; digest: string; recordedBy: string; createdAt: string; validUntil: string; payload: unknown }>(`select r.entity_id as id,r.version,r.workflow_version as "workflowVersion",w.version as "currentWorkflowVersion",r.record_digest as digest,r.created_by as "recordedBy",r.created_at as "createdAt",r.valid_until as "validUntil",r.payload
  from crm_website_sales_enablement_records r join crm_website_sales_workflows w on w.workspace_id=r.workspace_id and w.id=r.workflow_id and w.project_id=r.project_id and w.company_id=r.company_id and w.location_id=r.location_id
  where r.workspace_id=$1 and r.project_id=$2 and r.company_id=$3 and r.location_id=$4 and r.kind='BRIEF' and r.entity_id=$5 order by r.version desc limit 1`, [session.workspaceId, scope.projectId, scope.companyId, scope.locationId, binding.briefId]);
 const unavailable = () => { throw new CrmCommandError('ENABLEMENT_BRIEF_NOT_CURRENT', 'Current scoped owner-recorded brief required', 409); };
 if (!found || found.version !== binding.version || found.digest !== binding.digest || found.workflowVersion > found.currentWorkflowVersion || new Date(found.validUntil).valueOf() <= Date.now()) return unavailable();
 const payload = customerBriefSchema.parse(found.payload);
 if (payload.sourceReferences.some(source => Date.parse(source.observedAt) > Date.now() || Date.parse(source.validUntil) <= Date.now()) || Date.parse(payload.validUntil) <= Date.now()) return unavailable();
 const record: CanonicalEnablementRecord<WebsiteCustomerBrief> = { id: found.id, identity: { workspaceId: session.workspaceId, projectId: scope.projectId, companyId: scope.companyId, locationId: scope.locationId }, version: found.version, workflowVersion: found.workflowVersion, digest: found.digest, recordedBy: found.recordedBy, createdAt: new Date(found.createdAt).toISOString(), validUntil: new Date(found.validUntil).toISOString(), revokedAt: null, payload };
 if (websiteSalesEnablementRecordDigest(record) !== record.digest) return unavailable(); return record;
}
