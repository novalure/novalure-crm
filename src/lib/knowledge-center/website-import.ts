import "server-only";
import { createHash } from "node:crypto";

import type { AppSession } from "../auth/session";
import { withCrmRead, type TenantTransactionOptions } from "../crm-command";
import { currentTenantTransaction } from "../db/transaction-context";
import { runKnowledgeWebsiteScan, type KnowledgeMonitoringOptions } from "./monitoring";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision, requireKnowledgePermission } from "./policy";
import { createKnowledgeSource, knowledgeInternals } from "./repository";
import type { KnowledgeSource } from "./types";
import { executeKnowledgeWorkflow } from "./workflow";

export type KnowledgeWebsiteImportResult = Readonly<{
  source: KnowledgeSource;
  websiteImport: Readonly<{
    status: "ready" | "scan_failed" | "busy" | "changes_pending" | "stale";
    errorCode?: string;
  }>;
}>;

function requireSeparateImport() {
  // The scanner's reservation must commit before DNS/network work begins.
  // A caller must not hide the entire import inside its own transaction.
  if (currentTenantTransaction()) {
    throw new KnowledgeCenterError("VALIDATION_ERROR", "Website import requires a separate command boundary.", 400);
  }
}

function initialEmpty(source: KnowledgeSource) {
  return source.type === "url" && !source.archivedAt && source.revision === 1 &&
    !source.approvedVersionId && Boolean(source.draftVersionId) &&
    source.draftVersionId === source.version?.id && source.version?.version === 1 &&
    !source.version.content.trim() && Object.keys(source.version.structuredData).length === 0 &&
    Boolean(source.version.url) && !source.version.mediaAssetId;
}

function safeErrorCode(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "WEBSITE_IMPORT_FAILED";
  return /^[a-zA-Z0-9_]{1,80}$/u.test(code) ? code : "WEBSITE_IMPORT_FAILED";
}

async function currentSource(session: AppSession, sourceId: string, options: TenantTransactionOptions) {
  return withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite");
    await knowledgeInternals.enabled(tx, fresh);
    return knowledgeInternals.source(tx, fresh, sourceId, true);
  }, options);
}

/**
 * Import only the original empty URL draft. Existing content/publications are
 * never replaced: later website scans continue to create review proposals.
 * Network/scan failures preserve the source and expose a bounded retry status.
 */
