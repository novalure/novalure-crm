import "server-only";

import type { AppSession } from "@/lib/auth/session";
import type { Funnel } from "@/lib/crm-types";
import { hasDatabaseUrl, queryOne } from "@/lib/db/client";
import {
  withTenantTransaction,
  type TenantTransaction,
} from "@/lib/db/tenant-client";
import { writeAuditLog } from "@/lib/db/runtime-repositories";
import { buildFunnelBlueprint, type FunnelDraft, type FunnelStepDraft } from "@/lib/funnel-builder-adapter";
import { assertFunnelLivePreflight } from "@/lib/funnel-live-preflight";
import { funnelSchemaVersion, type FunnelBlueprint, type FunnelVersion } from "@/lib/funnel-schema";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export type StoredFunnel = {
  blueprint: FunnelBlueprint;
  blueprintOrigin: "persisted" | "database-draft";
  blueprintRevision: number;
  funnelId?: string;
  ownerUserId?: string | null;
  projectId?: string | null;
  source: "database";
  status?: string;
  tracking?: Record<string, unknown>;
  versions: FunnelVersion[];
  updatedAt: string;
  workspaceId?: string;
  workspaceName?: string;
};

type FunnelStoreRow = {
  audience: Funnel["audience"];
  blueprint: unknown;
  entryChannel: Funnel["entryChannel"];
  goal: string;
  id: string;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  status: Funnel["status"];
  tracking: unknown;
  updatedAt: string | Date;
  workspaceId: string;
  workspaceName: string | null;
};

function isUuid(value: string | undefined | null): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stripClientManagedTrackingSecrets(value: unknown) {
  const tracking = { ...asObject(value) };
  delete tracking.publicToken;
  delete tracking.publishToken;
  delete tracking.publicationRevision;
  delete tracking.publicationRotationRequestHash;
  return tracking;
}

