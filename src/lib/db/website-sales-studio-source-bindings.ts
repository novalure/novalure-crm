import 'server-only';
import type { AppSession } from '../auth/session';
import { CrmCommandError, type TenantTransaction } from '../crm-command';
import { canonicalWebsiteStudioDigest, type WebsiteStudioArtifact } from '../website-sales-studio';
import { resolveCurrentEnablementDemoProfile } from './website-sales-enablement-repositories';
import { resolveCurrentWebsiteSalesBrief } from './website-sales-enablement-source';

/** Hashes preserve immutable content; current CRM records preserve source/rights authority. */
export async function assertWebsiteSalesStudioSourceBindings(tx: TenantTransaction, session: AppSession, artifact: WebsiteStudioArtifact): Promise<void> {
  const scope = { projectId: artifact.identity.projectId, companyId: artifact.identity.companyId, locationId: artifact.identity.locationId };
  if (artifact.identity.workspaceId !== session.workspaceId) throw new CrmCommandError('STUDIO_SOURCE_SCOPE_DENIED', 'Studio source unavailable', 403);
  const concept = artifact.kind === 'CONCEPT' ? artifact : artifact.kind === 'DEMO' ? artifact.content.concept : null;
  if (concept?.content.customerBrief) {
    const brief = concept.content.customerBrief;
    const resolved = await resolveCurrentWebsiteSalesBrief(tx, session, scope, { briefId: brief.id, version: brief.version, digest: brief.digest });
    if (canonicalWebsiteStudioDigest(resolved) !== canonicalWebsiteStudioDigest(brief)) throw new CrmCommandError('STUDIO_BRIEF_CHANGED', 'Current customer brief required', 409);
  }
  if (artifact.kind === 'DEMO' && artifact.content.demoProfile) {
    const snapshot = artifact.content.demoProfile, profile = snapshot.profile;
    const resolved = await resolveCurrentEnablementDemoProfile(tx, session, scope, { profileId: profile.id, version: profile.version, digest: profile.digest });
    if (canonicalWebsiteStudioDigest({profile:resolved.profile,references:resolved.references,assets:resolved.assets}) !== canonicalWebsiteStudioDigest(snapshot)) throw new CrmCommandError('STUDIO_PROFILE_CHANGED', 'Current approved presentation required', 409);
  }
}