export async function importInitialKnowledgeWebsite(
  session: AppSession,
  input: { sourceId: string; expectedVersion: number },
  options: KnowledgeMonitoringOptions = {},
): Promise<KnowledgeWebsiteImportResult> {
  requireSeparateImport();
  const sourceId = knowledgeId(input.sourceId, "sourceId");
  const expectedVersion = knowledgeRevision(input.expectedVersion);
  const before = await currentSource(session, sourceId, options);
  if (before.type !== "url") throw new KnowledgeCenterError("VALIDATION_ERROR", "Only URL sources support website import.", 400);
  if (before.revision !== expectedVersion) return { source: before, websiteImport: { status: "stale", errorCode: "VERSION_CONFLICT" } };
  if (!initialEmpty(before)) return { source: before, websiteImport: { status: "changes_pending" } };

  try {
    // The unchanged scanner reserves quota and commits before the bounded,
    // DNS-pinned SSRF-safe fetch. It creates a proposal, never a publication.
    const scanned = await runKnowledgeWebsiteScan(session, { sourceId, expectedVersion }, options);
    if (scanned.busy) return { source: await currentSource(session, sourceId, options), websiteImport: { status: "busy" } };
    if (scanned.run.status === "stale") return { source: await currentSource(session, sourceId, options), websiteImport: { status: "stale", errorCode: "VERSION_CONFLICT" } };
    if (scanned.run.status !== "changed" || !("proposal" in scanned) || !scanned.proposal) {
      return { source: await currentSource(session, sourceId, options), websiteImport: { status: "changes_pending" } };
    }
    const initialProposal = scanned.proposal;

    return await withCrmRead<KnowledgeWebsiteImportResult>(session, async (tx, fresh) => {
      requireKnowledgePermission(fresh, "canWrite");
      await knowledgeInternals.lock(tx, fresh);
      const contract = await knowledgeInternals.enabled(tx, fresh);
      if (contract.features.websiteImport !== true) throw new KnowledgeCenterError("ENTITLEMENT_REQUIRED", "Website import is not enabled.", 403);
      const source = await knowledgeInternals.source(tx, fresh, sourceId, true);
      // The empty-draft assertion and normal proposal acceptance share this
      // exact transaction/lock through withCrmRead's existing async context.
      if (!initialEmpty(source) || source.revision !== before.revision || source.draftVersionId !== before.draftVersionId || source.version?.url !== before.version?.url) {
        return { source, websiteImport: { status: "stale", errorCode: "VERSION_CONFLICT" } };
      }
      const proposal = await tx.queryOne<{
        id: string; sourceId: string; versionId: string; sourceRevision: number; revision: number;
        status: string; kind: string; runId: string | null; requestedUrl: string | null; content: string | null;
        changes: Record<string, unknown>; contentHash: string | null;
      }>(`select id,source_id as "sourceId",version_id as "versionId",source_revision as "sourceRevision",revision,status,kind,
        evidence->>'runId' as "runId",evidence->>'requestedUrl' as "requestedUrl",changes->>'content' as content,
        changes,evidence->>'contentHash' as "contentHash"
        from knowledge_change_proposals where id=$1::uuid and workspace_id=$2::uuid for update`, [initialProposal.id, fresh.workspaceId]);
      const scanHash = scanned.run.contentHash;
      // A normal editor may edit an open proposal without touching the source
      // revision or its scan evidence. Never auto-accept that edited proposal:
      // only the original content-only proposal bound to this returned scan.
      if (!proposal || proposal.revision !== 1 || proposal.status !== "open" || proposal.kind !== "website_change" ||
        proposal.sourceId !== source.id || proposal.versionId !== source.draftVersionId ||
        proposal.sourceRevision !== source.revision || proposal.runId !== scanned.run.id ||
        scanned.run.proposalId !== proposal.id || proposal.requestedUrl !== source.version!.url || !proposal.content?.trim() ||
        Object.keys(proposal.changes).length !== 1 || !Object.hasOwn(proposal.changes, "content") ||
        !scanHash || !/^[a-f0-9]{64}$/u.test(scanHash) || proposal.contentHash !== scanHash ||
        createHash("sha256").update(proposal.content).digest("hex") !== scanHash) {
        return { source, websiteImport: { status: "stale", errorCode: "STALE_PROPOSAL" } };
      }
      const accepted = await executeKnowledgeWorkflow(fresh, {
        action: "proposal-accept", proposalId: proposal.id, proposalRevision: proposal.revision,
        reason: "Website-Erstimport als unveröffentlichten Entwurf angefordert.",
      }, options);
      if (!("source" in accepted) || !accepted.source || !accepted.source.version?.content.trim() || accepted.source.approvedVersionId) {
        throw new KnowledgeCenterError("WEBSITE_IMPORT_FAILED", "The website draft could not be confirmed.", 409);
      }
      return { source: accepted.source, websiteImport: { status: "ready" } };
    }, options);
  } catch (error) {
    // Never return an earlier source snapshot after membership/project access
    // was revoked. This fresh scoped read deliberately propagates such denial.
    const source = await currentSource(session, sourceId, options);
    const code = safeErrorCode(error);
    const stale = source.revision !== before.revision || source.draftVersionId !== before.draftVersionId ||
      ["VERSION_CONFLICT", "STALE_PROPOSAL", "SCAN_LEASE_LOST", "SCAN_CONTEXT_CHANGED"].includes(code);
    return { source, websiteImport: { status: stale ? "stale" : "scan_failed", errorCode: code } };
  }
}

/** A new URL entry is created once; failed reads are retried by its source ID. */
export async function createKnowledgeWebsiteImport(
  session: AppSession,
  input: { areaId: string; name: string; url: string },
  options: KnowledgeMonitoringOptions = {},
): Promise<KnowledgeWebsiteImportResult> {
  requireSeparateImport();
  await withCrmRead(session, async (tx, fresh) => {
    requireKnowledgePermission(fresh, "canWrite");
    const contract = await knowledgeInternals.enabled(tx, fresh);
    if (contract.features.websiteImport !== true) throw new KnowledgeCenterError("ENTITLEMENT_REQUIRED", "Website import is not enabled.", 403);
  }, options);
  const source = await createKnowledgeSource(session, {
    areaId: input.areaId, name: input.name, url: input.url, type: "url",
  }, options);
  return importInitialKnowledgeWebsite(session, { sourceId: source.id, expectedVersion: source.revision }, options);
}
