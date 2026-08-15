import type { AppRole } from "@/lib/auth/permissions";
import {
  createOpaqueToken,
  decryptAuthValue,
  encryptAuthValue,
  normalizeAuthEmail,
  protectLowEntropyValue,
} from "@/lib/auth/auth-security";
import {
  createRecoveryCodes,
  createTotpSecret,
  normalizeRecoveryCode,
} from "@/lib/auth/mfa-core";
import type { ProductRole } from "@/lib/product-model";

export {
  createRecoveryCodes,
  createTotpCode,
  createTotpSecret,
  normalizeRecoveryCode,
  verifyTotpCode,
} from "@/lib/auth/mfa-core";

export type MfaEnrollmentPayload = {
  recoveryCodes: string[];
  secret: string;
};

const privilegedProductRoles = new Set<ProductRole>([
  "platform_admin",
  "novalureGrowth",
  "novalureServiceOps",
  "novalureAdmin",
  "novalure_sales",
  "novalure_onboarding",
  "novalure_customer_success",
  "novalure_operator",
  "customer_owner",
  "workspace_admin",
]);

export function hashRecoveryCode(value: string) {
  const normalized = normalizeRecoveryCode(value);
  if (normalized.length < 16) return null;
  return protectLowEntropyValue("mfa-recovery-code", normalized);
}

export function createMfaEnrollmentPayload(): MfaEnrollmentPayload {
  return {
    recoveryCodes: createRecoveryCodes(),
    secret: createTotpSecret(),
  };
}

export function encryptMfaEnrollmentPayload(payload: MfaEnrollmentPayload) {
  return encryptAuthValue(payload);
}

export function decryptMfaEnrollmentPayload(value: string) {
  const payload = decryptAuthValue<MfaEnrollmentPayload>(value);
  if (
    !payload ||
    typeof payload.secret !== "string" ||
    !Array.isArray(payload.recoveryCodes) ||
    payload.recoveryCodes.some((code) => typeof code !== "string")
  ) return null;
  return payload;
}

export function encryptMfaSecret(secret: string) {
  return encryptAuthValue({ secret });
}

export function decryptMfaSecret(value: string) {
  const payload = decryptAuthValue<{ secret: string }>(value);
  return payload && typeof payload.secret === "string" ? payload.secret : null;
}

export function isPrivilegedMembership(role: AppRole, productRole: ProductRole) {
  return role === "owner" || role === "admin" || privilegedProductRoles.has(productRole);
}

export function buildTotpProvisioningUri(input: { email: string; secret: string }) {
  const account = normalizeAuthEmail(input.email);
  const label = encodeURIComponent(`Novalure CRM:${account}`);
  const params = new URLSearchParams({
    algorithm: "SHA1",
    digits: "6",
    issuer: "Novalure CRM",
    period: "30",
    secret: input.secret,
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function createChallengeToken() {
  return `v1.${createOpaqueToken(32)}`;
}
