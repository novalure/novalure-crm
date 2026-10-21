import "server-only";

import { createHash } from "node:crypto";
import { verifyVercelOidcToken, type VercelOidcPayload } from "@vercel/oidc";
import { CrmMachineAuthError } from "@/lib/crm-machine-auth";

// This is a distinct, opt-in Knowledge QA contract. The Production verifier and
// its identity are deliberately not parameterized or reused for Preview claims.
export const KNOWLEDGE_QA_IDENTITY_ID = "EVELYN_CRM_KNOWLEDGE_QA_IDENTITY";
export const KNOWLEDGE_QA_ISSUER = "https://oidc.vercel.com/novalure";
export const KNOWLEDGE_QA_OWNER_ID = "team_sjD78IkSicXJK6TAOR1JC7Wv";
export const KNOWLEDGE_QA_SENDER_PROJECT_ID = "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I";
export const KNOWLEDGE_QA_RECEIVER_PROJECT_ID = "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
export const KNOWLEDGE_QA_RECEIVER_BRANCH = "codex/evelyn-crm-package4-integration";
export const KNOWLEDGE_QA_SUBJECT = "owner:novalure:project:evelyn:environment:preview";
export const KNOWLEDGE_QA_MAX_TTL_SECONDS = 12 * 60 * 60;
const tolerance = 30;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jwtShape = /^eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
type Verifier = (
  token: string,
  options: Parameters<typeof verifyVercelOidcToken>[1],
) => Promise<Awaited<ReturnType<typeof verifyVercelOidcToken<VercelOidcPayload>>>>;
export type KnowledgeQaAuthOptions = Readonly<{ env?: NodeJS.ProcessEnv; now?: Date; verifier?: Verifier }>;
export type KnowledgeQaProfile = Readonly<{ workspaceId: string; audience: string; receiverHostname: string }>;
export type KnowledgeQaClaims = Readonly<{
  audience: string; consumer: "EVELYN"; environment: "preview";
  identityId: typeof KNOWLEDGE_QA_IDENTITY_ID;
  issuer: typeof KNOWLEDGE_QA_ISSUER; ownerId: typeof KNOWLEDGE_QA_OWNER_ID;
  projectId: typeof KNOWLEDGE_QA_SENDER_PROJECT_ID; role: "Evelyn.QA";
  subject: typeof KNOWLEDGE_QA_SUBJECT; workspaceId: string;
  jti: string; jtiHash: string; keyId: string;
  issuedAt: number; notBefore: number; expiresAt: number;
}>;

function denied(): never { throw new CrmMachineAuthError("CRM_KNOWLEDGE_QA_ACCESS_DENIED", 403); }

export function knowledgeQaAudience(workspaceId: string) {
  if (!uuidV4.test(workspaceId)) denied();
  return `urn:novalure:crm:knowledge-qa:${KNOWLEDGE_QA_RECEIVER_PROJECT_ID}:${workspaceId}`;
}

/** No request header, tenant argument or caller-provided hostname selects trust. */
export function resolveKnowledgeQaProfile(
  requestUrl: string, env: NodeJS.ProcessEnv = process.env,
): KnowledgeQaProfile | null {
  if (env.CRM_KNOWLEDGE_QA_MACHINE_ENABLED !== "1") return null;
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "preview" ||
    (env.VERCEL_TARGET_ENV !== undefined && env.VERCEL_TARGET_ENV !== "preview") ||
    env.VERCEL_PROJECT_ID !== KNOWLEDGE_QA_RECEIVER_PROJECT_ID ||
    env.VERCEL_GIT_COMMIT_REF !== KNOWLEDGE_QA_RECEIVER_BRANCH) denied();
  const hostname = env.VERCEL_URL ?? "";
  // The platform's unique deployment hostname is the server-side host pin. A
  // URL from a request or arbitrary QA origin env cannot expand this boundary.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(hostname)) denied();
  let url: URL;
  try { url = new URL(requestUrl); } catch { return denied(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname !== hostname ||
    url.search || url.hash || !["/api/integrations/knowledge/webchat", "/api/integrations/knowledge/voice"].includes(url.pathname)) denied();
  const workspaceId = env.CRM_KNOWLEDGE_QA_WORKSPACE_ID ?? "";
  return Object.freeze({ workspaceId, audience: knowledgeQaAudience(workspaceId), receiverHostname: hostname });
}

export async function verifyKnowledgeQaToken(
  token: string, requestUrl: string, options: KnowledgeQaAuthOptions = {},
): Promise<KnowledgeQaClaims> {
  const profile = resolveKnowledgeQaProfile(requestUrl, options.env ?? process.env);
  if (!profile || !jwtShape.test(token)) denied();
  const now = options.now ?? new Date();
  let verified: Awaited<ReturnType<typeof verifyVercelOidcToken<VercelOidcPayload>>>;
  try {
    verified = await (options.verifier ?? verifyVercelOidcToken<VercelOidcPayload>)(token, {
      algorithms: ["RS256"], audience: profile.audience, issuer: KNOWLEDGE_QA_ISSUER,
      ownerId: KNOWLEDGE_QA_OWNER_ID, projectId: KNOWLEDGE_QA_SENDER_PROJECT_ID,
      environment: "preview", typ: "JWT", clockTolerance: tolerance, currentDate: now,
      requiredClaims: ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"],
    });
  } catch { return denied(); }
  const { payload, protectedHeader } = verified;
  const issuedAt = payload.iat, expiresAt = payload.exp, notBefore = payload.nbf;
  const nowSeconds = Math.floor(now.valueOf() / 1000);
  if (protectedHeader.alg !== "RS256" || protectedHeader.typ !== "JWT" ||
    typeof protectedHeader.kid !== "string" || protectedHeader.kid.length < 3 ||
    typeof issuedAt !== "number" || typeof expiresAt !== "number" || typeof notBefore !== "number" ||
    !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(notBefore) ||
    issuedAt > nowSeconds + tolerance || notBefore > nowSeconds + tolerance ||
    expiresAt <= nowSeconds - tolerance || expiresAt <= issuedAt || notBefore >= expiresAt ||
    expiresAt - issuedAt > KNOWLEDGE_QA_MAX_TTL_SECONDS ||
    payload.iss !== KNOWLEDGE_QA_ISSUER || payload.aud !== profile.audience ||
    payload.sub !== KNOWLEDGE_QA_SUBJECT || payload.project_id !== KNOWLEDGE_QA_SENDER_PROJECT_ID ||
    payload.owner_id !== KNOWLEDGE_QA_OWNER_ID || payload.environment !== "preview" ||
    typeof payload.jti !== "string" || !uuidV4.test(payload.jti)) denied();
  // Vercel's standard OIDC contract authenticates the Evelyn Preview PROJECT,
  // not an individual sender branch/deployment. Do not invent such a JWT pin.
  return Object.freeze({
    audience: profile.audience, consumer: "EVELYN", environment: "preview",
    identityId: KNOWLEDGE_QA_IDENTITY_ID, issuer: KNOWLEDGE_QA_ISSUER,
    ownerId: KNOWLEDGE_QA_OWNER_ID, projectId: KNOWLEDGE_QA_SENDER_PROJECT_ID,
    role: "Evelyn.QA", subject: KNOWLEDGE_QA_SUBJECT, workspaceId: profile.workspaceId,
    jti: payload.jti, jtiHash: createHash("sha256").update(payload.jti).digest("hex"),
    keyId: protectedHeader.kid, issuedAt, notBefore, expiresAt,
  });
}
