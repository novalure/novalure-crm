import "server-only";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import { CrmMachineAuthError } from "../crm-machine-auth";

/** A separate exact caller; the existing Production machine identity is unchanged. */
export const personalRuntimeIdentity = Object.freeze({
  identityId: "EVELYN_FRANZ_PERSONAL_SHARED_RUNTIME",
  issuer: "https://oidc.vercel.com/novalure",
  audience: "urn:novalure:crm:shared-runtime:franz-personal",
  subject: "owner:novalure:project:evelyn:environment:franz-personal",
  projectId: "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I",
  ownerId: "team_sjD78IkSicXJK6TAOR1JC7Wv",
  environment: "franz-personal",
  customEnvironmentId: "env_sue274zKgFxQJiKfw64x7BmEfEwE",
  workspaceId: "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101",
  role: "Evelyn.Personal.SharedRuntime",
} as const);
const keys = createRemoteJWKSet(new URL("https://oidc.vercel.com/novalure/.well-known/jwks"));
export type PersonalRuntimeAuthOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Isolated signature tests only. No request or environment selects keys. */
  keyResolver?: JWTVerifyGetKey;
}>;
export type PersonalRuntimeClaims = typeof personalRuntimeIdentity;

/** Untrusted audience selects a fixed verifier only; it conveys no authority. */
export function selectsPersonalRuntimeVerifier(token: string): boolean {
  try { return decodeJwt(token).aud === personalRuntimeIdentity.audience; }
  catch { return false; }
}
export async function verifyPersonalRuntimeToken(token: string, options: PersonalRuntimeAuthOptions = {}): Promise<PersonalRuntimeClaims> {
  const env = options.env ?? process.env;
  if (env.EVELYN_SHARED_PERSONAL_RUNTIME_ENABLED !== "1" || env.VERCEL_ENV !== "production")
    throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED", 403);
  const now = options.now ?? new Date();
  try {
    const { payload, protectedHeader } = await jwtVerify(token, options.keyResolver ?? keys, {
      algorithms: ["RS256"], issuer: personalRuntimeIdentity.issuer, audience: personalRuntimeIdentity.audience,
      currentDate: now, clockTolerance: 0, typ: "JWT",
      requiredClaims: ["aud", "exp", "iat", "nbf", "iss", "sub", "jti"],
    });
    if (protectedHeader.alg !== "RS256" || protectedHeader.typ !== "JWT" ||
      typeof protectedHeader.kid !== "string" || protectedHeader.kid.length < 3 ||
      payload.sub !== personalRuntimeIdentity.subject || payload.owner_id !== personalRuntimeIdentity.ownerId ||
      payload.owner !== "novalure" || payload.project_id !== personalRuntimeIdentity.projectId ||
      payload.project !== "evelyn" || payload.environment !== personalRuntimeIdentity.environment ||
      payload.custom_environment_id !== personalRuntimeIdentity.customEnvironmentId ||
      payload.aud !== personalRuntimeIdentity.audience ||
      typeof payload.jti !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.jti) ||
      !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.nbf) ||
      payload.iat! > Math.floor(now.valueOf() / 1000) || payload.exp! <= payload.iat! ||
      payload.exp! - payload.iat! > 12 * 60 * 60)
      throw new Error("Invalid fixed caller");
    return personalRuntimeIdentity;
  } catch {
    throw new CrmMachineAuthError("RUNTIME_AUTH_DENIED");
  }
}
