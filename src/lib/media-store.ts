import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, put } from "@vercel/blob";
import { executeQuery, hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";

export const maxImageUploadBytes = 10 * 1024 * 1024;
export const maxMediaUploadBytes = maxImageUploadBytes;
export const workspaceImageQuotaBytes = 1024 * 1024 * 1024;

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
  alt?: string;
  createdAt: string;
  isPublic: boolean;
  publicToken?: string | null;
  publicUrl?: string | null;
};

type MediaLibrary = {
  assets: MediaAsset[];
};

const allowedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const allowedDocumentMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const allowedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const allowedDocumentExtensions = new Set([".pdf", ".doc", ".docx"]);
const allowedMediaMimeTypes = new Set([...allowedImageMimeTypes, ...allowedDocumentMimeTypes]);
const allowedMediaExtensions = new Set([...allowedImageExtensions, ...allowedDocumentExtensions]);
const mediaRoot = process.env.NOVALURE_MEDIA_ROOT || path.join(process.cwd(), ".data", "media");
const uploadRoot = path.join(mediaRoot, "uploads");
const libraryPath = path.join(mediaRoot, "library.json");
let mediaTableReady = false;

export function isAllowedImage(file: File) {
  const extension = path.extname(file.name).toLowerCase();
  return allowedImageMimeTypes.has(file.type) && allowedImageExtensions.has(extension);
}

