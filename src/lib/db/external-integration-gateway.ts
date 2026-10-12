import "server-only";

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { queryOne, queryRows } from "@/lib/db/client";
import { consumePublicSubmissionRateLimits } from "@/lib/db/public-submission-abuse-repository";
import {
  withTenantTransaction,
  type TenantScope,
  type TenantTransaction,
} from "@/lib/db/tenant-client";
import {
  createPublicSubmissionOpaqueHash,
  getTrustedPublicSubmissionClientIp,
} from "@/lib/security/public-submission-abuse";

export const externalIntegrationCapabilities = [
  "form.read",
  "form.submit",
  "chat.start",
  "chat.message",
  "lead.create",
  "callback.request",
  "appointment.request",
] as const;

export type ExternalIntegrationCapability = typeof externalIntegrationCapabilities[number];
export type ExternalIntegrationMode = "training" | "real_customer";

export type ExternalIntegrationResolution = Readonly<{
  configuration: Record<string, unknown>;
  formId: string | null;
  integrationId: string;
  integrationMode: ExternalIntegrationMode;
  integrationType: string;
  projectId: string | null;
  publicActorId: string;
  widgetConfiguration: Record<string, unknown>;
  workspaceId: string;
}>;

type LegacyFormRouteRow = {
  form_id: string;
  slug: string;
  workspace_public_key: string;
};

const publicSiteKeyPattern = /^nov_pk_[A-Za-z0-9_-]{24,80}$/u;
const opaqueKeyPattern = /^[A-Za-z0-9_-]{32,128}$/u;
const languagePattern = /^[a-z]{2}(?:-[A-Z]{2})?$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class ExternalIntegrationError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export function normalizeExternalOrigin(value: string) {
  if (!value || value.length > 512) throw new ExternalIntegrationError("origin_denied", 403);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ExternalIntegrationError("origin_denied", 403);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
  ) {
    throw new ExternalIntegrationError("origin_denied", 403);
  }
  if (parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new ExternalIntegrationError("origin_denied", 403);
  }
  return parsed.origin;
}

export function readExternalRequestOrigin(request: Request) {
  const value = request.headers.get("origin");
  if (!value) throw new ExternalIntegrationError("origin_required", 403);
  return normalizeExternalOrigin(value);
}

/**
 * Never rate-limit a public integration with an attacker-supplied fallback.
 * Vercel or an explicitly configured trusted proxy must supply the address;
 * absence is a fail-closed infrastructure error, not an anonymous bypass.
 */
export function requireExternalIntegrationClientIp(headers: Headers) {
  const clientIp = getTrustedPublicSubmissionClientIp(headers);
  if (!clientIp) throw new ExternalIntegrationError("trusted_client_ip_unavailable", 503);
  return clientIp;
}

export function assertPublicSiteKey(value: string) {
  if (!publicSiteKeyPattern.test(value)) {
    throw new ExternalIntegrationError("integration_not_found", 404);
  }
  return value;
}

export async function resolveExternalIntegration(input: {
  capability: ExternalIntegrationCapability;
  formId?: string | null;
  origin: string;
  publicSiteKey: string;
}): Promise<ExternalIntegrationResolution | null> {
  const publicSiteKey = assertPublicSiteKey(input.publicSiteKey);
  const origin = normalizeExternalOrigin(input.origin);
  return queryOne<ExternalIntegrationResolution>(
    `select integration_id as "integrationId", workspace_id as "workspaceId",
       project_id as "projectId", form_id as "formId", public_actor_id as "publicActorId",
       integration_type as "integrationType", integration_mode as "integrationMode",
       configuration, widget_configuration as "widgetConfiguration"
     from public.crm_external_integration_resolve($1::text,$2::text,$3::text,$4::uuid)`,
    [publicSiteKey, origin, input.capability, input.formId ?? null],
  );
}

