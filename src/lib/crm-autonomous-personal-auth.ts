import { createHash } from "node:crypto";
import { verifyVercelOidcToken } from "@vercel/oidc";
import { CrmMachineAuthError, CRM_MACHINE_AUDIENCE, CRM_MACHINE_CONSUMER, CRM_MACHINE_ISSUER,
  CRM_MACHINE_MAX_TTL_SECONDS, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_ROLE,
  CRM_MACHINE_WORKSPACE_ID, type CrmMachineAuthOptions, type CrmMachineClaims } from "./crm-machine-auth";

export const CRM_PERSONAL_SOURCE = Object.freeze({
  identityId: "EVELYN_CRM_PERSONAL_INTERNAL_IDENTITY", environment: "franz-personal",
  subject: "owner:novalure:project:evelyn:environment:franz-personal",
  customEnvironmentId: "env_sue274zKgFxQJiKfw64x7BmEfEwE",
} as const);
export type CrmPersonalSourceClaims = Omit<CrmMachineClaims, "environment" | "identityId" | "subject"> & {
  environment: typeof CRM_PERSONAL_SOURCE.environment; identityId: typeof CRM_PERSONAL_SOURCE.identityId;
  subject: typeof CRM_PERSONAL_SOURCE.subject; customEnvironmentId: typeof CRM_PERSONAL_SOURCE.customEnvironmentId;
};
const jwt = /^eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const denied = (): never => { throw new CrmMachineAuthError("ACCESS_DENIED", 401); };

/** Only the real delegated gateway calls this verifier. The legacy production
 * and synthetic verifier is unchanged. An explicit server flag is not a grant. */
export async function verifyPersonalAutonomousCrmToken(token: string, options: CrmMachineAuthOptions = {}): Promise<CrmPersonalSourceClaims> {
  const env = options.env ?? process.env, now = options.now ?? new Date();
  if (env.CRM_MACHINE_AUTH_ENABLED !== "1" || env.CRM_AUTONOMOUS_PERSONAL_SOURCE_ENABLED !== "1" ||
      env.VERCEL_ENV !== "production" || !jwt.test(token)) return denied();
  let result: Awaited<ReturnType<typeof verifyVercelOidcToken>>;
  try {
    result = await (options.verifier ?? verifyVercelOidcToken)(token, {
      algorithms: ["RS256"], typ: "JWT", audience: CRM_MACHINE_AUDIENCE, issuer: CRM_MACHINE_ISSUER,
      ownerId: CRM_MACHINE_OWNER_ID, projectId: CRM_MACHINE_PROJECT_ID, environment: CRM_PERSONAL_SOURCE.environment,
      currentDate: now, clockTolerance: 0, maxTokenAge: "5m",
      requiredClaims: ["aud", "exp", "iat", "iss", "jti", "nbf", "sub", "custom_environment_id"],
    });
  } catch { return denied(); }
  const { payload: p, protectedHeader: h } = result, seconds = Math.floor(now.valueOf() / 1000);
  const iat = p.iat, exp = p.exp, nbf = p.nbf;
  if (h.alg !== "RS256" || h.typ !== "JWT" || typeof h.kid !== "string" || h.kid.length < 3 ||
      typeof iat !== "number" || typeof exp !== "number" || typeof nbf !== "number" ||
      !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || !Number.isSafeInteger(nbf) ||
      iat > seconds || iat < seconds - 300 || nbf > seconds || exp <= seconds || exp <= iat || exp - iat > CRM_MACHINE_MAX_TTL_SECONDS ||
      p.iss !== CRM_MACHINE_ISSUER || p.aud !== CRM_MACHINE_AUDIENCE || p.owner_id !== CRM_MACHINE_OWNER_ID ||
      p.project_id !== CRM_MACHINE_PROJECT_ID || p.environment !== CRM_PERSONAL_SOURCE.environment ||
      p.sub !== CRM_PERSONAL_SOURCE.subject || p.custom_environment_id !== CRM_PERSONAL_SOURCE.customEnvironmentId ||
      typeof p.jti !== "string" || !uuid.test(p.jti)) return denied();
  return Object.freeze({ audience: CRM_MACHINE_AUDIENCE, consumer: CRM_MACHINE_CONSUMER,
    environment: CRM_PERSONAL_SOURCE.environment, expiresAt: exp, identityId: CRM_PERSONAL_SOURCE.identityId,
    issuedAt: iat, issuer: CRM_MACHINE_ISSUER, jti: p.jti, jtiHash: createHash("sha256").update(p.jti).digest("hex"),
    keyId: h.kid, notBefore: nbf, ownerId: CRM_MACHINE_OWNER_ID, projectId: CRM_MACHINE_PROJECT_ID,
    role: CRM_MACHINE_ROLE, subject: CRM_PERSONAL_SOURCE.subject, workspaceId: CRM_MACHINE_WORKSPACE_ID,
    customEnvironmentId: CRM_PERSONAL_SOURCE.customEnvironmentId });
}
