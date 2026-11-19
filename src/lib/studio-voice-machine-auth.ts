import { createHash } from "node:crypto";
import { verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";
import { CrmMachineAuthError } from "./crm-machine-auth";

export const STUDIO_VOICE_AUDIENCE = "urn:novalure:crm:studio:voice-booking:production";
export const STUDIO_VOICE_IDENTITY_ID = "NOVALURE_STUDIO_VOICE_BOOKING";
export const STUDIO_VOICE_WORKSPACE_ID = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
export const STUDIO_VOICE_MAX_TTL_SECONDS = 12 * 60 * 60;
const issuer = "https://oidc.vercel.com/novalure", ownerId = "team_sjD78IkSicXJK6TAOR1JC7Wv";
const projectId = "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I", subject = "owner:novalure:project:evelyn:environment:production";
const environment = "production", tolerance = 30;
const jwtShape = /^eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Verifier = (token: string, options: Parameters<typeof verifyVercelOidcToken>[1]) =>
  Promise<Awaited<ReturnType<typeof verifyVercelOidcToken<VercelOidcPayload>>>>;
export type StudioVoiceMachineAuthOptions = Readonly<{ env?: NodeJS.ProcessEnv; now?: Date; verifier?: Verifier }>;
export type StudioVoiceMachineClaims = Readonly<{
  audience: typeof STUDIO_VOICE_AUDIENCE; identityId: typeof STUDIO_VOICE_IDENTITY_ID;
  workspaceId: typeof STUDIO_VOICE_WORKSPACE_ID; subject: typeof subject; issuer: typeof issuer;
  projectId: typeof projectId; ownerId: typeof ownerId; environment: typeof environment;
  issuedAt: number; notBefore: number; expiresAt: number; jti: string; jtiHash: string; keyId: string;
}>;
const deny = (code = "STUDIO_VOICE_AUTH_DENIED", status = 401): never => { throw new CrmMachineAuthError(code, status); };

/** A separate signed audience. This verifier never issues a CRM principal or booking grant. */
export async function verifyStudioVoiceMachineToken(token: string, options: StudioVoiceMachineAuthOptions = {}): Promise<StudioVoiceMachineClaims> {
  const env = options.env ?? process.env, now = options.now ?? new Date();
  if (env.STUDIO_VOICE_AUTH_ENABLED !== "1" || env.VERCEL_ENV !== environment) return deny("STUDIO_VOICE_AUTH_DISABLED", 403);
  if (token.length > 16_384 || !jwtShape.test(token) || !Number.isFinite(now.valueOf())) return deny();
  let verified: Awaited<ReturnType<typeof verifyVercelOidcToken<VercelOidcPayload>>>;
  try {
    verified = await (options.verifier ?? (verifyVercelOidcToken as Verifier))(token, {
      algorithms: ["RS256"], audience: STUDIO_VOICE_AUDIENCE, clockTolerance: tolerance, currentDate: now,
      environment, issuer, ownerId, projectId, requiredClaims: ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"], typ: "JWT",
    });
  } catch { return deny(); }
  const { payload: p, protectedHeader: h } = verified, at = Math.floor(now.valueOf() / 1000);
  if (h.alg !== "RS256" || h.typ !== "JWT" || typeof h.kid !== "string" || h.kid.length < 3 ||
    typeof p.iat !== "number" || !Number.isSafeInteger(p.iat) || typeof p.nbf !== "number" || !Number.isSafeInteger(p.nbf) ||
    typeof p.exp !== "number" || !Number.isSafeInteger(p.exp) || p.iat > at + tolerance || p.nbf > at + tolerance ||
    p.exp <= at - tolerance || p.exp <= p.iat || p.exp - p.iat > STUDIO_VOICE_MAX_TTL_SECONDS ||
    p.iss !== issuer || p.aud !== STUDIO_VOICE_AUDIENCE || p.sub !== subject || p.project_id !== projectId || p.owner_id !== ownerId ||
    p.environment !== environment || typeof p.jti !== "string" || !uuidV4.test(p.jti)) return deny();
  return Object.freeze({ audience: STUDIO_VOICE_AUDIENCE, identityId: STUDIO_VOICE_IDENTITY_ID, workspaceId: STUDIO_VOICE_WORKSPACE_ID,
    subject, issuer, projectId, ownerId, environment, issuedAt: p.iat, notBefore: p.nbf, expiresAt: p.exp,
    jti: p.jti, jtiHash: createHash("sha256").update(p.jti).digest("hex"), keyId: h.kid });
}
