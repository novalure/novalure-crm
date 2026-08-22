import { randomBytes } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import type { Funnel } from "@/lib/crm-types";
import { hasDatabaseUrl, queryOne } from "@/lib/db/client";
import { buildFunnelBlueprint, type FunnelDraft, type FunnelStepDraft } from "@/lib/funnel-builder-adapter";
import { assertFunnelLivePreflight } from "@/lib/funnel-live-preflight";
import { funnelSchemaVersion, type FunnelBlueprint, type FunnelVersion } from "@/lib/funnel-schema";

export type StoredFunnel = {
  blueprint: FunnelBlueprint;
  blueprintOrigin: "persisted" | "database-draft";
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

function createPublicToken() {
  return randomBytes(24).toString("base64url");
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
    funnelId: row.id,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    source: "database",
    status: row.status,
    tracking: asObject(row.tracking),
    versions,
    updatedAt: cleanString(envelope.updatedAt) || toIso(row.updatedAt),
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

async function findFunnelRow(funnelId: string, workspaceId?: string | null) {
  const row = await findFunnelDatabaseRow(funnelId, workspaceId);

  return row ? toStoredFunnel(row) : null;
}

async function resolveProjectId(workspaceId: string, projectId: string | undefined | null) {
  if (!isUuid(projectId)) return null;

  const existing = await queryOne<{ id: string }>(
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

async function saveStoredFunnelToDatabase(blueprint: FunnelBlueprint, label: string, session?: AppSession) {
  if (!hasDatabaseUrl()) throw new Error("Funnel database is not configured");

  const workspaceId = isUuid(session?.workspaceId) ? session.workspaceId : isUuid(blueprint.workspaceId) ? blueprint.workspaceId : null;
  if (!workspaceId) throw new Error("Funnel workspace is required");

  const now = new Date().toISOString();
  const existingRow = await findFunnelDatabaseRow(blueprint.id, workspaceId);
  if (!existingRow) throw new Error("Funnel not found in database");
  const existing = existingRow ? toStoredFunnel(existingRow) : null;
  const projectId = await resolveProjectId(workspaceId, blueprint.projectId);
  if (!projectId) throw new Error("Funnel project not found in database");
  const ownerUserId = isUuid(session?.userId) ? session.userId : existing?.ownerUserId ?? null;
  const safeBlueprint = sanitizeFunnelBlueprintTracking(blueprint);
  const normalizedBlueprint: FunnelBlueprint = {
    ...safeBlueprint,
    projectId: projectId ?? safeBlueprint.projectId,
    workspaceId,
  };
  const nextVersion: FunnelVersion = {
    id: `${blueprint.id}_version_${new Date().getTime()}`,
    label,
    createdAt: now,
    blueprint: normalizedBlueprint,
  };
  const versions = [nextVersion, ...(existing?.versions ?? [])].slice(0, 25);
  const serverTracking = asObject(existingRow.tracking);
  const clientTracking = stripClientManagedTrackingSecrets(safeBlueprint.tracking);
  const publicToken =
    cleanString(serverTracking.publishToken) ||
    cleanString(serverTracking.publicToken) ||
    createPublicToken();
  const tracking = {
    ...serverTracking,
    ...clientTracking,
    consentMode: safeBlueprint.tracking.consentMode,
    publicToken,
    publishToken: publicToken,
  };
  const envelope = {
    blueprint: normalizedBlueprint,
    schemaVersion: funnelSchemaVersion,
    updatedAt: now,
    updatedByUserId: session?.userId ?? null,
    versions,
  };
  const status = safeBlueprint.status === "aktiv" || safeBlueprint.status === "optimieren" ? safeBlueprint.status : "entwurf";
  const existingId = existing?.funnelId ?? existingRow.id;
  const row = await queryOne<FunnelStoreRow>(
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
            tracking = tracking || $11::jsonb,
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
          existingId,
          workspaceId,
          projectId,
          ownerUserId,
          safeBlueprint.name,
          safeBlueprint.goal,
          safeBlueprint.audience,
          safeBlueprint.entryChannel,
          status,
          JSON.stringify(envelope),
          JSON.stringify(tracking),
        ],
      );

  return row ? toStoredFunnel(row) : null;
}

export async function getStoredFunnel(funnelId: string, workspaceId?: string | null) {
  if (!hasDatabaseUrl()) throw new Error("Funnel database is not configured");
  return findFunnelRow(funnelId, workspaceId);
}

export async function saveStoredFunnel(blueprint: FunnelBlueprint, label = "Designer-Speicherung", session?: AppSession) {
  assertFunnelLivePreflight(blueprint);
  const stored = await saveStoredFunnelToDatabase(blueprint, label, session);
  if (!stored) throw new Error("Funnel blueprint could not be saved");
  return stored;
}

export async function restoreStoredFunnelVersion(funnelId: string, versionId: string, session: AppSession) {
  const databaseStored = await getStoredFunnel(funnelId, session.workspaceId);
  const databaseVersion = databaseStored?.versions.find((item) => item.id === versionId);
  if (databaseStored && databaseVersion) {
    return saveStoredFunnel(databaseVersion.blueprint, `Restore ${databaseVersion.label}`, session);
  }
  return null;
}
