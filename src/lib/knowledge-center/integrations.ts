import "server-only";

import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, withCrmRead } from "@/lib/crm-command";
import type { PropertyUnitStatus } from "@/lib/crm-types";
import type { TenantTransactionOptions } from "@/lib/db/tenant-client";
import { requiresLivePropertyFacts } from "@/lib/bots/agent-tools";
import { queryKnowledgeCenter } from "./repository";
import { KnowledgeCenterError, knowledgeId, knowledgeText } from "./policy";
import type { KnowledgeChannel, KnowledgeQueryResult } from "./types";

export type LivePropertyFact = Readonly<{
  workspaceId: string;
  projectId: string;
  unitId: string;
  unitNumber: string;
  availability: PropertyUnitStatus;
  priceCents: number;
  version: number;
  sourceUpdatedAt: string;
  observedAt: string;
  source: "crm_live";
}>;

export type LivePropertyFactsProvider = Readonly<{
  read(session: AppSession, input: Readonly<{ projectId: string; unitIds: readonly string[] }>): Promise<readonly LivePropertyFact[]>;
}>;

/**
 * Reads the existing property inventory under refreshed membership, project grants
 * and RLS. The caller must also check the assistant's independent knowledge scope.
 * Never persist these changing facts as published static knowledge or let imported
 * prices/status override them. Missing access/data must produce no live claims.
 */
export function createCrmLivePropertyFactsProvider(options: TenantTransactionOptions = {}): LivePropertyFactsProvider {
  return {
    async read(session, input) {
      assertCrmUuid(input.projectId, "projectId");
      if (!Array.isArray(input.unitIds) || input.unitIds.length < 1 || input.unitIds.length > 100) {
        throw new Error("knowledge_live_unit_ids_invalid");
      }
      input.unitIds.forEach((id) => assertCrmUuid(id, "unitId"));
      return withCrmRead(session, async (tx, member) => {
        await assertProjectGrant(tx, member, input.projectId);
        const rows = await tx.query<{
          id: string; unit_number: string; status: PropertyUnitStatus;
          price_cents: number | string; version: number | string; updated_at: string | Date;
        }>(`select id,unit_number,status,price_cents,version,updated_at
          from property_units where workspace_id=$1::uuid and project_id=$2::uuid
          and id=any($3::uuid[]) order by id limit 100`, [member.workspaceId, input.projectId, [...new Set(input.unitIds)]]);
        const observedAt = new Date().toISOString();
        return rows.map((row) => {
          const priceCents = Number(row.price_cents), version = Number(row.version);
          if (!Number.isSafeInteger(priceCents) || priceCents < 0 || !Number.isSafeInteger(version) || version < 1 ||
            !["available", "reserved", "sold", "blocked"].includes(row.status)) {
            throw new Error("knowledge_live_property_fact_invalid");
          }
          return {
            workspaceId: member.workspaceId, projectId: input.projectId,
            unitId: row.id, unitNumber: row.unit_number, availability: row.status,
            priceCents, version, sourceUpdatedAt: new Date(row.updated_at).toISOString(),
            observedAt, source: "crm_live" as const,
          };
        });
      }, options);
    },
  };
}

/** Both adapters use the same approved-version index and exact channel grants. */
export type AssistantKnowledgeRequest = Readonly<{
  assistantId: string;
  channel: "webchat" | "telephony";
  query: string;
  maxResults: number;
}>;
export type AssistantKnowledgeContext = Readonly<{
  answerStatus: "grounded" | "insufficient_knowledge";
  fallback: string | null;
  excerpts: readonly Readonly<{
    text: string;
    sourceId: string;
    versionId: string;
    citation: string;
    trust: "retrieved_knowledge_data";
  }>[];
}>;

export const assistantKnowledgeLimits = Object.freeze({
  queryCharacters: 2000,
  maxResults: 5,
  voiceResults: 3,
  excerptCharacters: 600,
  totalExcerptCharacters: 1800,
  statementTimeoutMs: 1500,
  deadlineMs: 2000,
});
export const assistantKnowledgeFallback = "Dazu liegen mir keine freigegebenen Informationen vor. Bitte wenden Sie sich an das zuständige Team.";
const savedChannels = new Set<string>(["webchat", "whatsapp", "instagram", "messenger", "email", "internal", "voice", "telephone"]);

function emptyKnowledge(): KnowledgeQueryResult {
  return { grounded: false, matches: [], usage: { sources: 0, storageBytes: 0, queriesThisMonth: 0 } };
}

