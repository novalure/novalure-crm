import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, get, put } from "@vercel/blob";
import { executeQuery, hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import {
  createMediaShareToken,
  hasExpectedMediaMagicBytes,
  hashMediaShareToken,
  mediaPublicShareScope,
} from "@/lib/media-security";

export const maxImageUploadBytes = 10 * 1024 * 1024;
export const maxMediaUploadBytes = maxImageUploadBytes;
export const workspaceImageQuotaBytes = 1024 * 1024 * 1024;

export type MediaStorageAccess = "legacy-public" | "private" | "published-public";

export type MediaAsset = {
  id: string;
  workspaceId: string;
  name: string;
  originalName: string;
  folder: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  relativePath: string;
  storageProvider: "local" | "vercel-blob";
  storageAccess: MediaStorageAccess;
  alt?: string;
  createdAt: string;
  hasActivePublicShare: boolean;
  isPublic: boolean;
  publicToken?: string | null;
  publicUrl?: string | null;
  publicShareExpiresAt?: string | null;
  publicShareId?: string | null;
};

export type MediaAssetClient = {
  accessClass: MediaStorageAccess;
  alt?: string;
  createdAt: string;
  folder: string;
  hasActivePublicShare: boolean;
  id: string;
  isPublic: boolean;
  mimeType: string;
  name: string;
  originalName: string;
  publicUrl: string | null;
  sizeBytes: number;
  url: string;
};

type MediaShareRecord = {
  assetId: string;
  createdAt: string;
  expiresAt: string;
  id: string;
  revokedAt: string | null;
  scope: string;
  tokenHash: string;
  workspaceId: string;
};

export type MediaPublicationOptions = {
  expiresInSeconds?: number;
};

export const botDocumentAttemptShareTtlSeconds = 5 * 60;
export const botDocumentMediaShareTtlSeconds = 24 * 60 * 60;

type MediaLibrary = {
  assets: MediaAsset[];
  shares: MediaShareRecord[];
};

type MediaAssetRow = Record<string, unknown> & {
  alt?: string | null;
  createdAt: string | Date;
  folder: string;
  hasActivePublicShare?: boolean | null;
  id: string;
  isPublic?: boolean | null;
  mimeType: string;
  name: string;
  originalName: string;
  publicShareExpiresAt?: string | Date | null;
  publicShareId?: string | null;
  publicToken?: string | null;
  relativePath: string;
  sizeBytes: number | string;
  storageAccess?: MediaStorageAccess | null;
  storageProvider: "local" | "vercel-blob";
  url: string;
  workspaceId: string;
};

const allowedExtensionsByMimeType = new Map<string, Set<string>>([
  ["application/msword", new Set([".doc"])],
  ["application/pdf", new Set([".pdf"])],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Set([".docx"])],
  ["image/avif", new Set([".avif"])],
  ["image/gif", new Set([".gif"])],
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/png", new Set([".png"])],
  ["image/webp", new Set([".webp"])],
]);
const allowedImageMimeTypes = new Set([...allowedExtensionsByMimeType.keys()].filter((value) => value.startsWith("image/")));
const allowedMediaMimeTypes = new Set(allowedExtensionsByMimeType.keys());
const mediaRoot = process.env.NOVALURE_MEDIA_ROOT || path.join(process.cwd(), ".data", "media");
const uploadRoot = path.join(mediaRoot, "uploads");
const libraryPath = path.join(mediaRoot, "library.json");

function mediaAssetSelect(alias = "ma", includeShareStatus = true) {
  return `
    ${alias}.id,
    ${alias}.workspace_id as "workspaceId",
    ${alias}.name,
    ${alias}.original_name as "originalName",
    ${alias}.folder,
    ${alias}.mime_type as "mimeType",
    ${alias}.size_bytes as "sizeBytes",
    ${alias}.url,
    ${alias}.relative_path as "relativePath",
    ${alias}.storage_provider as "storageProvider",
    ${alias}.storage_access as "storageAccess",
    ${alias}.alt,
    ${alias}.created_at as "createdAt",
    ${alias}.is_public as "isPublic"${includeShareStatus ? `,
    exists (
      select 1
      from media_asset_shares active_share
      where active_share.asset_id = ${alias}.id
        and active_share.workspace_id = ${alias}.workspace_id
        and active_share.scope = '${mediaPublicShareScope}'
        and active_share.revoked_at is null
        and active_share.expires_at > now()
    ) as "hasActivePublicShare"` : ""}
  `;
}

