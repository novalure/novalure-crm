import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AppSession } from "@/lib/auth/session";
import { hasDatabaseUrl, queryOne } from "@/lib/db/client";
import { funnelSchemaVersion, type FunnelBlueprint, type FunnelVersion } from "@/lib/funnel-schema";

type StoredFunnel = {
  blueprint: FunnelBlueprint;
  funnelId?: string;
  ownerUserId?: string | null;
  projectId?: string | null;
  source?: "database" | "local";
  status?: string;
  tracking?: Record<string, unknown>;
  versions: FunnelVersion[];
  updatedAt: string;
  workspaceId?: string;
  workspaceName?: string;
};

type StoreShape = Record<string, StoredFunnel>;
type FunnelStoreRow = {
  audience: string;
  blueprint: unknown;
  entryChannel: string;
  goal: string;
  id: string;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  status: string;
  tracking: unknown;
  updatedAt: string | Date;
  workspaceId: string;
  workspaceName: string | null;
};

const storeDirectory = path.join(process.cwd(), ".data");
const storePath = path.join(storeDirectory, "funnels.json");
const legacyProjectNames: Record<string, string> = {
  project_wohnpark_graz: "Wohnpark Graz",
  project_investment_wien: "Investment Wien",
  project_seller_linz: "Seller Leads Linz",
  project_novalure_eu: "Novalure.eu",
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

function toStoredFunnel(row: FunnelStoreRow): StoredFunnel | null {
  const envelope = asObject(row.blueprint);
  const blueprint = isFunnelBlueprint(row.blueprint)
    ? row.blueprint
    : isFunnelBlueprint(envelope.blueprint)
      ? envelope.blueprint
      : null;

  if (!blueprint) return null;

  return {
    blueprint,
    funnelId: row.id,
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    source: "database",
    status: row.status,
    tracking: asObject(row.tracking),
    versions: Array.isArray(envelope.versions) ? envelope.versions as FunnelVersion[] : [],
    updatedAt: cleanString(envelope.updatedAt) || toIso(row.updatedAt),
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName ?? undefined,
  };
}

async function readStore(): Promise<StoreShape> {
  try {
    return JSON.parse(await readFile(storePath, "utf8")) as StoreShape;
  } catch {
    return {};
  }
}

async function writeStore(store: StoreShape) {
  await mkdir(storeDirectory, { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

async function findFunnelDatabaseRow(funnelId: string, workspaceId?: string | null) {
  if (!hasDatabaseUrl()) return null;

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
      where (
          ($1::uuid is not null and f.id = $1::uuid)
          or f.tracking->>'legacyId' = $2
        )
        and ($3::uuid is null or f.workspace_id = $3::uuid)
      order by f.updated_at desc
      limit 1
    `,
    [isUuid(funnelId) ? funnelId : null, funnelId, isUuid(workspaceId) ? workspaceId : null],
  );
}

async function findFunnelRow(funnelId: string, workspaceId?: string | null) {
  const row = await findFunnelDatabaseRow(funnelId, workspaceId);

  return row ? toStoredFunnel(row) : null;
}

async function resolveProjectId(workspaceId: string, projectId: string | undefined | null) {
  if (isUuid(projectId)) {
    const existing = await queryOne<{ id: string }>(
      `
        select id
        from projects
        where id = $1::uuid and workspace_id = $2::uuid
        limit 1
      `,
      [projectId, workspaceId],
    );

    if (existing) return existing.id;
  }

  const legacyName = projectId ? legacyProjectNames[projectId] : null;
  if (legacyName) {
    const project = await queryOne<{ id: string }>(
      `
        select id
        from projects
        where workspace_id = $1::uuid and name = $2
        limit 1
      `,
      [workspaceId, legacyName],
    );

    if (project) return project.id;
  }

  const fallback = await queryOne<{ id: string }>(
    `
      select id
      from projects
      where workspace_id = $1::uuid
      order by created_at asc
      limit 1
    `,
    [workspaceId],
  );

  return fallback?.id ?? null;
}

async function saveStoredFunnelToDatabase(blueprint: FunnelBlueprint, label: string, session?: AppSession) {
  if (!hasDatabaseUrl()) return null;

  const workspaceId = isUuid(session?.workspaceId) ? session.workspaceId : isUuid(blueprint.workspaceId) ? blueprint.workspaceId : null;
  if (!workspaceId) return null;

  const now = new Date().toISOString();
  const existingRow = await findFunnelDatabaseRow(blueprint.id, workspaceId);
  const existing = existingRow ? toStoredFunnel(existingRow) : null;
  const nextVersion: FunnelVersion = {
    id: `${blueprint.id}_version_${new Date().getTime()}`,
    label,
    createdAt: now,
    blueprint,
  };
  const versions = [nextVersion, ...(existing?.versions ?? [])].slice(0, 25);
  const projectId = await resolveProjectId(workspaceId, blueprint.projectId);
  const ownerUserId = isUuid(session?.userId) ? session.userId : existing?.ownerUserId ?? null;
  const normalizedBlueprint: FunnelBlueprint = {
    ...blueprint,
    projectId: projectId ?? blueprint.projectId,
    workspaceId,
  };
  const existingTracking = {
    ...asObject(existingRow?.tracking),
    ...asObject(existing?.tracking),
    ...asObject(blueprint.tracking),
  };
  const publicToken =
    cleanString(existingTracking.publicToken) ||
    cleanString(existingTracking.publishToken) ||
    createPublicToken();
  const tracking = {
    ...existingTracking,
    consentMode: blueprint.tracking.consentMode,
    legacyId: isUuid(blueprint.id) ? undefined : blueprint.id,
    legacyProjectId: blueprint.projectId,
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
  const status = blueprint.status === "aktiv" || blueprint.status === "optimieren" ? blueprint.status : "entwurf";
  const existingId = existing?.funnelId ?? existingRow?.id ?? null;
  const row = existingId
    ? await queryOne<FunnelStoreRow>(
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
          blueprint.name,
          blueprint.goal,
          blueprint.audience,
          blueprint.entryChannel,
          status,
          JSON.stringify(envelope),
          JSON.stringify(tracking),
        ],
      )
    : await queryOne<FunnelStoreRow>(
        `
          insert into funnels (
            id,
            workspace_id,
            project_id,
            owner_user_id,
            name,
            goal,
            audience,
            entry_channel,
            status,
            blueprint,
            tracking
          )
          values (
            coalesce($1::uuid, gen_random_uuid()),
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10::jsonb,
            $11::jsonb
          )
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
          isUuid(blueprint.id) ? blueprint.id : null,
          workspaceId,
          projectId,
          ownerUserId,
          blueprint.name,
          blueprint.goal,
          blueprint.audience,
          blueprint.entryChannel,
          status,
          JSON.stringify(envelope),
          JSON.stringify(tracking),
        ],
      );

  return row ? toStoredFunnel(row) : null;
}

export async function getStoredFunnel(funnelId: string) {
  try {
    const databaseFunnel = await findFunnelRow(funnelId);
    if (databaseFunnel) return databaseFunnel;
  } catch {
    // Local file fallback keeps the designer usable when the database is unavailable in development.
  }

  const store = await readStore();
  const stored = store[funnelId];
  return stored ? { ...stored, source: "local" as const } : null;
}

export async function saveStoredFunnel(blueprint: FunnelBlueprint, label = "Designer-Speicherung", session?: AppSession) {
  try {
    const databaseFunnel = await saveStoredFunnelToDatabase(blueprint, label, session);
    if (databaseFunnel) return databaseFunnel;
  } catch {
    // Fall through to the development file store.
  }

  const store = await readStore();
  const now = new Date().toISOString();
  const existing = store[blueprint.id];
  const nextVersion: FunnelVersion = {
    id: `${blueprint.id}_version_${new Date().getTime()}`,
    label,
    createdAt: now,
    blueprint,
  };
  const versions = [nextVersion, ...(existing?.versions ?? [])].slice(0, 25);

  store[blueprint.id] = {
    blueprint,
    source: "local",
    versions,
    updatedAt: now,
  };

  await writeStore(store);
  return store[blueprint.id];
}

export async function restoreStoredFunnelVersion(funnelId: string, versionId: string) {
  const databaseStored = await getStoredFunnel(funnelId);
  const databaseVersion = databaseStored?.versions.find((item) => item.id === versionId);
  if (databaseStored?.source === "database" && databaseVersion) {
    return saveStoredFunnel(databaseVersion.blueprint, `Restore ${databaseVersion.label}`);
  }

  const store = await readStore();
  const stored = store[funnelId];
  const version = stored?.versions.find((item) => item.id === versionId);
  if (!stored || !version) return null;

  stored.blueprint = version.blueprint;
  stored.updatedAt = new Date().toISOString();
  await writeStore(store);
  return stored;
}