/**
 * Server-only retrieval. The caller supplies a verified session and a saved
 * assistant/channel binding, never model-selected tenant or area identifiers.
 * Every request refreshes membership, project rights, entitlement, published
 * version and grants in the repository. No cache outlives a revocation.
 */
export async function retrieveKnowledgeForSavedChannel(
  session: AppSession,
  input: Readonly<{ assistantId: string; channel: KnowledgeChannel; query: string; maxResults?: number }>,
  options: TenantTransactionOptions = {},
): Promise<KnowledgeQueryResult> {
  knowledgeId(input.assistantId, "assistantId");
  const query = knowledgeText(input.query, "query", assistantKnowledgeLimits.queryCharacters);
  if (!savedChannels.has(input.channel)) throw new KnowledgeCenterError("VALIDATION_ERROR", "An exact saved channel is required.");
  const requested = input.maxResults ?? 5;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > assistantKnowledgeLimits.maxResults) {
    throw new KnowledgeCenterError("VALIDATION_ERROR", "maxResults must be between 1 and 5.");
  }
  const started = Date.now();
  try {
    // Even live-fact questions pass the same authorization checks. Static
    // brochures must never answer current price or inventory questions.
    const result = await queryKnowledgeCenter(session, {
      botId: input.assistantId, channel: input.channel, query,
      limit: Math.min(requested, input.channel === "voice" ? assistantKnowledgeLimits.voiceResults : requested),
    }, { ...options, statementTimeoutMs: Math.min(options.statementTimeoutMs ?? assistantKnowledgeLimits.statementTimeoutMs, assistantKnowledgeLimits.statementTimeoutMs) });
    if (Date.now() - started > assistantKnowledgeLimits.deadlineMs || requiresLivePropertyFacts(query)) return { ...result, grounded: false, matches: [] };
    let remaining = assistantKnowledgeLimits.totalExcerptCharacters;
    const matches: KnowledgeQueryResult["matches"] = [];
    for (const match of result.matches) {
      if (requiresLivePropertyFacts(match.excerpt) || remaining <= 0) continue;
      const excerpt = match.excerpt.slice(0, Math.min(assistantKnowledgeLimits.excerptCharacters, remaining));
      if (!excerpt.trim()) continue;
      remaining -= excerpt.length;
      matches.push({ ...match, excerpt });
    }
    return { ...result, matches, grounded: matches.length > 0 };
  } catch (error) {
    if (error instanceof KnowledgeCenterError && ["ENTITLEMENT_REQUIRED", "LIMIT_EXCEEDED"].includes(error.code)) return emptyKnowledge();
    if (error && typeof error === "object" && "code" in error && ["57014", "55P03"].includes(String(error.code))) return emptyKnowledge();
    throw error;
  }
}

export async function retrieveAssistantKnowledge(
  session: AppSession,
  input: AssistantKnowledgeRequest,
  options: TenantTransactionOptions = {},
): Promise<AssistantKnowledgeContext> {
  if (input.channel !== "webchat" && input.channel !== "telephony") throw new KnowledgeCenterError("VALIDATION_ERROR", "Invalid assistant channel.");
  // The provider-facing term telephony has one canonical saved grant: voice.
  // A historical telephone grant never implicitly grants voice access.
  const result = await retrieveKnowledgeForSavedChannel(session, {
    ...input, channel: input.channel === "telephony" ? "voice" : "webchat",
  }, options);
  return {
    answerStatus: result.grounded ? "grounded" : "insufficient_knowledge",
    fallback: result.grounded ? null : assistantKnowledgeFallback,
    excerpts: result.matches.map(match => ({
      text: match.excerpt, sourceId: match.sourceId, versionId: match.versionId,
      citation: match.title, trust: "retrieved_knowledge_data" as const,
    })),
  };
}

export function createAssistantKnowledgePort(options: TenantTransactionOptions = {}): AssistantKnowledgePort {
  return { retrieve: (session, input) => retrieveAssistantKnowledge(session, input, options) };
}
export type AssistantKnowledgePort = Readonly<{
  retrieve(session: AppSession, input: AssistantKnowledgeRequest): Promise<AssistantKnowledgeContext>;
}>;

/** No provider client, call action, phone number purchase or credential is created. */
export const preparedTelephonyKnowledgeIntegration = Object.freeze({
  provider: "vapi" as const,
  status: "not_connected" as const,
  contractVersion: "1" as const,
  channel: "telephony" as const,
  requiresIndependentAssignment: true,
  acceptsPublishedKnowledgeOnly: true,
  outboundActionsEnabled: false,
});
