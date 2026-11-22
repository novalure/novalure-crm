import type { CanonicalEnablementRecord, EnablementIdentity } from './website-sales-enablement-types';
import type { WebsiteSalesEnablementResourceRead } from './website-sales-enablement-api-types';
import type { StudioArtifactRecord } from './website-sales-studio-types';

/** Browser hints never grant source/rights authority; the server resolves every binding again. */
const same=(a:EnablementIdentity,b:EnablementIdentity)=>a.workspaceId===b.workspaceId&&a.projectId===b.projectId&&a.companyId===b.companyId&&a.locationId===b.locationId;
const current=(from:string,until:string,now:number)=>Date.parse(from)<=now&&Date.parse(until)>now;
const sourcesCurrent=(rows:{observedAt:string;validUntil:string}[],now:number)=>rows.every(row=>current(row.observedAt,row.validUntil,now));
function recordCurrent<T>(row:CanonicalEnablementRecord<T>,data:WebsiteSalesEnablementResourceRead,now:number){return same(row.identity,data.identity)&&row.workflowVersion<=data.workflowVersion&&!row.revokedAt&&current(row.createdAt,row.validUntil,now);}
function latest<T>(rows:CanonicalEnablementRecord<T>[]){const found=new Map<string,CanonicalEnablementRecord<T>>();for(const row of rows)if(!found.has(row.id)||found.get(row.id)!.version<row.version)found.set(row.id,row);return found;}
export function currentStudioBrief(data:WebsiteSalesEnablementResourceRead|null,now=Date.now()){
 const brief=data?.brief;return data&&brief&&recordCurrent(brief,data,now)&&Date.parse(brief.payload.validUntil)>now&&sourcesCurrent(brief.payload.sourceReferences,now)?brief:null;
}
export function currentStudioProfiles(data:WebsiteSalesEnablementResourceRead|null,now=Date.now()){
 if(!data)return[];const references=latest(data.references);
 return [...latest(data.demoProfiles).values()].filter(profile=>{
  const p=profile.payload;if(!recordCurrent(profile,data,now)||Date.parse(p.validUntil)<=now||!sourcesCurrent(p.sourceReferences,now))return false;
  if(new Set(p.referenceCaseIds).size!==p.referenceCaseIds.length||new Set(p.assetIds).size!==p.assetIds.length)return false;
  const assets=p.assetIds.map(id=>data.assets.find(asset=>asset.assetId===id));
  if(assets.some(asset=>!asset||!same(asset.identity,data.identity)||asset.revokedAt||!current(asset.approvedAt,asset.validUntil,now))||new Set(assets.map(asset=>asset?.role)).size!==assets.length)return false;
  return p.referenceCaseIds.every(id=>{const ref=references.get(id);return ref&&recordCurrent(ref,data,now)&&ref.payload.disclosure==='APPROVED_CUSTOMER_PRESENTATION'&&(ref.payload.industryCode==='GENERAL'||ref.payload.industryCode===p.industryCode)&&Date.parse(ref.payload.validUntil)>now&&sourcesCurrent(ref.payload.sourceReferences,now)&&ref.payload.claims.every(claim=>sourcesCurrent(claim.sourceReferences,now))&&data.referenceReviews.some(review=>review.referenceId===ref.id&&review.referenceVersion===ref.version&&review.referenceDigest===ref.digest&&!review.revokedAt&&current(review.approvedAt,review.validUntil,now));});
 });
}
export class StudioSelectionUnavailable extends Error{constructor(readonly field:'briefBinding'|'profileBinding'){super('STUDIO_SELECTED_SOURCE_UNAVAILABLE');}}
export function resolveStudioBriefSelection(data:WebsiteSalesEnablementResourceRead|null,selection:string,now=Date.now()){
 if(!selection)return undefined;const brief=currentStudioBrief(data,now);if(!brief||selection!==`${brief.id}:${brief.version}`)throw new StudioSelectionUnavailable('briefBinding');return{briefId:brief.id,version:brief.version,digest:brief.digest};
}
export function resolveStudioProfileSelection(data:WebsiteSalesEnablementResourceRead|null,selection:string,now=Date.now()){
 if(!selection)return undefined;const profile=currentStudioProfiles(data,now).find(row=>selection===`${row.id}:${row.version}`);if(!profile)throw new StudioSelectionUnavailable('profileBinding');return{profileId:profile.id,version:profile.version,digest:profile.digest};
}
export function isStudioArtifactCurrent(record:StudioArtifactRecord|undefined,evidenceDigest:string,now=Date.now()){
 return!!record&&(record.sourceBindingsCurrent===undefined||record.sourceBindingsCurrent===true)&&record.artifact.evidenceDigest===evidenceDigest&&Date.parse(record.artifact.validUntil)>now;
}
