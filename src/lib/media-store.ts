import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, get, put } from "@vercel/blob";
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
  scanStatus: "pending" | "clean" | "infected" | "failed";
  sha256?: string | null;
  storageAccess: "private" | "legacy_public";
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

export function isAllowedImage(file: File) {
  const extension = path.extname(file.name).toLowerCase();
  return allowedImageMimeTypes.has(file.type) && allowedImageExtensions.has(extension);
}

export function isAllowedMediaFile(file: File) {
  const extension = path.extname(file.name).toLowerCase();
  return allowedMediaMimeTypes.has(file.type) && allowedMediaExtensions.has(extension);
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function detectMediaMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  const ascii = (start: number, length: number) => Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (["ftypavif", "ftypavis"].includes(ascii(4, 8))) return "image/avif";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "application/msword";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const archiveText = Buffer.from(bytes).toString("latin1");
    if (archiveText.includes("[Content_Types].xml") && archiveText.includes("word/")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
  }
  return null;
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

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const detectedMimeType = detectMediaMime(bytes);
  if (!detectedMimeType || detectedMimeType !== input.file.type) {
    throw new MediaStoreError("INVALID_FILE_SIGNATURE", "The file content does not match its declared type.");
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
  const stored = await storeMediaFile(bytes, input.file.type, relativePath);
  const scanStatus = allowedImageMimeTypes.has(detectedMimeType) ? "clean" as const : "pending" as const;

  const asset: MediaAsset = {
    id,
    workspaceId: input.workspaceId,
    name: input.name?.trim() || input.file.name,
    originalName: input.file.name,
    folder,
    mimeType: input.file.type,
    sizeBytes,
    url: `/api/media/files/${id}`,
    relativePath: stored.relativePath,
    storageProvider: stored.storageProvider,
    alt: input.alt?.trim() || input.name?.trim() || input.file.name,
    createdAt: new Date().toISOString(),
    isPublic: false,
    publicToken: null,
    publicUrl: null,
    scanStatus,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storageAccess: "private",
  };

  try {
    await persistMediaAsset(asset);
    if (asset.scanStatus === "pending") {
      const scanResult = await scanMediaWithConfiguredProvider({
        assetId: asset.id,
        bytes,
        fileName: asset.originalName,
        mimeType: asset.mimeType,
        sha256: asset.sha256 ?? "",
      });
      if (scanResult) {
        asset.scanStatus = scanResult.status;
        await executeQuery(
          "update media_assets set scan_status = $2, scan_error = $3, updated_at = now() where id = $1",
          [asset.id, scanResult.status, scanResult.error ?? null],
        );
      }
    }
  } catch (error) {
    await deleteStoredFile(asset).catch(() => undefined);
    throw error;
  }

  return asset;
}

async function scanMediaWithConfiguredProvider(input: {
  assetId: string;
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  sha256: string;
}): Promise<{ error?: string; status: MediaAsset["scanStatus"] } | null> {
  const endpoint = process.env.MEDIA_SCAN_WEBHOOK_URL?.trim();
  const secret = process.env.MEDIA_SCAN_WEBHOOK_SECRET?.trim();
  if (!endpoint || !secret) return null;
  const formData = new FormData();
  formData.set("assetId", input.assetId);
  formData.set("sha256", input.sha256);
  formData.set("file", new Blob([Buffer.from(input.bytes)], { type: input.mimeType }), input.fileName);
  try {
    const response = await fetch(endpoint, {
      body: formData,
      headers: { Authorization: `Bearer ${secret}` },
      method: "POST",
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; status?: string };
    if (!response.ok) return { error: payload.error || `Scanner returned ${response.status}`, status: "failed" };
    if (payload.status === "clean" || payload.status === "infected") return { status: payload.status };
    return { error: "Scanner returned an invalid verdict", status: "failed" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Scanner request failed", status: "failed" };
  }
}

export async function findMediaAsset(assetId: string) {
  if (hasDatabaseUrl()) {
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
          , sha256
          , scan_status as "scanStatus"
          , storage_access as "storageAccess"
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
          , sha256
          , scan_status as "scanStatus"
          , storage_access as "storageAccess"
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
          , sha256
          , scan_status as "scanStatus"
          , storage_access as "storageAccess"
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
    const row = await queryOne<MediaAssetRow>(
      `
        update media_assets
        set is_public = true,
            public_token = coalesce(public_token, $3)
        where id = $1
          and workspace_id = $2
          and scan_status = 'clean'
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
          , sha256
          , scan_status as "scanStatus"
          , storage_access as "storageAccess"
      `,
      [assetId, workspaceId, token],
    );
    return row ? normalizeMediaAsset(row) : null;
  }

  const library = await readMediaLibrary();
  const asset = library.assets.find((item) => item.id === assetId && item.workspaceId === workspaceId);
  if (!asset) return null;
  if (asset.scanStatus !== "clean") return null;

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

export function getMediaContentDisposition(asset: Pick<MediaAsset, "mimeType" | "originalName">) {
  const fileName = asset.originalName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180) || "download";
  return `${asset.mimeType.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
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

export async function readMediaAssetContent(asset: MediaAsset) {
  if (asset.scanStatus !== "clean") {
    throw new MediaStoreError("FILE_QUARANTINED", "The media asset is awaiting a successful malware scan.");
  }
  if (asset.storageProvider === "vercel-blob") {
    if (asset.storageAccess !== "private") {
      throw new MediaStoreError("FILE_QUARANTINED", "Legacy public media must be migrated before delivery.");
    }
    const token = getPrivateBlobToken();
    if (!token) throw new MediaStoreError("PRIVATE_STORAGE_NOT_CONFIGURED", "Private media storage is not configured.");
    return get(asset.relativePath, { access: "private", token, useCache: false });
  }
  const bytes = await readFile(mediaAssetPath(asset));
  return { stream: new Blob([bytes]).stream() };
}

export function isBlobAsset(asset: MediaAsset) {
  return asset.storageProvider === "vercel-blob";
}

export class MediaStoreError extends Error {
  code: "FILE_QUARANTINED" | "FILE_TOO_LARGE" | "IMAGE_TOO_LARGE" | "INVALID_FILE_SIGNATURE" | "PRIVATE_STORAGE_NOT_CONFIGURED" | "UNSUPPORTED_FILE_TYPE" | "UNSUPPORTED_IMAGE_TYPE" | "WORKSPACE_QUOTA_EXCEEDED";

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
  scanStatus?: MediaAsset["scanStatus"] | null;
  sha256?: string | null;
  storageAccess?: MediaAsset["storageAccess"] | null;
};

async function readWorkspaceAssets(workspaceId: string) {
  if (hasDatabaseUrl()) {
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
          , sha256
          , scan_status as "scanStatus"
          , storage_access as "storageAccess"
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
          , sha256
          , scan_status
          , storage_access
          , blob_url
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
        asset.sha256 ?? null,
        asset.scanStatus,
        asset.storageAccess,
        asset.storageProvider === "vercel-blob" ? asset.relativePath : null,
      ],
    );
    return;
  }

  const library = await readMediaLibrary();
  library.assets = [asset, ...library.assets];
  await writeMediaLibrary(library);
}

async function storeMediaFile(bytes: Uint8Array, contentType: string, relativePath: string): Promise<Pick<MediaAsset, "relativePath" | "storageProvider">> {
  const privateBlobToken = getPrivateBlobToken();
  if (privateBlobToken) {
    const blob = await put(relativePath, Buffer.from(bytes), { access: "private", contentType, token: privateBlobToken });
    return {
      relativePath: blob.pathname || relativePath,
      storageProvider: "vercel-blob",
    };
  }

  if (process.env.VERCEL || hasDatabaseUrl()) {
    throw new MediaStoreError("PRIVATE_STORAGE_NOT_CONFIGURED", "Private media storage is not configured.");
  }

  const targetPath = path.join(uploadRoot, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);

  return {
    relativePath,
    storageProvider: "local",
  };
}

async function deleteStoredFile(asset: MediaAsset) {
  if (asset.storageProvider === "vercel-blob") {
    if (asset.storageAccess !== "private") {
      throw new MediaStoreError("FILE_QUARANTINED", "Legacy public media must be migrated before deletion.");
    }
    const token = getPrivateBlobToken();
    if (!token) throw new MediaStoreError("PRIVATE_STORAGE_NOT_CONFIGURED", "Private media storage is not configured.");
    await del(asset.relativePath, { token });
    return;
  }

  await rm(mediaAssetPath(asset), { force: true });
}

function getPrivateBlobToken() {
  const dedicated = process.env.NOVALURE_PRIVATE_BLOB_READ_WRITE_TOKEN?.trim()
    || process.env.PRIVATE_BLOB_READ_WRITE_TOKEN?.trim();
  if (dedicated) return dedicated;
  return process.env.NOVALURE_BLOB_STORE_ACCESS === "private"
    ? process.env.BLOB_READ_WRITE_TOKEN?.trim() || null
    : null;
}

function normalizeMediaAsset(asset: MediaAsset | MediaAssetRow): MediaAsset {
  const storageProvider = asset.storageProvider === "vercel-blob" ? "vercel-blob" : "local";
  const url = `/api/media/files/${asset.id}`;

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
    scanStatus: asset.scanStatus === "clean" || asset.scanStatus === "infected" || asset.scanStatus === "failed"
      ? asset.scanStatus
      : "pending",
    sha256: asset.sha256 ?? null,
    storageAccess: asset.storageAccess === "legacy_public" ? "legacy_public" : "private",
  };
}
