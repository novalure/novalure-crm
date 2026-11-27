import "server-only";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import { CrmMachineAuthError } from "../crm-machine-auth";

/** One existing Studio runtime, signal-only. No ProductMachine or CEO identity. */
export const studioRuntimeIdentity = Object.freeze({
  issuer: "https://oidc.vercel.com/novalure",
  audience: "urn:novalure:crm:shared-runtime:studio-webchat",
  subject: "owner:novalure:project:novalure-web-design:environment:production",
  projectId: "prj_ktiCTisS9QmWy4vkHLO8HG3BrhQp",
  project: "novalure-web-design", ownerId: "team_sjD78IkSicXJK6TAOR1JC7Wv", owner: "novalure", environment: "production",
  publicOrigin: "https://novalurestudio.ie",
  publicSiteKey: "nov_pk_mO7d0pjmZ4N3OFNfK2vzsCVazDbxdtFc", // gitleaks:allow -- Public browser selector; visitor session and Origin still authorize knowledge.
  integrationId: "09c83732-ead0-4bea-9fa6-a49de88e23d2",
  workspaceId: "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101",
  crmProjectId: "be5ff97d-69ce-4fc1-a35d-a8fe4a0ffb6c",
  botId: "c7cc70e8-0a10-47ce-a085-f3f61186678a",
} as const);
const keys = createRemoteJWKSet(new URL("https://oidc.vercel.com/novalure/.well-known/jwks"));
export type StudioRuntimeAuthOptions = Readonly<{ env?: NodeJS.ProcessEnv; now?: Date; keyResolver?: JWTVerifyGetKey }>;

/** Untrusted audience selects this fixed verifier only; it grants nothing. */
export function selectsStudioRuntimeVerifier(token: string): boolean {
  try { return decodeJwt(token).aud === studioRuntimeIdentity.audience; } catch { return false; }
}

export async function verifyStudioRuntimeToken(token: string, options: StudioRuntimeAuthOptions = {}) {
  const env = options.env ?? process.env;
  if (env.VERCEL_ENV !== "production" || env.NOVALURE_SHARED_STUDIO_RUNTIME_ENABLED !== "1") throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED", 403);
  const now = options.now ?? new Date();
  try {
    const { payload, protectedHeader } = await jwtVerify(token, options.keyResolver ?? keys, {
      algorithms: ["RS256"], issuer: studioRuntimeIdentity.issuer, audience: studioRuntimeIdentity.audience,
      currentDate: now, clockTolerance: 0, typ: "JWT", requiredClaims: ["aud", "exp", "iat", "nbf", "iss", "sub", "jti"],
    });
    if (protectedHeader.alg !== "RS256" || protectedHeader.typ !== "JWT" || typeof protectedHeader.kid !== "string" || protectedHeader.kid.length < 3 || protectedHeader.kid.length > 200 ||
      payload.sub !== studioRuntimeIdentity.subject || payload.project_id !== studioRuntimeIdentity.projectId || payload.project !== studioRuntimeIdentity.project ||
      payload.owner_id !== studioRuntimeIdentity.ownerId || payload.owner !== studioRuntimeIdentity.owner || payload.environment !== "production" ||
      payload.custom_environment_id !== undefined || payload.aud !== studioRuntimeIdentity.audience ||
      typeof payload.jti !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.jti) ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.nbf) || !Number.isSafeInteger(payload.exp) ||
      payload.iat! > Math.floor(now.valueOf() / 1000) || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 12 * 60 * 60) throw new Error("Invalid fixed caller");
    return studioRuntimeIdentity;
  } catch { throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED"); }
}
