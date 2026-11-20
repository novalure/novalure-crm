import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { CrmCommandError } from "./crm-command";
import { canonicalWebsiteStudioQaPayload, type WebsiteStudioQaCertificate, type WebsiteStudioQaPublicKey } from "./website-sales-studio-types";
import type { WebsiteDemoArtifact } from "./website-sales-studio";
const uuid=z.uuid(), sha=z.hash("sha256"), at=z.iso.datetime({offset:true});
const certificateSchema=z.strictObject({payload:z.strictObject({contractVersion:z.literal("website-sales-rendered-qa-v1"),issuer:z.string().min(1).max(100),keyId:z.string().min(1).max(100),certificateId:uuid,
 workspaceId:uuid,projectId:uuid,companyId:uuid,locationId:uuid,workflowId:uuid,artifactDigest:sha,htmlDigest:sha,assetManifestDigest:sha,evidenceDigest:sha,
 qaActorId:uuid,sourceRevision:z.string().regex(/^[0-9a-f]{40}$/),checkedAt:at,expiresAt:at,
 checks:z.strictObject({desktop:z.literal(true),tablet:z.literal(true),mobile:z.literal(true),reducedMotion:z.literal(true),keyboard:z.literal(true),noConsoleErrors:z.literal(true),noSideEffects:z.literal(true)})}),signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/)});
const keySchema=z.strictObject({issuer:z.string().min(1).max(100),keyId:z.string().min(1).max(100),workspaceId:uuid,projectId:uuid,qaActorId:uuid,sourceRevision:z.string().regex(/^[0-9a-f]{40}$/),publicKeySpkiPem:z.string().min(40).max(2000)});
export function websiteStudioQaPublicKeys(): WebsiteStudioQaPublicKey[] {
 try { const raw=process.env.WEBSITE_SALES_STUDIO_QA_PUBLIC_KEYS; if(!raw || raw.length>32000)return []; return z.array(keySchema).max(20).parse(JSON.parse(raw)); } catch { return []; }
}
export function assertWebsiteStudioQaActor(workspaceId:string,projectId:string,actorId:string) {
 if(!websiteStudioQaPublicKeys().some(k=>k.workspaceId===workspaceId&&k.projectId===projectId&&k.qaActorId===actorId))throw new CrmCommandError("QA_ISSUER_REQUIRED","Configured independent QA actor required",403);
}
export function verifyWebsiteStudioQaCertificate(raw:unknown,artifact:WebsiteDemoArtifact,workflowId:string,builderId:string,now=new Date().toISOString()):WebsiteStudioQaCertificate {
 const parsed=certificateSchema.safeParse(raw); if(!parsed.success)throw new CrmCommandError("SIGNED_RENDERED_QA_REQUIRED","A signed rendered QA certificate is required",409);
 const {payload:p,signature}=parsed.data,id=artifact.identity;
 const key=websiteStudioQaPublicKeys().find(k=>k.issuer===p.issuer&&k.keyId===p.keyId&&k.workspaceId===p.workspaceId&&k.projectId===p.projectId&&k.qaActorId===p.qaActorId&&k.sourceRevision===p.sourceRevision);
 const checked=Date.parse(p.checkedAt),expiry=Date.parse(p.expiresAt),current=Date.parse(now);
 if(!key||p.qaActorId===builderId||p.workspaceId!==id.workspaceId||p.projectId!==id.projectId||p.companyId!==id.companyId||p.locationId!==id.locationId||p.workflowId!==workflowId||p.artifactDigest!==artifact.artifactDigest||p.htmlDigest!==artifact.content.htmlDigest||p.assetManifestDigest!==artifact.content.assetManifestDigest||p.evidenceDigest!==artifact.evidenceDigest||checked<Date.parse(artifact.createdAt)||checked>current||expiry<=current||expiry>checked+86400000||expiry>Date.parse(artifact.validUntil))throw new CrmCommandError("RENDERED_QA_SCOPE_DENIED","QA certificate is stale or does not match this artifact",409);
 try { const publicKey=createPublicKey(key.publicKeySpkiPem); if(publicKey.asymmetricKeyType!=="ed25519"||!verify(null,Buffer.from(canonicalWebsiteStudioQaPayload(p)),publicKey,Buffer.from(signature,"base64url")))throw new Error("invalid"); }
 catch { throw new CrmCommandError("RENDERED_QA_SIGNATURE_DENIED","Invalid rendered QA signature",403); }
 return parsed.data;
}
