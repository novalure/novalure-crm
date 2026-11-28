import "server-only";
import { CrmCommandError } from "./crm-command";
import { studioEnquiryProject } from "./studio-enquiry-contract";
import { isWebsiteSalesPreviewTarget } from "./website-sales-preview-auth";

export const autonomousReceiverProofFields = ["receiverDeploymentId", "receiverRevision"] as const;
export type AutonomousReceiverPins = Readonly<{ receiverDeploymentId: string; receiverRevision: string }>;

/** Presence selects the signed domain. Never normalize or fill unsigned pins. */
export function parseAutonomousReceiverPins(proof: Record<string, unknown>): AutonomousReceiverPins | null {
  const deployment = Object.hasOwn(proof, "receiverDeploymentId"), revision = Object.hasOwn(proof, "receiverRevision");
  if (!deployment && !revision) return null;
  if (!deployment || !revision || typeof proof.receiverDeploymentId !== "string" || typeof proof.receiverRevision !== "string" ||
      !isWebsiteSalesPreviewTarget({ deploymentId: proof.receiverDeploymentId, revision: proof.receiverRevision })) {
    throw new CrmCommandError("RECEIVER_BINDING_INVALID", "Signed receiver binding is invalid", 401);
  }
  return { receiverDeploymentId: proof.receiverDeploymentId, receiverRevision: proof.receiverRevision };
}

/** Native Vercel values, as used by SOURCE/Sales; build overrides are not authority. */
export function assertAutonomousReceiver(pins: AutonomousReceiverPins | null, env: NodeJS.ProcessEnv): void {
  if (!pins) return;
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "production" || env.VERCEL_PROJECT_ID !== studioEnquiryProject ||
      (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== "production") ||
      !isWebsiteSalesPreviewTarget({ deploymentId: env.VERCEL_DEPLOYMENT_ID ?? "", revision: env.VERCEL_GIT_COMMIT_SHA ?? "" }) ||
      env.VERCEL_DEPLOYMENT_ID !== pins.receiverDeploymentId || env.VERCEL_GIT_COMMIT_SHA !== pins.receiverRevision) {
    throw new CrmCommandError("RECEIVER_MISMATCH", "CRM receiver deployment does not match the signed binding", 403);
  }
}
