import {
  parsePublicSubmissionProof,
  type PublicSubmissionProof,
} from "@/lib/public-submission-contract";

export const funnelRuntimeRequestBodyLimits = Object.freeze({
  maxBodyBytes: 4_096,
});

export type FunnelProofRefreshRequest = {
  proof: PublicSubmissionProof;
  publicationRevision: number;
};

export type FunnelVisitRequest = FunnelProofRefreshRequest;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPublicationRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseFunnelProofRefreshRequest(value: unknown): FunnelProofRefreshRequest | null {
  const record = asRecord(value);
  if (
    !record ||
    Object.keys(record).some((key) => key !== "proof" && key !== "publicationRevision") ||
    !isPublicationRevision(record.publicationRevision)
  ) {
    return null;
  }
  const proof = parsePublicSubmissionProof(record.proof);
  if (!proof) return null;

  return { proof, publicationRevision: record.publicationRevision };
}

export function parseFunnelVisitRequest(value: unknown): FunnelVisitRequest | null {
  return parseFunnelProofRefreshRequest(value);
}

export function isFunnelPublicationStaleResponse(value: unknown) {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.error === "funnel_publication_stale" &&
      record.reloadRequired === true,
  );
}
