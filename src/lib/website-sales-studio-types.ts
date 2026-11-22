/** Browser-safe wire types. Authority is always resolved by the server. */
import type { WebsiteStudioArtifact, WebsiteDemoArtifact } from "./website-sales-studio";
import type { WebsiteInvestmentInput } from "./website-prospect";
export const websiteSalesStudioContract = "website-sales-studio-api-v1" as const;
export const websiteSalesStudioPath = "/api/crm/website-sales/studio";
export type StudioScope = { projectId: string; companyId: string; locationId: string };
export type StudioOperation = "create_diagnosis" | "create_concept" | "accept_concept" | "build_demo" | "submit_qa" | "create_preview" | "revoke_preview";
export type WebsiteSalesStudioCommand = StudioScope & {
  contractVersion: typeof websiteSalesStudioContract; operation: StudioOperation;
  workflowId: string; expectedWorkflowVersion: number; expectedEvidenceDigest: string;
  idempotencyKey: string; correlationId: string;allocationProof?:{allocationId:string;version:number;leaseToken:string}; payload: Record<string, unknown>;
};
export type WebsiteStudioInvestment = Omit<WebsiteInvestmentInput, "requestedStage" | "completedStage" | "completedStageEvidence">;
export type WebsiteStudioQaPayload = {
  contractVersion: "website-sales-rendered-qa-v1"; issuer: string; keyId: string; certificateId: string;
  workspaceId: string; projectId: string; companyId: string; locationId: string; workflowId: string;
  artifactDigest: string; htmlDigest: string; assetManifestDigest: string; evidenceDigest: string;
  qaActorId: string; sourceRevision: string; checkedAt: string; expiresAt: string;
  checks: { desktop: true; tablet: true; mobile: true; reducedMotion: true; keyboard: true; noConsoleErrors: true; noSideEffects: true };
};
export type WebsiteStudioQaCertificate = { payload: WebsiteStudioQaPayload; signature: string };
export type WebsiteStudioQaPublicKey = {
  issuer: string; keyId: string; workspaceId: string; projectId: string; qaActorId: string;
  sourceRevision: string; publicKeySpkiPem: string;
};
type DemoAsset = WebsiteDemoArtifact['content']['assets'][number];
export type WebsiteStudioReadArtifact = Exclude<WebsiteStudioArtifact, {kind:'DEMO'}> | (Omit<WebsiteDemoArtifact,'content'> & { content: Omit<WebsiteDemoArtifact['content'],'assets'> & { assets: (DemoAsset | (Omit<Extract<DemoAsset,{bodyEncoding:'BASE64'}>,'body'> & {bodyOmitted:true}))[] } });
/** Omitted raster bodies are an explicit human projection, never a full verifiable artifact. */
export type StudioArtifactRecord = { id: string; createdBy: string; artifact: WebsiteStudioReadArtifact; accepted: boolean; qa: { certificateId: string; expiresAt: string } | null };
export type StudioPreviewRecord = { id: string; artifactId: string; contactId: string; expiresAt: string; revokedAt: string | null; version: number };
export type WebsiteSalesStudioRead = StudioScope & {
  contractVersion: typeof websiteSalesStudioContract; workspaceId: string; workflowId: string;
  workflowVersion: number; evidenceDigest: string; blockedReason: string | null; canWrite: boolean;
  companyName: string; locationLabel: string; contactId: string | null; validUntil: string;
  sourceFacts: { evidenceId: string; finding: string; sourceUrl: string; validUntil: string }[];
  canContact: false; artifacts: StudioArtifactRecord[]; previews: StudioPreviewRecord[];
};
/** The signing bytes are UTF-8 of this sorted-key JSON. No whitespace, no signature field. */
export function canonicalWebsiteStudioQaPayload(value: WebsiteStudioQaPayload): string {
  function canonical(item: unknown): string {
    if (item === null || typeof item !== "object") return JSON.stringify(item) ?? "null";
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return canonical(value);
}
