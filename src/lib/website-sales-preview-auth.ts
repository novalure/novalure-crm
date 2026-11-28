import "server-only";
import { createHash } from "node:crypto";
import { verifyVercelOidcToken } from "@vercel/oidc";
import {
  CRM_MACHINE_ISSUER, CRM_MACHINE_OWNER_ID, CRM_MACHINE_PROJECT_ID, CRM_MACHINE_WORKSPACE_ID,
  CrmMachineAuthError, type CrmMachineAuthOptions,
} from "./crm-machine-auth";
import { resolveDatabaseUrl } from "./db/client";
import { studioEnquiryProject } from "./studio-enquiry-contract";

export const websiteSalesPreviewAudience = `urn:novalure:crm:website-sales:preview:${studioEnquiryProject}`;
export const websiteSalesPreviewSubject = "owner:novalure:project:evelyn:environment:preview";
export const websiteSalesPreviewIdentity = "EVELYN_WEBSITE_SALES_QA_IDENTITY";
export const websiteSalesProductionIdentity = "EVELYN_WEBSITE_SALES_INTERNAL_IDENTITY";
export type WebsiteSalesPreviewTarget = Readonly<{ deploymentId: string; revision: string }>;
const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function denied(): never { throw new CrmMachineAuthError("SALES_PREVIEW_ACCESS_DENIED", 403); }

export function isWebsiteSalesPreviewTarget(target: WebsiteSalesPreviewTarget) {
  return /^dpl_[a-zA-Z0-9]+$/.test(target.deploymentId) && /^[a-f0-9]{40}$/.test(target.revision);
}

export function websiteSalesPreviewReceiver(url: URL, env: NodeJS.ProcessEnv): WebsiteSalesPreviewTarget {
  const target = { deploymentId: env.VERCEL_DEPLOYMENT_ID ?? "", revision: env.VERCEL_GIT_COMMIT_SHA ?? "" };
  if (env.CRM_WEBSITE_SALES_PREVIEW_ENABLED !== "1" || env.CRM_MACHINE_AUTH_ENABLED !== "1" ||
    env.VERCEL !== "1" || env.VERCEL_ENV !== "preview" || env.VERCEL_PROJECT_ID !== studioEnquiryProject ||
    (env.VERCEL_TARGET_ENV && env.VERCEL_TARGET_ENV !== "preview") || !isWebsiteSalesPreviewTarget(target) ||
    url.protocol !== "https:" || url.hostname !== env.VERCEL_URL || !url.hostname.endsWith(".vercel.app") || url.port ||
    url.hash || url.username || url.password) denied();

  let database: URL;
  try { database = new URL(resolveDatabaseUrl(env)); } catch { return denied(); }
  if (database.protocol !== "postgresql:" || (database.port && database.port !== "5432") ||
    !/^ep-summer-dew-bht4t903-pooler\.[a-z0-9.-]+\.neon\.tech$/.test(database.hostname) ||
    database.pathname !== "/neondb" || database.username !== "novalure_app" ||
    !["require", "verify-full"].includes(database.searchParams.get("sslmode") ?? "") ||
    database.searchParams.getAll("sslmode").length !== 1 ||
    database.searchParams.getAll("channel_binding").length > 1 ||
    (database.searchParams.has("channel_binding") && database.searchParams.get("channel_binding") !== "require") ||
    [...database.searchParams.keys()].some(key => !["sslmode", "channel_binding"].includes(key))) denied();
  return Object.freeze(target);
}

export async function verifyWebsiteSalesPreviewToken(token: string, options: CrmMachineAuthOptions) {
  const now = options.now ?? new Date();
  const verification = await (options.verifier ?? verifyVercelOidcToken)(token, {
    algorithms: ["RS256"], typ: "JWT", issuer: CRM_MACHINE_ISSUER, audience: websiteSalesPreviewAudience,
    ownerId: CRM_MACHINE_OWNER_ID, projectId: CRM_MACHINE_PROJECT_ID, environment: "preview",
    currentDate: now, maxTokenAge: "5m", clockTolerance: 0,
    requiredClaims: ["iss", "aud", "sub", "iat", "nbf", "exp", "jti"],
  }).catch(denied);
  const { payload: p, protectedHeader: h } = verification;
  const time = Math.floor(now.getTime() / 1000);
  if (h.alg !== "RS256" || h.typ !== "JWT" || typeof h.kid !== "string" || !h.kid ||
    p.iss !== CRM_MACHINE_ISSUER || p.aud !== websiteSalesPreviewAudience || p.sub !== websiteSalesPreviewSubject ||
    p.project_id !== CRM_MACHINE_PROJECT_ID || p.owner_id !== CRM_MACHINE_OWNER_ID || p.environment !== "preview" ||
    typeof p.jti !== "string" || !uuidV4.test(p.jti) || typeof p.iat !== "number" || !Number.isSafeInteger(p.iat) ||
    typeof p.nbf !== "number" || !Number.isSafeInteger(p.nbf) || typeof p.exp !== "number" || !Number.isSafeInteger(p.exp) ||
    p.iat > time || p.iat <= time - 300 || p.nbf > time || p.exp <= time || p.exp <= p.iat) denied();
  return Object.freeze({
    issuer: CRM_MACHINE_ISSUER, audience: websiteSalesPreviewAudience, projectId: CRM_MACHINE_PROJECT_ID,
    ownerId: CRM_MACHINE_OWNER_ID, subject: websiteSalesPreviewSubject, workspaceId: CRM_MACHINE_WORKSPACE_ID,
    environment: "preview" as const, role: "Evelyn.QA" as const, consumer: "EVELYN" as const,
    jtiHash: createHash("sha256").update(p.jti).digest("hex"),
    expiresAt: Math.min(p.exp, p.iat + 300),
  });
}
