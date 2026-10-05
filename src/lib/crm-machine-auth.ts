import { createHash } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";

export const CRM_PRODUCTION_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const CRM_PRODUCTION_CONSUMER = "EVELYN";
export const CRM_PRODUCTION_ROLE = "Evelyn.Service";
export const CRM_PRODUCTION_ENVIRONMENT = "PRODUCTION";
export const CRM_PRODUCTION_CANARY = "EVELYN_INTERNAL_CANARY_SYNTHETIC";
export const CRM_MACHINE_MAX_TTL_SECONDS = 300;
const CLOCK_TOLERANCE_SECONDS = 30;
const machineBearer = /^Bearer\s+(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,180}$/;
const capability = /^crm\.[a-z.]{2,80}$/;

export class CrmMachineAuthError extends Error {
  constructor(public readonly code: string, public readonly status = 401) {
    super(code);
    this.name = "CrmMachineAuthError";
  }
}

export type CrmMachineClaims = Readonly<{
  audience: string;
  capabilities: readonly string[];
  consumer: "EVELYN";
  environment: "PRODUCTION";
  expiresAt: number;
  identityId: string;
  issuedAt: number;
  issuer: string;
  jti: string;
  jtiHash: string;
  keyId: string;
  role: "Evelyn.Service";
  subject: string;
  tenantId: string;
  workspaceId: string;
}>;

export type CrmMachineAuthOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  jwks?: JWTVerifyGetKey;
  now?: Date;
}>;

type MachineConfig = Readonly<{
  audience: string;
  issuer: string;
  jwksUrl: string;
}>;

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function denied(code = "CRM_MACHINE_AUTH_DENIED", status = 401): never {
  throw new CrmMachineAuthError(code, status);
}

function requiredConfig(env: NodeJS.ProcessEnv): MachineConfig {
  if (env.CRM_SERVICE_IDENTITY_PRODUCTION_ENABLED !== "1") denied("CRM_MACHINE_AUTH_DISABLED", 403);
  if (env.VERCEL_ENV !== "production") denied("CRM_MACHINE_ENVIRONMENT_DENIED", 403);
  const issuer = env.CRM_SERVICE_IDENTITY_ISSUER?.trim() ?? "";
  const audience = env.CRM_SERVICE_IDENTITY_AUDIENCE?.trim() ?? "";
  const jwksUrl = env.CRM_SERVICE_IDENTITY_JWKS_URL?.trim() ?? "";
  if (!issuer || !audience || !jwksUrl) denied("CRM_MACHINE_AUTH_CONFIG_MISSING", 503);
  let parsed: URL;
  try {
    parsed = new URL(jwksUrl);
  } catch {
    return denied("CRM_MACHINE_AUTH_CONFIG_INVALID", 503);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    denied("CRM_MACHINE_AUTH_CONFIG_INVALID", 503);
  }
  return { audience, issuer, jwksUrl: parsed.toString() };
}

function remoteKeySet(url: string) {
  const existing = remoteKeySets.get(url);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(url), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  remoteKeySets.set(url, created);
  return created;
}

function exactString(value: unknown, pattern: RegExp = identifier) {
  if (typeof value !== "string" || !pattern.test(value)) return denied();
  return value;
}

function stringAudience(value: JWTPayload["aud"]) {
  if (typeof value !== "string") return denied();
  return value;
}

function capabilities(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return denied();
  const parsed = value.map(item => exactString(item, capability));
  if (new Set(parsed).size !== parsed.length) return denied();
  return Object.freeze(parsed);
}

export function getCrmMachineBearer(headers: Pick<Headers, "get">) {
  const match = machineBearer.exec(headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export function isCrmMachineBearer(value: string | null | undefined) {
  return machineBearer.test(value ?? "");
}

export function isProductionCrmMachineRuntime(env: NodeJS.ProcessEnv = process.env) {
  return env.VERCEL_ENV === "production";
}

export async function verifyCrmMachineToken(
  token: string,
  options: CrmMachineAuthOptions = {},
): Promise<CrmMachineClaims> {
  const env = options.env ?? process.env;
  const config = requiredConfig(env);
  const now = options.now ?? new Date();
  let verified: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    verified = await jwtVerify(token, options.jwks ?? remoteKeySet(config.jwksUrl), {
      algorithms: ["RS256", "ES256"],
      audience: config.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
      issuer: config.issuer,
      requiredClaims: ["aud", "exp", "iat", "iss", "jti", "sub"],
      typ: "JWT",
    });
  } catch {
    return denied();
  }
  const { payload, protectedHeader } = verified;
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  if (typeof issuedAt !== "number" || typeof expiresAt !== "number" || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return denied();
  const nowSeconds = Math.floor(now.valueOf() / 1000);
  if (issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS || expiresAt <= issuedAt || expiresAt - issuedAt > CRM_MACHINE_MAX_TTL_SECONDS) {
    return denied();
  }
  const keyId = exactString(protectedHeader.kid);
  const identityId = exactString(payload.service_identity_id);
  const subject = exactString(payload.sub);
  const jti = exactString(payload.jti);
  const workspaceId = exactString(payload.workspace_id, /^[0-9a-f-]{36}$/i);
  const tenantId = exactString(payload.tenant_id, /^[0-9a-f-]{36}$/i);
  if (
    identityId !== "EVELYN_CRM_SERVICE_IDENTITY" ||
    payload.consumer !== CRM_PRODUCTION_CONSUMER ||
    payload.environment !== CRM_PRODUCTION_ENVIRONMENT ||
    payload.role !== CRM_PRODUCTION_ROLE ||
    workspaceId !== CRM_PRODUCTION_WORKSPACE_ID ||
    tenantId !== CRM_PRODUCTION_WORKSPACE_ID ||
    workspaceId !== tenantId
  ) return denied();
  return Object.freeze({
    audience: stringAudience(payload.aud),
    capabilities: capabilities(payload.capabilities),
    consumer: CRM_PRODUCTION_CONSUMER,
    environment: CRM_PRODUCTION_ENVIRONMENT,
    expiresAt,
    identityId,
    issuedAt,
    issuer: exactString(payload.iss),
    jti,
    jtiHash: createHash("sha256").update(jti).digest("hex"),
    keyId,
    role: CRM_PRODUCTION_ROLE,
    subject,
    tenantId,
    workspaceId,
  });
}