function sanitizeFunnelBlueprintTracking(blueprint: FunnelBlueprint): FunnelBlueprint {
  return {
    ...blueprint,
    tracking: stripClientManagedTrackingSecrets(blueprint.tracking) as FunnelBlueprint["tracking"],
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readBlueprintRevision(value: unknown) {
  const candidate = asObject(value).blueprintRevision;
  const revision = typeof candidate === "number" ? candidate : Number(candidate);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function toIso(value: string | Date | null | undefined) {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : String(value);
}

function isFunnelBlueprint(value: unknown): value is FunnelBlueprint {
  const candidate = asObject(value);

  return (
    candidate.schemaVersion === funnelSchemaVersion &&
    typeof candidate.id === "string" &&
    Array.isArray(candidate.pages) &&
    Boolean(candidate.tracking) &&
    Boolean(candidate.crmHandover)
  );
}

function buildDatabaseDraftBlueprint(row: FunnelStoreRow, envelope: Record<string, unknown>) {
  const rawFunnel = asObject(envelope.funnel);
  const projectId = row.projectId ?? cleanString(rawFunnel.projectId);
  if (!Object.keys(rawFunnel).length || !projectId) return null;

  const funnel: FunnelDraft = {
    ...(rawFunnel as FunnelDraft),
    audience: row.audience,
    entryChannel: row.entryChannel,
    goal: row.goal,
    id: row.id,
    name: row.name,
    projectId,
    status: row.status,
    workspaceId: row.workspaceId,
  };
  const steps = Array.isArray(envelope.steps)
    ? envelope.steps
        .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === "object" && !Array.isArray(step))
        .map((step) => ({
          ...(step as FunnelStepDraft),
          funnelId: row.id,
          projectId,
          workspaceId: row.workspaceId,
        }))
    : [];

  return buildFunnelBlueprint({ funnel, steps });
}

function toStoredFunnel(row: FunnelStoreRow): StoredFunnel | null {
  const envelope = asObject(row.blueprint);
  const persistedBlueprint = isFunnelBlueprint(row.blueprint)
    ? row.blueprint
    : isFunnelBlueprint(envelope.blueprint)
      ? envelope.blueprint
      : null;
  const rawBlueprint = persistedBlueprint ?? buildDatabaseDraftBlueprint(row, envelope);

  if (!rawBlueprint) return null;
  const blueprint = sanitizeFunnelBlueprintTracking(rawBlueprint);
  const versions = Array.isArray(envelope.versions)
    ? (envelope.versions as FunnelVersion[]).map((version) => ({
        ...version,
        blueprint: sanitizeFunnelBlueprintTracking(version.blueprint),
      }))
    : [];

  return {
    blueprint,
    blueprintOrigin: persistedBlueprint ? "persisted" : "database-draft",
    blueprintRevision: readBlueprintRevision(row.tracking),
    funnelId: row.id,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    source: "database",
    status: row.status,
    tracking: asObject(row.tracking),
    versions,
    // The relational row timestamp is the one and only optimistic-lock token.
    // Envelope timestamps may come from older CRM/editor payloads and are not
    // guaranteed to equal PostgreSQL's authoritative updated_at value.
    updatedAt: toIso(row.updatedAt),
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName ?? undefined,
  };
}

async function findFunnelDatabaseRow(funnelId: string, workspaceId?: string | null) {
  if (!hasDatabaseUrl()) return null;
  if (!isUuid(funnelId)) return null;
  if (workspaceId != null && !isUuid(workspaceId)) return null;

  return queryOne<FunnelStoreRow>(
    `
      select
        f.id,
        f.workspace_id as "workspaceId",
        w.name as "workspaceName",
        f.project_id as "projectId",
        f.owner_user_id as "ownerUserId",
        f.name,
        f.goal,
        f.audience,
        f.entry_channel as "entryChannel",
        f.status,
        f.blueprint,
        f.tracking,
        f.updated_at as "updatedAt"
      from funnels f
      join workspaces w on w.id = f.workspace_id
      where f.id = $1::uuid
        and ($2::uuid is null or f.workspace_id = $2::uuid)
      order by f.updated_at desc
      limit 1
    `,
    [funnelId, workspaceId ?? null],
  );
}

async function findFunnelDatabaseRowInTransaction(
  transaction: TenantTransaction,
  funnelId: string,
  workspaceId: string,
) {
  return transaction.queryOne<FunnelStoreRow>(
    `
      select
        f.id,
        f.workspace_id as "workspaceId",
        w.name as "workspaceName",
        f.project_id as "projectId",
        f.owner_user_id as "ownerUserId",
        f.name,
        f.goal,
        f.audience,
        f.entry_channel as "entryChannel",
        f.status,
        f.blueprint,
        f.tracking,
        f.updated_at as "updatedAt"
      from funnels f
      join workspaces w on w.id = f.workspace_id
      where f.id = $1::uuid
        and f.workspace_id = $2::uuid
      for update of f
    `,
    [funnelId, workspaceId],
  );
}

async function findFunnelRow(funnelId: string, workspaceId?: string | null) {
  const row = await findFunnelDatabaseRow(funnelId, workspaceId);

  return row ? toStoredFunnel(row) : null;
}

async function resolveProjectIdInTransaction(
  transaction: TenantTransaction,
  workspaceId: string,
  projectId: string | undefined | null,
) {
  if (!isUuid(projectId)) return null;

  const existing = await transaction.queryOne<{ id: string }>(
    `
      select id
      from projects
      where id = $1::uuid and workspace_id = $2::uuid
      limit 1
    `,
    [projectId, workspaceId],
  );

  return existing?.id ?? null;
}

async function saveStoredFunnelToDatabase(
  blueprint: FunnelBlueprint,
  label: string,
  session: AppSession | undefined,
  expectedBlueprintRevision: number,
  auditAction: "funnel.blueprint_saved" | "funnel.version_restored",
) {
  if (!evaluateLaunchScope("publicFunnelPublication").allowed) {
    throw new Error("Public funnel publication is launch-off");
  }
  if (!hasDatabaseUrl()) throw new Error("Funnel database is not configured");

  const workspaceId = isUuid(session?.workspaceId) ? session.workspaceId : isUuid(blueprint.workspaceId) ? blueprint.workspaceId : null;
  if (!workspaceId) throw new Error("Funnel workspace is required");
  if (!isUuid(session?.userId)) throw new Error("Authenticated funnel actor is required");

  return withTenantTransaction(
    { actorId: session.userId, workspaceId },
    async (transaction) => {
      // The funnel row is locked before deriving any state. Publication credentials
      // remain database-authoritative and are never copied into a normal save payload.
      const existingRow = await findFunnelDatabaseRowInTransaction(
        transaction,
        blueprint.id,
        workspaceId,
      );
      if (!existingRow) throw new Error("Funnel not found in database");
      if (
        !Number.isSafeInteger(expectedBlueprintRevision) ||
        expectedBlueprintRevision < 0 ||
        expectedBlueprintRevision !== readBlueprintRevision(existingRow.tracking)
      ) {
        throw new Error("Concurrent funnel blueprint update conflict");
      }
      const existing = toStoredFunnel(existingRow);
      const projectId = await resolveProjectIdInTransaction(
        transaction,
        workspaceId,
        blueprint.projectId,
      );
      if (!projectId) throw new Error("Funnel project not found in database");

      const now = new Date().toISOString();
      const safeBlueprint = sanitizeFunnelBlueprintTracking(blueprint);
      const normalizedBlueprint: FunnelBlueprint = {
        ...safeBlueprint,
        projectId,
        workspaceId,
      };
      const nextVersion: FunnelVersion = {
        id: `${blueprint.id}_version_${new Date().getTime()}`,
        label,
        createdAt: now,
        blueprint: normalizedBlueprint,
      };
      const versions = [nextVersion, ...(existing?.versions ?? [])].slice(0, 25);
      const clientTracking = stripClientManagedTrackingSecrets(safeBlueprint.tracking);
      const tracking = {
        ...clientTracking,
        consentMode: safeBlueprint.tracking.consentMode,
      };
      const envelope = {
        blueprint: normalizedBlueprint,
        schemaVersion: funnelSchemaVersion,
        updatedByUserId: session.userId,
        versions,
      };
      const status = safeBlueprint.status === "aktiv" || safeBlueprint.status === "optimieren" ? safeBlueprint.status : "entwurf";
      const row = await transaction.queryOne<FunnelStoreRow>(
        `
          update funnels
          set
            project_id = $3::uuid,
            owner_user_id = $4::uuid,
            name = $5,
            goal = $6,
            audience = $7,
            entry_channel = $8,
            status = $9,
            blueprint = $10::jsonb,
            tracking = tracking || $11::jsonb || jsonb_build_object(
              'blueprintRevision',
              coalesce(
                case
                  when jsonb_typeof(tracking->'blueprintRevision') = 'number'
                    then (tracking->>'blueprintRevision')::bigint
                  else null
                end,
                0
              ) + 1,
              'publicationRevision',
              coalesce(
                case
                  when jsonb_typeof(tracking->'publicationRevision') = 'number'
                    then (tracking->>'publicationRevision')::bigint
                  else null
                end,
                0
              ) + 1
            ),
            updated_at = now()
          where id = $1::uuid and workspace_id = $2::uuid
          returning
            id,
            workspace_id as "workspaceId",
            (select name from workspaces where id = funnels.workspace_id) as "workspaceName",
            project_id as "projectId",
            owner_user_id as "ownerUserId",
            name,
            goal,
            audience,
            entry_channel as "entryChannel",
            status,
            blueprint,
            tracking,
            updated_at as "updatedAt"
        `,
        [
          existingRow.id,
          workspaceId,
          projectId,
          session.userId,
          safeBlueprint.name,
          safeBlueprint.goal,
          safeBlueprint.audience,
          safeBlueprint.entryChannel,
          status,
          JSON.stringify(envelope),
          JSON.stringify(tracking),
        ],
      );

      const stored = row ? toStoredFunnel(row) : null;
      if (!stored) throw new Error("Funnel blueprint update failed");
      await writeAuditLog({
        action: auditAction,
        after: {
          blueprintRevision: stored.blueprintRevision,
          projectId: stored.projectId ?? null,
          status: stored.status ?? null,
        },
        before: {
          blueprintRevision: existing?.blueprintRevision ?? readBlueprintRevision(existingRow.tracking),
          projectId: existingRow.projectId,
          status: existingRow.status,
        },
        entityId: stored.funnelId,
        entityType: "funnel",
        projectId: stored.projectId,
        session,
        transaction,
      });
      return stored;
    },
  );
}

export async function getStoredFunnel(funnelId: string, workspaceId?: string | null) {
  if (!hasDatabaseUrl()) throw new Error("Funnel database is not configured");
  return findFunnelRow(funnelId, workspaceId);
}

export async function saveStoredFunnel(
  blueprint: FunnelBlueprint,
  label: string | undefined,
  session: AppSession | undefined,
  expectedBlueprintRevision: number,
  auditAction: "funnel.blueprint_saved" | "funnel.version_restored" = "funnel.blueprint_saved",
) {
  assertFunnelLivePreflight(blueprint);
  const stored = await saveStoredFunnelToDatabase(
    blueprint,
    label ?? "Designer-Speicherung",
    session,
    expectedBlueprintRevision,
    auditAction,
  );
  if (!stored) throw new Error("Funnel blueprint could not be saved");
  return stored;
}

export async function restoreStoredFunnelVersion(
  funnelId: string,
  versionId: string,
  session: AppSession,
  expectedBlueprintRevision: number,
) {
  const databaseStored = await getStoredFunnel(funnelId, session.workspaceId);
  const databaseVersion = databaseStored?.versions.find((item) => item.id === versionId);
  if (databaseStored && databaseVersion) {
    return saveStoredFunnel(
      databaseVersion.blueprint,
      `Restore ${databaseVersion.label}`,
      session,
      expectedBlueprintRevision,
      "funnel.version_restored",
    );
  }
  return null;
}
