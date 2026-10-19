import "server-only";

import type { AppSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, withCrmRead } from "@/lib/crm-command";
import type { PropertyUnitStatus } from "@/lib/crm-types";
import type { TenantTransactionOptions } from "@/lib/db/tenant-client";

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

/** Shared contract only. Each channel must independently authorize its assignment. */
export type AssistantKnowledgeRequest = Readonly<{
  assistantId: string;
  channel: "webchat" | "telephony";
  query: string;
  maxResults: number;
}>;
export type AssistantKnowledgeContext = Readonly<{
  answerStatus: "grounded" | "insufficient_knowledge";
  excerpts: readonly Readonly<{
    text: string;
    sourceId: string;
    versionId: string;
    citation: string;
    trust: "retrieved_knowledge_data";
  }>[];
}>;
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
