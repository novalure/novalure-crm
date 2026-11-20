import "server-only";
import { createHash } from "node:crypto";
import { verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";

export const PROPERTY_READER_AUDIENCE = "urn:novalure:crm:property-read-v1";
const verifiedIdentities = new WeakSet<object>();
const jwt = /^eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Verifier = (token: string, options: Parameters<typeof verifyVercelOidcToken>[1]) => Promise<Awaited<ReturnType<typeof verifyVercelOidcToken<VercelOidcPayload>>>>;
export type VerifiedPropertyIdentity = Readonly<{
  issuer: string; subject: string; audience: typeof PROPERTY_READER_AUDIENCE;
  ownerId: string; workloadProjectId: string; environment: "preview" | "production";
  expiresAt: number; jtiHash: string;
}>;

/**
 * Verify a separate property-reader audience using server-owned configuration.
 * No identity or grant is provisioned by this module. The optional verifier is
 * available only to local tests; callers cannot supply configuration or claims.
 */
export async function verifyPropertyReaderIdentity(token: string, testVerifier?: Verifier): Promise<VerifiedPropertyIdentity> {
  if (testVerifier && process.env.NODE_ENV !== "test") throw new Error("CRM_PROPERTY_AUTH_DENIED");
  const env = process.env;
  const issuer = env.CRM_PROPERTY_READER_ISSUER;
  const subject = env.CRM_PROPERTY_READER_SUBJECT;
  const ownerId = env.CRM_PROPERTY_READER_OWNER_ID;
  const workloadProjectId = env.CRM_PROPERTY_READER_PROJECT_ID;
  const environment = env.VERCEL_ENV;
  if (env.CRM_PROPERTY_READER_ENABLED !== "1" || !issuer || !/^https:\/\/[^/]+\/.+/.test(issuer) || !subject || !ownerId || !workloadProjectId ||
      !["preview", "production"].includes(String(environment)) || !jwt.test(token)) throw new Error("CRM_PROPERTY_AUTH_DENIED");
  const now = Math.floor(Date.now() / 1000);
  let result: Awaited<ReturnType<Verifier>>;
  try {
    result = await (testVerifier ?? (verifyVercelOidcToken as Verifier))(token, {
      algorithms: ["RS256"], audience: PROPERTY_READER_AUDIENCE, clockTolerance: 30,
      environment: environment as "preview" | "production", issuer, ownerId, projectId: workloadProjectId,
      requiredClaims: ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"], typ: "JWT",
    });
  } catch { throw new Error("CRM_PROPERTY_AUTH_DENIED"); }
  const payload = result.payload;
  const issuedAt = payload.iat, expiresAt = payload.exp, notBefore = payload.nbf;
  if (result.protectedHeader.alg !== "RS256" || result.protectedHeader.typ !== "JWT" ||
      typeof result.protectedHeader.kid !== "string" || result.protectedHeader.kid.length < 3 ||
      typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) ||
      typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) ||
      typeof notBefore !== "number" || !Number.isSafeInteger(notBefore) ||
      issuedAt > now + 30 || notBefore > now + 30 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 12 * 60 * 60 ||
      payload.iss !== issuer || payload.sub !== subject || payload.aud !== PROPERTY_READER_AUDIENCE ||
      payload.owner_id !== ownerId || payload.project_id !== workloadProjectId || payload.environment !== environment ||
      typeof payload.jti !== "string" || !uuid.test(payload.jti)) throw new Error("CRM_PROPERTY_AUTH_DENIED");
  const identity: VerifiedPropertyIdentity = Object.freeze({ issuer, subject, audience: PROPERTY_READER_AUDIENCE,
    ownerId, workloadProjectId, environment: environment as "preview" | "production", expiresAt,
    jtiHash: createHash("sha256").update(payload.jti).digest("hex") });
  verifiedIdentities.add(identity);
  return identity;
}

/** Checks provenance and expiry again immediately before the protected read. */
export function assertVerifiedPropertyReaderIdentity(identity: VerifiedPropertyIdentity): void {
  const env = process.env;
  if (!identity || !verifiedIdentities.has(identity) || env.CRM_PROPERTY_READER_ENABLED !== "1" ||
      env.CRM_PROPERTY_READER_ISSUER !== identity.issuer || env.CRM_PROPERTY_READER_SUBJECT !== identity.subject ||
      env.CRM_PROPERTY_READER_OWNER_ID !== identity.ownerId || env.CRM_PROPERTY_READER_PROJECT_ID !== identity.workloadProjectId ||
      env.VERCEL_ENV !== identity.environment || identity.audience !== PROPERTY_READER_AUDIENCE ||
      !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error("CRM_PROPERTY_AUTH_DENIED");
  }
}
