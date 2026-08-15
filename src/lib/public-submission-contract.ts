export const publicSubmissionActions = {
  booking: "meeting_booking",
  form: "website_form",
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