export function isAllowedImage(file: File) {
  return allowedImageMimeTypes.has(file.type.toLowerCase()) && hasAllowedExtension(file);
}

export function isAllowedMediaFile(file: File) {
  return allowedMediaMimeTypes.has(file.type.toLowerCase()) && hasAllowedExtension(file);
}

function hasAllowedExtension(file: File) {
  const extensions = allowedExtensionsByMimeType.get(file.type.toLowerCase());
  return Boolean(extensions?.has(path.extname(file.name).toLowerCase()));
}

export function getMediaUsage(assets: MediaAsset[], workspaceId: string) {
  return assets
    .filter((asset) => asset.workspaceId === workspaceId)
    .reduce((total, asset) => total + Number(asset.sizeBytes || 0), 0);
}

export async function listWorkspaceMedia(workspaceId: string) {
  const assets = await readWorkspaceAssets(workspaceId);
  const usedBytes = getMediaUsage(assets, workspaceId);

  return {
    assets,
    quota: {
      limitBytes: workspaceImageQuotaBytes,
      maxFileBytes: maxImageUploadBytes,
      remainingBytes: Math.max(0, workspaceImageQuotaBytes - usedBytes),
      usedBytes,
    },
  };
}

export async function saveWorkspaceImage(input: {
  alt?: string;
  file: File;
  folder?: string;
  name?: string;
  workspaceId: string;
}) {
  if (!isAllowedImage(input.file)) {
    throw new MediaStoreError("UNSUPPORTED_IMAGE_TYPE", "Only JPG, PNG, WebP, GIF and AVIF images are supported.");
  }

  return saveWorkspaceFile(input);
}

export async function saveWorkspaceFile(input: {
  alt?: string;
  file: File;
  folder?: string;
  name?: string;
  workspaceId: string;
}) {
  const sizeBytes = input.file.size;

  if (!isAllowedMediaFile(input.file)) {
    throw new MediaStoreError("UNSUPPORTED_FILE_TYPE", "Only images, PDF, DOC and DOCX files are supported.");
  }

  if (sizeBytes > maxMediaUploadBytes) {
    throw new MediaStoreError("FILE_TOO_LARGE", "Files must be 10 MB or smaller.");
  }

  const signatureBytes = new Uint8Array(await input.file.slice(0, 64).arrayBuffer());
  if (!hasExpectedMediaMagicBytes(signatureBytes, input.file.type)) {
    throw new MediaStoreError("FILE_CONTENT_MISMATCH", "The file content does not match its declared media type.");
  }

  const existingAssets = await readWorkspaceAssets(input.workspaceId);
  const usedBytes = getMediaUsage(existingAssets, input.workspaceId);
  if (usedBytes + sizeBytes > workspaceImageQuotaBytes) {
    throw new MediaStoreError("WORKSPACE_QUOTA_EXCEEDED", "This account has reached the 1 GB image storage limit.");
  }

  const id = randomUUID();
  const folder = input.folder?.trim() || "media-uploads";
  const extension = path.extname(input.file.name).toLowerCase();
  const workspaceSegment = sanitizeSegment(input.workspaceId);
  const folderSegment = sanitizeSegment(folder);
  const fileName = `${new Date().getTime()}-${sanitizeSegment(path.basename(input.file.name, extension))}-${id.slice(0, 8)}${extension}`;
  const relativePath = path.posix.join(workspaceSegment, folderSegment, fileName);
  const stored = await storeMediaFile(input.file, relativePath);

  const asset: MediaAsset = {
    id,
    workspaceId: input.workspaceId,
    name: input.name?.trim() || input.file.name,
    originalName: input.file.name,
    folder,
    mimeType: input.file.type.toLowerCase(),
    sizeBytes,
    url: protectedMediaPath(id),
    relativePath: stored.relativePath,
    storageProvider: stored.storageProvider,
    storageAccess: stored.storageAccess,
    alt: input.alt?.trim() || input.name?.trim() || input.file.name,
    createdAt: new Date().toISOString(),
    hasActivePublicShare: false,
    isPublic: false,
    publicToken: null,
    publicUrl: null,
  };

  try {
    await persistMediaAsset(asset);
  } catch (error) {
    await deleteStoredFile(asset).catch(() => undefined);
    throw error;
  }

  return asset;
}

