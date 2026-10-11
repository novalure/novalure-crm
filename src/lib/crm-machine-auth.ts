import { createHash } from "node:crypto";
import {
  verifyVercelOidcToken,
  type VercelOidcPayload,
} from "@vercel/oidc";

export const CRM_MACHINE_AUDIENCE = "urn:novalure:crm:production";
export const CRM_MACHINE_CONSUMER = "EVELYN";
export const CRM_MACHINE_ENVIRONMENT = "production";
export const CRM_MACHINE_IDENTITY_ID = "EVELYN_CRM_SERVICE_IDENTITY";
export const CRM_MACHINE_ISSUER = "https://oidc.vercel.com/novalure";
export const CRM_MACHINE_OWNER_ID = "team_sjD78IkSicXJK6TAOR1JC7Wv";
export const CRM_MACHINE_PROJECT_ID = "prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I";
export const CRM_MACHINE_RESOURCE = "EVELYN_INTERNAL_CANARY_SYNTHETIC";
export const CRM_MACHINE_ROLE = "Evelyn.Service";
export const CRM_MACHINE_SUBJECT = "owner:novalure:project:evelyn:environment:production";
export const CRM_MACHINE_WORKSPACE_ID = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
export const CRM_MACHINE_MAX_TTL_SECONDS = 12 * 60 * 60;

const CLOCK_TOLERANCE_SECONDS = 30;
const jwtShape = /^eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Verifier = (
  token: string,
  options: Parameters<typeof verifyVercelOidcToken>[1],
) => Promise<Awaited<ReturnType<typeof verifyVercelOidcToken<VercelOidcPayload>>>>;

export class CrmMachineAuthError extends Error {
  constructor(public readonly code: string, public readonly status = 401) {
    super(code);
    this.name = "CrmMachineAuthError";
  }
}

export type CrmMachineClaims = Readonly<{
  audience: string;
  consumer: typeof CRM_MACHINE_CONSUMER;
  environment: typeof CRM_MACHINE_ENVIRONMENT;
  expiresAt: number;
  identityId: typeof CRM_MACHINE_IDENTITY_ID;
  issuedAt: number;
  issuer: typeof CRM_MACHINE_ISSUER;
  jti: string;
  jtiHash: string;
  keyId: string;
  notBefore: number;
  ownerId: typeof CRM_MACHINE_OWNER_ID;
  projectId: typeof CRM_MACHINE_PROJECT_ID;
  role: typeof CRM_MACHINE_ROLE;
  subject: typeof CRM_MACHINE_SUBJECT;
  workspaceId: typeof CRM_MACHINE_WORKSPACE_ID;
}>;

export type CrmMachineAuthOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  now?: Date;
  verifier?: Verifier;
}>;

function denied(code = "CRM_MACHINE_AUTH_DENIED", status = 401): never {
  throw new CrmMachineAuthError(code, status);
}

function assertRuntimeEnabled(env: NodeJS.ProcessEnv) {
  if (env.CRM_MACHINE_AUTH_ENABLED !== "1") denied("CRM_MACHINE_AUTH_DISABLED", 403);
  if (env.VERCEL_ENV !== "production") denied("CRM_MACHINE_ENVIRONMENT_DENIED", 403);
}

export function getCrmMachineBearer(headers: Pick<Headers, "get">) {
  const value = headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ")) return null;
  const token = value.slice(7);
  return jwtShape.test(token) ? token : null;
}

export function isProductionCrmMachineRuntime(env: NodeJS.ProcessEnv = process.env) {
  return env.VERCEL_ENV === "production";
}

export async function verifyCrmMachineToken(
  token: string,
  options: CrmMachineAuthOptions = {},
): Promise<CrmMachineClaims> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  assertRuntimeEnabled(env);
  if (!jwtShape.test(token)) return denied();

  const verifyOptions = {
    algorithms: ["RS256"],
    audience: CRM_MACHINE_AUDIENCE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    currentDate: now,
    environment: CRM_MACHINE_ENVIRONMENT,
    issuer: CRM_MACHINE_ISSUER,
    ownerId: CRM_MACHINE_OWNER_ID,
    projectId: CRM_MACHINE_PROJECT_ID,
    requiredClaims: ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"],
    typ: "JWT",
  };

  let verified: Awaited<ReturnType<typeof verifyVercelOidcToken<VercelOidcPayload>>>;
  try {
    verified = await (options.verifier ?? (verifyVercelOidcToken as Verifier))(token, verifyOptions);
  } catch {
    return denied();
  }

  const { payload, protectedHeader } = verified;
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  const notBefore = payload.nbf;
  const nowSeconds = Math.floor(now.valueOf() / 1000);
  if (
    protectedHeader.alg !== "RS256" ||
    protectedHeader.typ !== "JWT" ||
    typeof protectedHeader.kid !== "string" ||
    protectedHeader.kid.length < 3 ||
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number" ||
    typeof notBefore !== "number" ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(notBefore) ||
    issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    notBefore > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    expiresAt <= nowSeconds - CLOCK_TOLERANCE_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > CRM_MACHINE_MAX_TTL_SECONDS ||
    payload.iss !== CRM_MACHINE_ISSUER ||
    payload.aud !== CRM_MACHINE_AUDIENCE ||
    payload.sub !== CRM_MACHINE_SUBJECT ||
    payload.project_id !== CRM_MACHINE_PROJECT_ID ||
    payload.owner_id !== CRM_MACHINE_OWNER_ID ||
    payload.environment !== CRM_MACHINE_ENVIRONMENT ||
    typeof payload.jti !== "string" ||
    !uuidV4.test(payload.jti)
  ) return denied();

  return Object.freeze({
    audience: CRM_MACHINE_AUDIENCE,
    consumer: CRM_MACHINE_CONSUMER,
    environment: CRM_MACHINE_ENVIRONMENT,
    expiresAt,
    identityId: CRM_MACHINE_IDENTITY_ID,
    issuedAt,
    issuer: CRM_MACHINE_ISSUER,
    jti: payload.jti,
    jtiHash: createHash("sha256").update(payload.jti).digest("hex"),
    keyId: protectedHeader.kid,
    notBefore,
    ownerId: CRM_MACHINE_OWNER_ID,
    projectId: CRM_MACHINE_PROJECT_ID,
    role: CRM_MACHINE_ROLE,
    subject: CRM_MACHINE_SUBJECT,
    workspaceId: CRM_MACHINE_WORKSPACE_ID,
  });
}
