export const publicSubmissionActions = {
  booking: "meeting_booking",
  form: "website_form",
  funnel: "funnel_submission",
} as const;

export const publicSubmissionControlFields = {
  expiresAt: "_novalure_proof_expires_at",
  honeypot: "_novalure_company",
  idempotencyKey: "_novalure_idempotency_key",
  issuedAt: "_novalure_proof_issued_at",
  proof: "_novalure_proof",
} as const;

export type PublicSubmissionAction =
  (typeof publicSubmissionActions)[keyof typeof publicSubmissionActions];

export type PublicSubmissionProof = {
  expiresAt: number;
  idempotencyKey: string;
  issuedAt: number;
  signature: string;
};

export const publicSubmissionProofRefreshLeadSeconds = 2 * 60;

export function parsePublicSubmissionProof(value: unknown): PublicSubmissionProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.expiresAt) ||
    !Number.isSafeInteger(candidate.issuedAt) ||
    typeof candidate.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(candidate.idempotencyKey) ||
    typeof candidate.signature !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(candidate.signature)
  ) {
    return null;
  }

  return {
    expiresAt: candidate.expiresAt as number,
    idempotencyKey: candidate.idempotencyKey,
    issuedAt: candidate.issuedAt as number,
    signature: candidate.signature,
  };
}