export async function legacyPublicFormLookup(
  formId: string | null,
  workspacePublicKey: string,
  slug: string,
) {
  const row = await queryOne<{ form: Record<string, unknown> | null }>(
    "select public.crm_public_form_lookup($1::uuid,$2::text,$3::text) as form",
    [formId, workspacePublicKey, slug],
  );
  return row?.form ?? null;
}

export async function legacyPublicFormRoutes(slug: string) {
  return queryRows<LegacyFormRouteRow>(
    "select * from public.crm_public_form_legacy_route($1::text)",
    [slug],
  );
}

export async function legacyPublicFormSubmissionScope(formId: string, workspacePublicKey: string) {
  if (!workspacePublicKey.trim()) return null;
  return queryOne<{ actorId: string; workspaceId: string }>(
    `select workspace_id as "workspaceId", actor_id as "actorId"
     from public.crm_public_form_scope($1::uuid,$2::text)`,
    [formId, workspacePublicKey],
  );
}

function chatSecret() {
  const secret = process.env.NOVALURE_ABUSE_SECRET?.trim();
  if (!secret || secret.length < 32) throw new ExternalIntegrationError("temporarily_unavailable", 503);
  return secret;
}

function deterministicSessionToken(integrationId: string, idempotencyKey: string) {
  return createHmac("sha256", chatSecret())
    .update(`external-chat-session-v1\n${integrationId}\n${idempotencyKey}`)
    .digest("base64url");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertOpaqueKey(value: string, code = "idempotency_key_required") {
  if (!opaqueKeyPattern.test(value)) throw new ExternalIntegrationError(code, 400);
  return value;
}

function assertLanguage(value: string) {
  if (!languagePattern.test(value)) throw new ExternalIntegrationError("invalid_language", 400);
  return value;
}

function tenantScope(resolution: ExternalIntegrationResolution): TenantScope {
  return { actorId: resolution.publicActorId, workspaceId: resolution.workspaceId };
}

async function lockExternalIntegration(
  transaction: TenantTransaction,
  expected: ExternalIntegrationResolution,
  input: {
    capability: ExternalIntegrationCapability;
    formId?: string | null;
    origin: string;
    publicSiteKey: string;
  },
) {
  const current = await transaction.queryOne<{ integrationId: string; workspaceId: string }>(
    `select integration_id as "integrationId",workspace_id as "workspaceId"
     from public.crm_external_integration_resolve($1::text,$2::text,$3::text,$4::uuid)`,
    [input.publicSiteKey, input.origin, input.capability, input.formId ?? null],
  );
  if (current?.integrationId !== expected.integrationId || current.workspaceId !== expected.workspaceId) {
    throw new ExternalIntegrationError("integration_not_found", 404);
  }
}

export async function consumeExternalIntegrationRateLimit(input: {
  clientIp: string;
  operation: "chat.context" | "chat.message" | "chat.start" | "form.read";
  resolution: ExternalIntegrationResolution;
  subject?: string;
}) {
  const limits = {
    "chat.context": { ip: 120, site: 1_000, subject: 180 },
    "chat.message": { ip: 120, site: 1_000, subject: 180 },
    "chat.start": { ip: 20, site: 100, subject: 20 },
    "form.read": { ip: 300, site: 1_000, subject: 300 },
  }[input.operation];
  const hash = (label: string, value: string) => createPublicSubmissionOpaqueHash({
    label: `external-integration-${input.operation}-${label}`,
    value: `${input.resolution.integrationId}\n${value}`,
  });
  const policies = [
    { keyHash: hash("ip", input.clientIp), limit: limits.ip, windowSeconds: 600 },
    { keyHash: hash("site", "all"), limit: limits.site, windowSeconds: 600 },
  ];
  if (input.subject) {
    policies.push({ keyHash: hash("subject", input.subject), limit: limits.subject, windowSeconds: 600 });
  }
  return consumePublicSubmissionRateLimits({ policies });
}

async function appendIntegrationEvent(
  transaction: { execute(query: string, params?: readonly unknown[]): Promise<void> },
  resolution: ExternalIntegrationResolution,
  input: {
    capability: ExternalIntegrationCapability;
    correlationId: string;
    eventType: string;
    outcome: "accepted" | "denied" | "duplicate" | "failed";
  },
) {
  await transaction.execute(
    `insert into public.external_integration_events(
       integration_id,workspace_id,project_id,event_type,outcome,capability,correlation_id
     ) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid)`,
    [
      resolution.integrationId,
      resolution.workspaceId,
      resolution.projectId,
      input.eventType,
      input.outcome,
      input.capability,
      input.correlationId,
    ],
  );
}

export async function recordExternalIntegrationEvent(
  resolution: ExternalIntegrationResolution,
  input: {
    capability: ExternalIntegrationCapability;
    correlationId: string;
    eventType: string;
    outcome: "accepted" | "denied" | "duplicate" | "failed";
  },
) {
  await withTenantTransaction(tenantScope(resolution), (transaction) =>
    appendIntegrationEvent(transaction, resolution, input));
}

export async function startExternalChatSession(input: {
  correlationId: string;
  idempotencyKey: string;
  language: string;
  origin: string;
  publicSiteKey: string;
}) {
  const idempotencyKey = assertOpaqueKey(input.idempotencyKey);
  const language = assertLanguage(input.language);
  const resolution = await resolveExternalIntegration({
    capability: "chat.start",
    origin: input.origin,
    publicSiteKey: input.publicSiteKey,
  });
  if (!resolution || resolution.widgetConfiguration.chatEnabled !== true) {
    throw new ExternalIntegrationError("integration_not_found", 404);
  }
  const token = deterministicSessionToken(resolution.integrationId, idempotencyKey);
  const tokenHash = sha256(token);
  const idempotencyHash = sha256(`${resolution.integrationId}\n${idempotencyKey}`);
  const session = await withTenantTransaction(tenantScope(resolution), async (transaction) => {
    await lockExternalIntegration(transaction, resolution, {
      capability: "chat.start",
      origin: input.origin,
      publicSiteKey: input.publicSiteKey,
    });
    const inserted = await transaction.queryOne<{ id: string }>(
      `insert into public.external_chat_sessions(
         integration_id,workspace_id,project_id,session_token_hash,idempotency_hash,
         mode,language,synthetic
       ) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)
       on conflict(integration_id,idempotency_hash) do nothing returning id`,
      [
        resolution.integrationId,
        resolution.workspaceId,
        resolution.projectId,
        tokenHash,
        idempotencyHash,
        resolution.integrationMode,
        language,
        resolution.integrationMode === "training",
      ],
    );
    const resolved = await transaction.queryOne<{ id: string; mode: ExternalIntegrationMode; status: string }>(
      `select id,mode,status from public.external_chat_sessions
       where integration_id=$1::uuid and idempotency_hash=$2 and session_token_hash=$3`,
      [resolution.integrationId, idempotencyHash, tokenHash],
    );
    await appendIntegrationEvent(transaction, resolution, {
      capability: "chat.start",
      correlationId: input.correlationId,
      eventType: "chat.session.start",
      outcome: inserted ? "accepted" : "duplicate",
    });
    return resolved;
  });
  if (!session) throw new ExternalIntegrationError("temporarily_unavailable", 503);
  return {
    mode: session.mode,
    sessionId: session.id,
    sessionToken: token,
    status: session.status,
    widget: resolution.widgetConfiguration,
  };
}

export async function appendExternalChatMessage(input: {
  correlationId: string;
  content: string;
  idempotencyKey: string;
  origin: string;
  publicSiteKey: string;
  sessionId: string;
  sessionToken: string;
}) {
  const content = input.content.normalize("NFKC").trim();
  if (!content || content.length > 8_000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(content)) {
    throw new ExternalIntegrationError("invalid_message", 400);
  }
  const idempotencyKey = assertOpaqueKey(input.idempotencyKey);
  if (!/^[0-9a-f-]{36}$/iu.test(input.sessionId) || !opaqueKeyPattern.test(input.sessionToken)) {
    throw new ExternalIntegrationError("session_denied", 403);
  }
  const resolution = await resolveExternalIntegration({
    capability: "chat.message",
    origin: input.origin,
    publicSiteKey: input.publicSiteKey,
  });
  if (!resolution) throw new ExternalIntegrationError("integration_not_found", 404);
  const tokenHash = sha256(input.sessionToken);
  const idempotencyHash = sha256(`${input.sessionId}\n${idempotencyKey}`);
  const result = await withTenantTransaction(tenantScope(resolution), async (transaction) => {
    await lockExternalIntegration(transaction, resolution, {
      capability: "chat.message",
      origin: input.origin,
      publicSiteKey: input.publicSiteKey,
    });
    const session = await transaction.queryOne<{ id: string; mode: ExternalIntegrationMode }>(
      `select id,mode from public.external_chat_sessions
       where id=$1::uuid and integration_id=$2::uuid and session_token_hash=$3 and status='active'`,
      [input.sessionId, resolution.integrationId, tokenHash],
    );
    if (!session) return null;
    const inserted = await transaction.queryOne<{ id: string }>(
      `insert into public.external_chat_messages(
         session_id,integration_id,workspace_id,role,content,idempotency_hash,synthetic
       ) values($1::uuid,$2::uuid,$3::uuid,'visitor',$4,$5,$6)
       on conflict(session_id,idempotency_hash) do nothing returning id`,
      [
        session.id,
        resolution.integrationId,
        resolution.workspaceId,
        content,
        idempotencyHash,
        session.mode === "training",
      ],
    );
    const message = await transaction.queryOne<{ createdAt: string; id: string }>(
      `select id,created_at as "createdAt" from public.external_chat_messages
       where session_id=$1::uuid and idempotency_hash=$2`,
      [session.id, idempotencyHash],
    );
    await appendIntegrationEvent(transaction, resolution, {
      capability: "chat.message",
      correlationId: input.correlationId,
      eventType: "chat.message.append",
      outcome: inserted ? "accepted" : "duplicate",
    });
    return message;
  });
  if (!result) throw new ExternalIntegrationError("session_denied", 403);
  return { accepted: true, messageId: result.id, receivedAt: result.createdAt };
}

export async function getExternalChatContext(input: {
  correlationId: string;
  origin: string;
  publicSiteKey: string;
  resolution: ExternalIntegrationResolution;
  sessionId: string;
  sessionToken: string;
}) {
  if (!uuidPattern.test(input.sessionId) || !opaqueKeyPattern.test(input.sessionToken)) {
    throw new ExternalIntegrationError("session_denied", 403);
  }
  const resolution = input.resolution;
  const result = await withTenantTransaction(tenantScope(resolution), async (transaction) => {
    await lockExternalIntegration(transaction, resolution, {
      capability: "chat.message",
      origin: input.origin,
      publicSiteKey: input.publicSiteKey,
    });
    const session = await transaction.queryOne<{ language: string; mode: ExternalIntegrationMode; status: string }>(
      `select language,mode,status from public.external_chat_sessions
       where id=$1::uuid and integration_id=$2::uuid and session_token_hash=$3`,
      [input.sessionId, resolution.integrationId, sha256(input.sessionToken)],
    );
    if (!session) return null;
    const messages = await transaction.query<{ content: string; createdAt: string; id: string; role: string }>(
      `select id,role,content,created_at as "createdAt" from public.external_chat_messages
       where session_id=$1::uuid order by created_at desc,id desc limit 20`,
      [input.sessionId],
    );
    await appendIntegrationEvent(transaction, resolution, {
      capability: "chat.message",
      correlationId: input.correlationId,
      eventType: "chat.session.context",
      outcome: "accepted",
    });
    return { ...session, messages: messages.reverse() };
  });
  if (!result) throw new ExternalIntegrationError("session_denied", 403);
  return { ...result, widget: resolution.widgetConfiguration };
}

export function createPublicSiteKey() {
  return `nov_pk_${randomBytes(24).toString("base64url")}`;
}

export function createCorrelationId() {
  return randomUUID();
}
