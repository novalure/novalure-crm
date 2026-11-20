import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AppSession } from "../auth/session";
import { CrmCommandError, type TenantTransaction } from "../crm-command";
import { qualifyWebsiteProspect } from "../website-prospect";

type RevisionAuthority = { workspaceId: string; projectId: string; offerId: string; workflowId: string; observationId: string; evidenceDigest: string };
const revisionAuthority = new AsyncLocalStorage<RevisionAuthority>();
/** Only the fresh, canonical Website Sales prepare-draft path installs this internal context. */
export function withWebsiteSalesOfferRevision<T>(authority: RevisionAuthority, run: () => Promise<T>) {
  return revisionAuthority.run(Object.freeze({ ...authority }), run);
}
export async function websiteSalesOfferInvalidated(tx: TenantTransaction, workspaceId: string, offerId: string, revision: number) {
  const installed = await tx.queryOne<{ installed: boolean }>("select to_regclass('public.crm_website_sales_offer_invalidations') is not null as installed");
  if (!installed?.installed) return false; // No lifecycle refresh/invalidation can exist before migration 205.
  return !!await tx.queryOne("select id from crm_website_sales_offer_invalidations where workspace_id=$1 and offer_id=$2 and revision=$3", [workspaceId, offerId, revision]);
}
export async function assertWebsiteSalesOfferEvidence(tx: TenantTransaction, session: AppSession, offer: { id: string; projectId: string; revision: number }, operation: string) {
  if (!await websiteSalesOfferInvalidated(tx, session.workspaceId, offer.id, offer.revision)) return;
  const authorized = revisionAuthority.getStore();
  if (operation === "revise" && authorized?.workspaceId === session.workspaceId && authorized.projectId === offer.projectId && authorized.offerId === offer.id) {
    const current = await tx.queryOne<{ prospect: unknown; evidenceDigest: string }>(`select o.prospect,o.evidence_digest as "evidenceDigest"
      from crm_website_sales_workflows w join crm_website_sales_observations o on o.workspace_id=w.workspace_id and o.id=w.observation_id
      join crm_company_locations l on l.workspace_id=w.workspace_id and l.id=w.location_id and l.version=w.location_version
      where w.workspace_id=$1 and w.project_id=$2 and w.id=$3 and w.observation_id=$4 and w.offer_draft_id=$5 and w.status='QUALIFIED'`,
    [session.workspaceId, offer.projectId, authorized.workflowId, authorized.observationId, offer.id]);
    if (current && current.evidenceDigest === authorized.evidenceDigest) {
      const assessed = qualifyWebsiteProspect(current.prospect, new Date().toISOString());
      if (assessed.status === "READY" && assessed.evidenceDigest === current.evidenceDigest) return;
    }
  }
  throw new CrmCommandError("OFFER_EVIDENCE_INVALIDATED", "The old Website Sales draft revision is permanently invalidated", 409);
}