export function isAllowedMediaFile(file: File) {
  const extension = path.extname(file.name).toLowerCase();
  return allowedMediaMimeTypes.has(file.type) && allowedMediaExtensions.has(extension);
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
    mimeType: input.file.type,
    sizeBytes,
    url: stored.url || `/api/media/files/${id}`,
    relativePath: stored.relativePath,
    storageProvider: stored.storageProvider,
    alt: input.alt?.trim() || input.name?.trim() || input.file.name,
    createdAt: new Date().toISOString(),
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

export async function findMediaAsset(assetId: string) {
  if (hasDatabaseUrl()) {
    await ensureMediaAssetsTable();
    const row = await queryOne<MediaAssetRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          name,
          original_name as "originalName",
          folder,
          mime_type as "mimeType",
          size_bytes as "sizeBytes",
          url,
          relative_path as "relativePath",
          storage_provider as "storageProvider",
          alt,
          created_at as "createdAt",
          is_public as "isPublic",
          public_token as "publicToken"
        from media_assets
        where id = $1
        limit 1
      `,
      [assetId],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  return library.assets.find((asset) => asset.id === assetId) ?? null;
}

export async function findPublicMediaAsset(publicToken: string) {
  if (!publicToken.trim()) return null;

  if (hasDatabaseUrl()) {
    await ensureMediaAssetsTable();
    const row = await queryOne<MediaAssetRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          name,
          original_name as "originalName",
          folder,
          mime_type as "mimeType",
          size_bytes as "sizeBytes",
          url,
          relative_path as "relativePath",
          storage_provider as "storageProvider",
          alt,
          created_at as "createdAt",
          is_public as "isPublic",
          public_token as "publicToken"
        from media_assets
        where is_public = true
          and public_token = $1
        limit 1
      `,
      [publicToken],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  return library.assets.find((asset) => asset.isPublic && asset.publicToken === publicToken) ?? null;
}

export async function findWorkspaceMediaAsset(assetId: string, workspaceId: string) {
  if (hasDatabaseUrl()) {
    await ensureMediaAssetsTable();
    const row = await queryOne<MediaAssetRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          name,
          original_name as "originalName",
          folder,
          mime_type as "mimeType",
          size_bytes as "sizeBytes",
          url,
          relative_path as "relativePath",
          storage_provider as "storageProvider",
          alt,
          created_at as "createdAt",
          is_public as "isPublic",
          public_token as "publicToken"
        from media_assets
        where id = $1 and workspace_id = $2
        limit 1
      `,
      [assetId, workspaceId],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  return library.assets.find((asset) => asset.id === assetId && asset.workspaceId === workspaceId) ?? null;
}

export async function publishWorkspaceMedia(assetId: string, workspaceId: string) {
  const token = randomUUID();

  if (hasDatabaseUrl()) {
    await ensureMediaAssetsTable();
    const row = await queryOne<MediaAssetRow>(
      `
        update media_assets
        set is_public = true,
            public_token = coalesce(public_token, $3)
        where id = $1
          and workspace_id = $2
        returning
          id,
          workspace_id as "workspaceId",
          name,
          original_name as "originalName",
          folder,
          mime_type as "mimeType",
          size_bytes as "sizeBytes",
          url,
          relative_path as "relativePath",
          storage_provider as "storageProvider",
          alt,
          created_at as "createdAt",
          is_public as "isPublic",
          public_token as "publicToken"
      `,
      [assetId, workspaceId, token],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  const asset = library.assets.find((item) => item.id === assetId && item.workspaceId === workspaceId);
  if (!asset) return null;

  asset.isPublic = true;
  asset.publicToken = asset.publicToken || token;
  asset.publicUrl = getPublicMediaUrl(asset);
  await writeMediaLibrary(library);

  return normalizeMediaAsset(asset);
}

export function getPublicMediaUrl(asset: Pick<MediaAsset, "isPublic" | "publicToken">, requestUrl?: string) {
  if (!asset.isPublic || !asset.publicToken) return null;

  const pathName = `/api/media/public/${asset.publicToken}`;
  return requestUrl ? new URL(pathName, requestUrl).toString() : pathName;
}

export function mediaAssetPath(asset: MediaAsset) {
  return path.join(uploadRoot, asset.relativePath);
}

export async function deleteWorkspaceMedia(assetId: string, workspaceId: string) {
  const asset = hasDatabaseUrl()
    ? await findWorkspaceMediaAsset(assetId, workspaceId)
    : (await readMediaLibrary()).assets.find((item) => item.id === assetId && item.workspaceId === workspaceId) ?? null;
  if (!asset) return null;

  if (hasDatabaseUrl()) {
    await ensureMediaAssetsTable();
    await executeQuery("delete from media_assets where id = $1 and workspace_id = $2", [assetId, workspaceId]);
  } else {
    const library = await readMediaLibrary();
    library.assets = library.assets.filter((item) => item.id !== assetId);
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

export class MediaStoreError extends Error {
  code: "FILE_TOO_LARGE" | "IMAGE_TOO_LARGE" | "UNSUPPORTED_FILE_TYPE" | "UNSUPPORTED_IMAGE_TYPE" | "WORKSPACE_QUOTA_EXCEEDED";

  constructor(code: MediaStoreError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

async function readMediaLibrary(): Promise<MediaLibrary> {
  try {
    const parsed = JSON.parse(await readFile(libraryPath, "utf8")) as Partial<MediaLibrary>;
    return {
      assets: Array.isArray(parsed.assets) ? parsed.assets.map(normalizeMediaAsset) : [],
    };
  } catch {
    return { assets: [] };
  }
}

async function writeMediaLibrary(library: MediaLibrary) {
  await mkdir(mediaRoot, { recursive: true });
  await writeFile(libraryPath, JSON.stringify(library, null, 2), "utf8");
}

function sanitizeSegment(value: string) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return sanitized || "media";
}

type MediaAssetRow = Record<string, unknown> & {
  id: string;
  workspaceId: string;
  name: string;
  originalName: string;
  folder: string;
  mimeType: string;
  sizeBytes: number | string;
  url: string;
  relativePath: string;
  storageProvider: "local" | "vercel-blob";
  alt?: string | null;
  createdAt: string;
  isPublic?: boolean | null;
  publicToken?: string | null;
};

async function readWorkspaceAssets(workspaceId: string) {
  if (hasDatabaseUrl()) {
    await ensureMediaAssetsTable();
    const rows = await queryRows<MediaAssetRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          name,
          original_name as "originalName",
          folder,
          mime_type as "mimeType",
          size_bytes as "sizeBytes",
          url,
          relative_path as "relativePath",
          storage_provider as "storageProvider",
          alt,
          created_at as "createdAt",
          is_public as "isPublic",
          public_token as "publicToken"
        from media_assets
        where workspace_id = $1
        order by created_at desc
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
    await ensureMediaAssetsTable();
    await executeQuery(
      `
        insert into media_assets (
          id,
          workspace_id,
          name,
          original_name,
          folder,
          mime_type,
          size_bytes,
          url,
          relative_path,
          storage_provider,
          alt,
          created_at,
          is_public,
          public_token
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `,
      [
        asset.id,
        asset.workspaceId,
        asset.name,
        asset.originalName,
        asset.folder,
        asset.mimeType,
        asset.sizeBytes,
        asset.url,
        asset.relativePath,
        asset.storageProvider,
        asset.alt ?? null,
        asset.createdAt,
        asset.isPublic,
        asset.publicToken ?? null,
      ],
    );
    return;
  }

  const library = await readMediaLibrary();
  library.assets = [asset, ...library.assets];
  await writeMediaLibrary(library);
}

async function storeMediaFile(file: File, relativePath: string): Promise<Pick<MediaAsset, "relativePath" | "storageProvider" | "url">> {
  if (shouldUseVercelBlob()) {
    const blob = await put(relativePath, file, { access: "public" });
    return {
      relativePath: blob.pathname || relativePath,
      storageProvider: "vercel-blob",
      url: blob.url,
    };
  }

  const targetPath = path.join(uploadRoot, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(await file.arrayBuffer()));

  return {
    relativePath,
    storageProvider: "local",
    url: "",
  };
}

async function deleteStoredFile(asset: MediaAsset) {
  if (asset.storageProvider === "vercel-blob") {
    await del(asset.url);
    return;
  }

  await rm(mediaAssetPath(asset), { force: true });
}

function shouldUseVercelBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function ensureMediaAssetsTable() {
  if (mediaTableReady) return;

  await executeQuery(`
    create table if not exists media_assets (
      id uuid primary key,
      workspace_id text not null,
      name text not null,
      original_name text not null,
      folder text not null default 'media-uploads',
      mime_type text not null,
      size_bytes bigint not null default 0,
      url text not null,
      relative_path text not null,
      storage_provider text not null default 'local' check (storage_provider in ('local', 'vercel-blob')),
      alt text,
      created_at timestamptz not null default now(),
      is_public boolean not null default false,
      public_token text
    )
  `);
  await executeQuery("alter table media_assets add column if not exists is_public boolean not null default false");
  await executeQuery("alter table media_assets add column if not exists public_token text");
  await executeQuery("create index if not exists media_assets_workspace_created_idx on media_assets(workspace_id, created_at desc)");
  await executeQuery("create unique index if not exists media_assets_public_token_uidx on media_assets(public_token) where public_token is not null");
  mediaTableReady = true;
}

function normalizeMediaAsset(asset: MediaAsset | MediaAssetRow): MediaAsset {
  const storageProvider = asset.storageProvider === "vercel-blob" ? "vercel-blob" : "local";
  const url = storageProvider === "local" && !asset.url ? `/api/media/files/${asset.id}` : asset.url;

  return {
    id: asset.id,
    workspaceId: asset.workspaceId,
    name: asset.name,
    originalName: asset.originalName,
    folder: asset.folder,
    mimeType: asset.mimeType,
    sizeBytes: Number(asset.sizeBytes || 0),
    url,
    relativePath: asset.relativePath,
    storageProvider,
    alt: asset.alt || undefined,
    createdAt: asset.createdAt,
    isPublic: Boolean(asset.isPublic),
    publicToken: asset.publicToken ?? null,
    publicUrl: getPublicMediaUrl({
      isPublic: Boolean(asset.isPublic),
      publicToken: asset.publicToken ?? null,
    }),
  };
}
