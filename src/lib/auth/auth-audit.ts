import { getAuthRequestFingerprint } from "@/lib/auth/auth-security";
import { queryOne } from "@/lib/db/client";

type AuthAuditMetadata = Record<string, boolean | number | string | null>;

const prohibitedMetadataKey = /(code|cookie|email|password|secret|token)/i;

export function sanitizeAuthAuditMetadata(input: Record<string, unknown> | undefined) {
  const sanitized: AuthAuditMetadata = {};

  for (const [key, value] of Object.entries(input ?? {})) {
    if (prohibitedMetadataKey.test(key)) continue;
    if (typeof value === "boolean" || typeof value === "number" || value === null) {
      sanitized[key] = value;
    } else if (typeof value === "string") {
      sanitized[key] = value.slice(0, 256);
    }
  }

  return sanitized;
}

export async function writeAuthAuditEvent(input: {
  authIdentityId?: string | null;
  eventType: string;
  metadata?: Record<string, unknown>;
  outcome: "blocked" | "failure" | "success";
  request?: Request | null;
  sessionId?: string | null;
  workspaceId?: string | null;
  workspaceUserId?: string | null;
}) {
  const fingerprint = input.request
    ? getAuthRequestFingerprint(input.request)
    : { ipHash: null, userAgentHash: null };
  const row = await queryOne<{ id: string }>(
    `
      insert into auth_audit_events (
        event_type,
        outcome,
        auth_identity_id,
        workspace_user_id,
        workspace_id,
        session_id,
        ip_hash,
        user_agent_hash,
        metadata
      )
      values ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::jsonb)
      returning id
    `,
    [
      input.eventType,
      input.outcome,
      input.authIdentityId ?? null,
      input.workspaceUserId ?? null,
      input.workspaceId ?? null,
      input.sessionId ?? null,
      fingerprint.ipHash,
      fingerprint.userAgentHash,
      JSON.stringify(sanitizeAuthAuditMetadata(input.metadata)),
    ],
  );

  if (!row) throw new Error("Authentication audit event was not persisted");
  return row.id;
}