export async function findPublicMediaAsset(publicToken: string) {
  const token = publicToken.trim();
  if (!token || token.length > 512) return null;
  const tokenHash = hashMediaShareToken(token);

  if (hasDatabaseUrl()) {
    const row = await queryOne<MediaAssetRow>(
      `
        select ${mediaAssetSelect()}
        from media_asset_shares mas
        join media_assets ma
          on ma.id = mas.asset_id
         and ma.workspace_id = mas.workspace_id
        where mas.token_hash = $1
          and mas.scope = $2
          and mas.revoked_at is null
          and mas.expires_at > now()
          and ma.is_public = true
        limit 1
      `,
      [tokenHash, mediaPublicShareScope],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  const share = library.shares.find((item) => isActiveShare(item) && item.tokenHash === tokenHash && item.scope === mediaPublicShareScope);
  return share ? library.assets.find((asset) => asset.id === share.assetId && asset.workspaceId === share.workspaceId && asset.isPublic) ?? null : null;
}

export async function findWorkspaceMediaAsset(assetId: string, workspaceId: string) {
  if (hasDatabaseUrl()) {
    const row = await queryOne<MediaAssetRow>(
      `select ${mediaAssetSelect()} from media_assets ma where ma.id = $1 and ma.workspace_id = $2 limit 1`,
      [assetId, workspaceId],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  return library.assets.find((asset) => asset.id === assetId && asset.workspaceId === workspaceId) ?? null;
}

export async function publishWorkspaceMedia(
  assetId: string,
  workspaceId: string,
  options: MediaPublicationOptions = {},
) {
  const existingAsset = await findWorkspaceMediaAsset(assetId, workspaceId);
  if (!existingAsset) return null;
  storagePathname(existingAsset);
  assertBlobAccessConfigured(existingAsset);

  const token = createMediaShareToken();
  const tokenHash = hashMediaShareToken(token);
  const expiresAt = new Date(Date.now() + getMediaShareTtlSeconds(options.expiresInSeconds) * 1000).toISOString();

  if (hasDatabaseUrl()) {
    const row = await queryOne<MediaAssetRow>(
      `
        with published_asset as (
          update media_assets
          set is_public = true,
              public_token = null,
              storage_access = case
                when storage_access = 'legacy-public' then 'published-public'
                else storage_access
              end
          where id = $1
            and workspace_id = $2
          returning *
        ), created_share as (
          insert into media_asset_shares (
            asset_id, workspace_id, token_hash, scope, expires_at
          )
          select id, workspace_id, $3, $4, $5::timestamptz
          from published_asset
          returning asset_id, expires_at as "expiresAt", id as "publicShareId"
        )
        select
          ${mediaAssetSelect("published_asset", false)},
          true as "hasActivePublicShare",
          created_share."expiresAt" as "publicShareExpiresAt",
          created_share."publicShareId"
        from published_asset
        join created_share on created_share.asset_id = published_asset.id
        limit 1
      `,
      [assetId, workspaceId, tokenHash, mediaPublicShareScope, expiresAt],
    );
    if (!row) return null;

    return withTransientPublicToken(normalizeMediaAsset(row), token, {
      expiresAt: String(row.publicShareExpiresAt),
      id: String(row.publicShareId),
    });
  }

  const library = await readMediaLibrary();
  const asset = library.assets.find((item) => item.id === assetId && item.workspaceId === workspaceId);
  if (!asset) return null;

  asset.isPublic = true;
  asset.hasActivePublicShare = true;
  if (asset.storageAccess === "legacy-public") asset.storageAccess = "published-public";
  const share: MediaShareRecord = {
    assetId,
    createdAt: new Date().toISOString(),
    expiresAt,
    id: randomUUID(),
    revokedAt: null,
    scope: mediaPublicShareScope,
    tokenHash,
    workspaceId,
  };
  library.shares.push(share);
  await writeMediaLibrary(library);

  return withTransientPublicToken(normalizeMediaAsset(asset), token, share);
}

export async function revokeWorkspaceMediaShare(
  assetId: string,
  workspaceId: string,
  publicShareId: string,
) {
  if (hasDatabaseUrl()) {
    const row = await queryOne<MediaAssetRow>(
      `
        with revoked_share as (
          update media_asset_shares
          set revoked_at = coalesce(revoked_at, now())
          where id = $3
            and asset_id = $1
            and workspace_id = $2
            and revoked_at is null
          returning asset_id, workspace_id
        ), updated_asset as (
          update media_assets ma
          set is_public = exists (
                select 1
                from media_asset_shares active_share
                where active_share.asset_id = ma.id
                  and active_share.workspace_id = ma.workspace_id
                  and active_share.scope = $4
                  and active_share.revoked_at is null
                  and active_share.expires_at > now()
                  and active_share.id <> $3
              ),
              storage_access = case
                when not exists (
                  select 1
                  from media_asset_shares active_share
                  where active_share.asset_id = ma.id
                    and active_share.workspace_id = ma.workspace_id
                    and active_share.scope = $4
                    and active_share.revoked_at is null
                    and active_share.expires_at > now()
                    and active_share.id <> $3
                ) and ma.storage_access = 'published-public'
                  then 'legacy-public'
                else ma.storage_access
              end
          from revoked_share
          where ma.id = revoked_share.asset_id
            and ma.workspace_id = revoked_share.workspace_id
          returning ma.*
        )
        select
          ${mediaAssetSelect("updated_asset", false)},
          updated_asset.is_public as "hasActivePublicShare"
        from updated_asset
        limit 1
      `,
      [assetId, workspaceId, publicShareId, mediaPublicShareScope],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  const asset = library.assets.find((item) => item.id === assetId && item.workspaceId === workspaceId);
  const share = library.shares.find(
    (item) => item.id === publicShareId && item.assetId === assetId && item.workspaceId === workspaceId,
  );
  if (!asset || !share) return null;

  share.revokedAt = share.revokedAt ?? new Date().toISOString();
  const hasActivePublicShare = library.shares.some(
    (item) => item.assetId === assetId && item.workspaceId === workspaceId && isActiveShare(item),
  );
  asset.hasActivePublicShare = hasActivePublicShare;
  asset.isPublic = hasActivePublicShare;
  if (!hasActivePublicShare && asset.storageAccess === "published-public") {
    asset.storageAccess = "legacy-public";
  }
  await writeMediaLibrary(library);
  return asset;
}

export async function extendWorkspaceMediaShare(
  assetId: string,
  workspaceId: string,
  publicShareId: string,
  expiresInSeconds: number,
) {
  const expiresAt = new Date(Date.now() + getMediaShareTtlSeconds(expiresInSeconds) * 1000).toISOString();

  if (hasDatabaseUrl()) {
    return queryOne<{ expiresAt: string | Date; id: string }>(
      `
        update media_asset_shares
        set expires_at = greatest(expires_at, $4::timestamptz)
        where id = $3
          and asset_id = $1
          and workspace_id = $2
          and scope = $5
          and revoked_at is null
          and expires_at > now()
        returning expires_at as "expiresAt", id
      `,
      [assetId, workspaceId, publicShareId, expiresAt, mediaPublicShareScope],
    );
  }

  const library = await readMediaLibrary();
  const share = library.shares.find(
    (item) =>
      item.id === publicShareId &&
      item.assetId === assetId &&
      item.workspaceId === workspaceId &&
      item.scope === mediaPublicShareScope &&
      isActiveShare(item),
  );
  if (!share) return null;

  if (new Date(share.expiresAt).getTime() < new Date(expiresAt).getTime()) {
    share.expiresAt = expiresAt;
  }
  await writeMediaLibrary(library);
  return { expiresAt: share.expiresAt, id: share.id };
}

export async function revokeWorkspaceMediaPublication(assetId: string, workspaceId: string) {
  if (hasDatabaseUrl()) {
    const row = await queryOne<MediaAssetRow>(
      `
        with unpublished_asset as (
          update media_assets
          set is_public = false,
              public_token = null,
              storage_access = case
                when storage_access = 'published-public' then 'legacy-public'
                else storage_access
              end
          where id = $1
            and workspace_id = $2
          returning *
        ), revoked_shares as (
          update media_asset_shares mas
          set revoked_at = coalesce(mas.revoked_at, now())
          from unpublished_asset
          where mas.asset_id = unpublished_asset.id
            and mas.workspace_id = unpublished_asset.workspace_id
            and mas.revoked_at is null
          returning mas.asset_id
        )
        select
          ${mediaAssetSelect("unpublished_asset", false)},
          false as "hasActivePublicShare",
          (select count(*) from revoked_shares) as "revokedShareCount"
        from unpublished_asset
        limit 1
      `,
      [assetId, workspaceId],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  const asset = library.assets.find((item) => item.id === assetId && item.workspaceId === workspaceId);
  if (!asset) return null;

  const revokedAt = new Date().toISOString();
  asset.isPublic = false;
  asset.hasActivePublicShare = false;
  asset.publicToken = null;
  asset.publicUrl = null;
  if (asset.storageAccess === "published-public") asset.storageAccess = "legacy-public";
  for (const share of library.shares) {
    if (share.assetId === assetId && share.workspaceId === workspaceId && !share.revokedAt) {
      share.revokedAt = revokedAt;
    }
  }
  await writeMediaLibrary(library);
  return normalizeMediaAsset(asset);
}

function withTransientPublicToken(
  asset: MediaAsset,
  token: string,
  share: Pick<MediaShareRecord, "expiresAt" | "id">,
): MediaAsset {
  const next = {
    ...asset,
    hasActivePublicShare: true,
    isPublic: true,
    publicShareExpiresAt: share.expiresAt,
    publicShareId: share.id,
    publicToken: token,
  };
  return { ...next, publicUrl: getPublicMediaUrl(next) };
}

export function getPublicMediaUrl(asset: Pick<MediaAsset, "isPublic" | "publicToken">, requestUrl?: string) {
  if (!asset.isPublic || !asset.publicToken) return null;

  const pathName = `/api/media/public/${asset.publicToken}`;
  return requestUrl ? new URL(pathName, requestUrl).toString() : pathName;
}

export function serializeMediaAsset(asset: MediaAsset): MediaAssetClient {
  return {
    accessClass: asset.storageAccess,
    alt: asset.alt,
    createdAt: asset.createdAt,
    folder: asset.folder,
    hasActivePublicShare: asset.hasActivePublicShare,
    id: asset.id,
    isPublic: asset.isPublic,
    mimeType: asset.mimeType,
    name: asset.name,
    originalName: asset.originalName,
    publicUrl: getPublicMediaUrl(asset),
    sizeBytes: asset.sizeBytes,
    url: protectedMediaPath(asset.id),
  };
}

export function mediaAssetPath(asset: MediaAsset) {
  const pathname = storagePathname(asset);
  const resolvedPath = path.resolve(uploadRoot, ...pathname.split("/"));
  const resolvedRoot = `${path.resolve(uploadRoot)}${path.sep}`;
  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new MediaStoreError("INVALID_STORAGE_REFERENCE", "Media storage reference is invalid.");
  }
  return resolvedPath;
}

export async function deleteWorkspaceMedia(assetId: string, workspaceId: string) {
  const asset = hasDatabaseUrl()
    ? await findWorkspaceMediaAsset(assetId, workspaceId)
    : (await readMediaLibrary()).assets.find((item) => item.id === assetId && item.workspaceId === workspaceId) ?? null;
  if (!asset) return null;

  if (hasDatabaseUrl()) {
    await executeQuery("delete from media_assets where id = $1 and workspace_id = $2", [assetId, workspaceId]);
  } else {
    const library = await readMediaLibrary();
    library.assets = library.assets.filter((item) => item.id !== assetId);
    library.shares = library.shares.filter((item) => item.assetId !== assetId || item.workspaceId !== workspaceId);
    await writeMediaLibrary(library);
  }

  await deleteStoredFile(asset).catch(() => undefined);
  return asset;
}

export async function mediaAssetExists(asset: MediaAsset) {
  if (asset.storageProvider === "vercel-blob") return true;

  try {
    await stat(mediaAssetPath(asset));
    return true;
  } catch {
    return false;
  }
}

export function isBlobAsset(asset: MediaAsset) {
  return asset.storageProvider === "vercel-blob";
}

export async function readMediaAssetContent(asset: MediaAsset) {
  if (asset.storageProvider === "local") {
    try {
      const body = await readFile(mediaAssetPath(asset));
      return { body, contentType: safeMediaMimeType(asset.mimeType), sizeBytes: body.byteLength };
    } catch {
      return null;
    }
  }

  const privateAccess = asset.storageAccess === "private";
  const token = privateAccess ? privateBlobToken() : publicBlobToken();
  if (!token) {
    throw new MediaStoreError(
      privateAccess ? "PRIVATE_STORAGE_UNAVAILABLE" : "PUBLIC_STORAGE_UNAVAILABLE",
      "Media storage is unavailable.",
    );
  }

  const blob = await get(storagePathname(asset), {
    abortSignal: AbortSignal.timeout(15_000),
    access: privateAccess ? "private" : "public",
    token,
    useCache: false,
  });
  if (!blob || blob.statusCode !== 200) return null;

  return {
    body: blob.stream,
    contentType: safeMediaMimeType(asset.mimeType),
    sizeBytes: blob.blob.size,
  };
}

export class MediaStoreError extends Error {
  code:
    | "FILE_CONTENT_MISMATCH"
    | "FILE_TOO_LARGE"
    | "IMAGE_TOO_LARGE"
    | "INVALID_STORAGE_REFERENCE"
    | "PRIVATE_STORAGE_UNAVAILABLE"
    | "PUBLIC_STORAGE_UNAVAILABLE"
    | "UNSUPPORTED_FILE_TYPE"
    | "UNSUPPORTED_IMAGE_TYPE"
    | "WORKSPACE_QUOTA_EXCEEDED";

  constructor(code: MediaStoreError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

async function readMediaLibrary(): Promise<MediaLibrary> {
  try {
    const parsed = JSON.parse(await readFile(libraryPath, "utf8")) as Partial<MediaLibrary>;
    const rawAssets = Array.isArray(parsed.assets) ? parsed.assets : [];
    let persistedStateNeedsRewrite = false;
    const shares: MediaShareRecord[] = [];
    for (const value of Array.isArray(parsed.shares) ? parsed.shares : []) {
      const share = normalizeMediaShareRecord(value);
      if (!share) continue;
      if (!(value as Partial<MediaShareRecord>).id || !(value as Partial<MediaShareRecord>).createdAt) {
        persistedStateNeedsRewrite = true;
      }
      shares.push(share);
    }
    const assets = rawAssets.map((rawAsset) => {
      const publicToken = typeof rawAsset.publicToken === "string" ? rawAsset.publicToken.trim() : "";
      if (publicToken && rawAsset.isPublic) {
        const tokenHash = hashMediaShareToken(publicToken);
        if (!shares.some((share) => share.tokenHash === tokenHash)) {
          shares.push({
            assetId: rawAsset.id,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            id: randomUUID(),
            revokedAt: null,
            scope: mediaPublicShareScope,
            tokenHash,
            workspaceId: rawAsset.workspaceId,
          });
        }
        persistedStateNeedsRewrite = true;
      }

      if (rawAsset.url !== protectedMediaPath(rawAsset.id) || rawAsset.publicUrl) {
        persistedStateNeedsRewrite = true;
      }

      return normalizeMediaAsset({ ...rawAsset, publicToken: null });
    });
    const library = { assets, shares };

    if (persistedStateNeedsRewrite) await writeMediaLibrary(library);
    return library;
  } catch {
    return { assets: [], shares: [] };
  }
}

function normalizeMediaShareRecord(value: unknown): MediaShareRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<MediaShareRecord>;
  if (!(record.assetId && record.workspaceId && record.tokenHash && record.scope && record.expiresAt)) {
    return null;
  }

  return {
    assetId: record.assetId,
    createdAt: record.createdAt || new Date().toISOString(),
    expiresAt: record.expiresAt,
    id: record.id || randomUUID(),
    revokedAt: record.revokedAt ?? null,
    scope: record.scope,
    tokenHash: record.tokenHash,
    workspaceId: record.workspaceId,
  };
}

function isActiveShare(share: MediaShareRecord) {
  return !share.revokedAt && new Date(share.expiresAt).getTime() > Date.now();
}

async function writeMediaLibrary(library: MediaLibrary) {
  await mkdir(mediaRoot, { recursive: true });
  const persisted = {
    assets: library.assets.map(stripTransientMediaFields),
    shares: library.shares,
  };
  await writeFile(libraryPath, JSON.stringify(persisted, null, 2), "utf8");
}

function stripTransientMediaFields(asset: MediaAsset) {
  const persisted = { ...asset };
  delete persisted.publicToken;
  delete persisted.publicUrl;
  delete persisted.publicShareExpiresAt;
  delete persisted.publicShareId;
  return persisted;
}

function sanitizeSegment(value: string) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return sanitized || "media";
}

function storagePathname(asset: Pick<MediaAsset, "relativePath" | "workspaceId">) {
  const pathname = asset.relativePath.replace(/\\/g, "/");
  const normalized = path.posix.normalize(pathname);
  const workspacePrefix = `${sanitizeSegment(asset.workspaceId)}/`;
  if (
    !pathname ||
    pathname !== normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    !normalized.startsWith(workspacePrefix)
  ) {
    throw new MediaStoreError("INVALID_STORAGE_REFERENCE", "Media storage reference is invalid.");
  }
  return normalized;
}

async function readWorkspaceAssets(workspaceId: string) {
  if (hasDatabaseUrl()) {
    const rows = await queryRows<MediaAssetRow>(
      `
        select ${mediaAssetSelect()}
        from media_assets ma
        where ma.workspace_id = $1
        order by ma.created_at desc
      `,
      [workspaceId],
    );
    return rows.map(normalizeMediaAsset);
  }

  const library = await readMediaLibrary();
  return library.assets
    .filter((asset) => asset.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function persistMediaAsset(asset: MediaAsset) {
  if (hasDatabaseUrl()) {
    await executeQuery(
      `
        insert into media_assets (
          id, workspace_id, name, original_name, folder, mime_type, size_bytes,
          url, relative_path, storage_provider, storage_access, alt, created_at,
          is_public, public_token
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, null)
      `,
      [
        asset.id,
        asset.workspaceId,
        asset.name,
        asset.originalName,
        asset.folder,
        asset.mimeType,
        asset.sizeBytes,
        protectedMediaPath(asset.id),
        asset.relativePath,
        asset.storageProvider,
        asset.storageAccess,
        asset.alt ?? null,
        asset.createdAt,
        asset.isPublic,
      ],
    );
    return;
  }

  const library = await readMediaLibrary();
  library.assets = [asset, ...library.assets];
  await writeMediaLibrary(library);
}

async function storeMediaFile(
  file: File,
  relativePath: string,
): Promise<Pick<MediaAsset, "relativePath" | "storageAccess" | "storageProvider">> {
  const privateToken = privateBlobToken();
  if (privateToken) {
    const blob = await put(relativePath, file, {
      access: "private",
      contentType: file.type,
      maximumSizeInBytes: maxMediaUploadBytes,
      token: privateToken,
    });
    return {
      relativePath: blob.pathname || relativePath,
      storageAccess: "private",
      storageProvider: "vercel-blob",
    };
  }

  if (process.env.VERCEL === "1" || publicBlobToken()) {
    throw new MediaStoreError("PRIVATE_STORAGE_UNAVAILABLE", "Private media storage is not configured.");
  }

  const targetPath = path.join(uploadRoot, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(await file.arrayBuffer()));

  return {
    relativePath,
    storageAccess: "private",
    storageProvider: "local",
  };
}

async function deleteStoredFile(asset: MediaAsset) {
  if (asset.storageProvider === "vercel-blob") {
    const token = asset.storageAccess === "private" ? privateBlobToken() : publicBlobToken();
    if (!token) throw new MediaStoreError("PRIVATE_STORAGE_UNAVAILABLE", "Media storage is unavailable.");
    await del(storagePathname(asset), { token });
    return;
  }

  await rm(mediaAssetPath(asset), { force: true });
}

function privateBlobToken() {
  return (
    process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN?.trim() ||
    process.env.BLOB_PRIVATE_READ_WRITE_TOKEN?.trim() ||
    ""
  );
}

function publicBlobToken() {
  return (
    process.env.NOVALURE_PUBLIC_BLOB_READ_WRITE_TOKEN?.trim() ||
    process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
    ""
  );
}

function assertBlobAccessConfigured(asset: MediaAsset) {
  if (asset.storageProvider !== "vercel-blob") return;
  const privateAccess = asset.storageAccess === "private";
  const token = privateAccess ? privateBlobToken() : publicBlobToken();
  if (!token) {
    throw new MediaStoreError(
      privateAccess ? "PRIVATE_STORAGE_UNAVAILABLE" : "PUBLIC_STORAGE_UNAVAILABLE",
      "Media storage is unavailable.",
    );
  }
}

function getMediaShareTtlSeconds(requested?: number) {
  if (Number.isFinite(requested)) {
    return Math.max(5 * 60, Math.min(7 * 24 * 60 * 60, Math.floor(requested as number)));
  }

  const rawValue = process.env.NOVALURE_MEDIA_SHARE_TTL_SECONDS?.trim();
  if (!rawValue) return 365 * 24 * 60 * 60;
  const configured = Number(rawValue);
  if (!Number.isFinite(configured)) return 365 * 24 * 60 * 60;
  return Math.max(60 * 60, Math.min(365 * 24 * 60 * 60, Math.floor(configured)));
}

function protectedMediaPath(assetId: string) {
  return `/api/media/files/${assetId}`;
}

function safeMediaMimeType(value: string) {
  return allowedMediaMimeTypes.has(value.toLowerCase()) ? value.toLowerCase() : "application/octet-stream";
}

function normalizeMediaAsset(asset: MediaAsset | MediaAssetRow): MediaAsset {
  const storageProvider = asset.storageProvider === "vercel-blob" ? "vercel-blob" : "local";
  const isPublic = Boolean(asset.isPublic);
  const storageAccess = normalizeStorageAccess(asset.storageAccess, storageProvider, isPublic);
  const createdAt = asset.createdAt instanceof Date ? asset.createdAt.toISOString() : String(asset.createdAt);
  const publicToken = asset.publicToken ?? null;
  const normalized: MediaAsset = {
    id: asset.id,
    workspaceId: asset.workspaceId,
    name: asset.name,
    originalName: asset.originalName,
    folder: asset.folder,
    mimeType: safeMediaMimeType(asset.mimeType),
    sizeBytes: Number(asset.sizeBytes || 0),
    url: protectedMediaPath(asset.id),
    relativePath: asset.relativePath,
    storageProvider,
    storageAccess,
    alt: asset.alt || undefined,
    createdAt,
    hasActivePublicShare: Boolean(asset.hasActivePublicShare),
    isPublic,
    publicToken,
    publicShareExpiresAt:
      asset.publicShareExpiresAt instanceof Date
        ? asset.publicShareExpiresAt.toISOString()
        : asset.publicShareExpiresAt ?? null,
    publicShareId: asset.publicShareId ?? null,
    publicUrl: null,
  };
  return { ...normalized, publicUrl: getPublicMediaUrl(normalized) };
}

function normalizeStorageAccess(
  value: MediaStorageAccess | null | undefined,
  storageProvider: MediaAsset["storageProvider"],
  isPublic: boolean,
): MediaStorageAccess {
  if (value === "private" || value === "legacy-public" || value === "published-public") return value;
  if (storageProvider === "vercel-blob") return isPublic ? "published-public" : "legacy-public";
  return "private";
}
