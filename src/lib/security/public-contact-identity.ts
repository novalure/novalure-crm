export const publicContactIdentityLockNamespace = "public_contact_identity";

export function normalizePublicContactEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

export function normalizePublicContactPhone(value: string | null | undefined) {
  return value?.replace(/[^0-9+]/gu, "") ?? "";
}

export function buildPublicContactIdentityLocks(input: {
  email?: string | null;
  fallback: string;
  phone?: string | null;
}) {
  const normalizedEmail = normalizePublicContactEmail(input.email);
  const normalizedPhone = normalizePublicContactPhone(input.phone);
  const locks = [
    normalizedEmail ? `email:${normalizedEmail}` : "",
    normalizedPhone ? `phone:${normalizedPhone}` : "",
  ].filter(Boolean).sort();
  return locks.length ? locks : [`submission:${input.fallback}`];
}
