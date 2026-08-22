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

export type FunnelVisitRequest = FunnelProofRefreshRequest & {
  visitId: string;
};

const visitIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  const record = asRecord(value);
  if (
    !record ||
    Object.keys(record).some((key) =>
      key !== "proof" && key !== "publicationRevision" && key !== "visitId"
    ) ||
    !isPublicationRevision(record.publicationRevision) ||
    typeof record.visitId !== "string" ||
    !visitIdPattern.test(record.visitId)
  ) {
    return null;
  }
  const proof = parsePublicSubmissionProof(record.proof);
  if (!proof) return null;

  return {
    proof,
    publicationRevision: record.publicationRevision,
    visitId: record.visitId,
  };
}

export function getOrCreatePublicFunnelVisitId(
  funnelId: string,
  publicationRevision: number,
) {
  const storageKey = `novalure:funnel-visit:${funnelId}:publication:${publicationRevision}`;
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing && visitIdPattern.test(existing)) return existing;
    const created = window.crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return globalThis.crypto.randomUUID();
  }
}

export function isFunnelPublicationStaleResponse(value: unknown) {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.error === "funnel_publication_stale" &&
      record.reloadRequired === true,
  );
}
