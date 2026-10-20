import "server-only";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { del, get } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import type { AppSession } from "@/lib/auth/session";
import { decryptAuthValue, encryptAuthValue } from "@/lib/auth/auth-security";
import { bindVerifiedPrivateKnowledgeUpload, getPrivateMediaBlobToken, maxMediaUploadBytes } from "@/lib/media-store";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision, knowledgeText } from "./policy";

export type KnowledgeDocumentUploadMetadata = {
  areaId: string; name: string; alt?: string; sourceId?: string; expectedVersion?: number;
  fileName: string; mimeType: string; sizeBytes: number; sha256: string;
};
type UploadScope = Pick<AppSession, "userId" | "workspaceId">;
export type VerifiedKnowledgeDocumentUpload = {
  metadata: KnowledgeDocumentUploadMetadata; pathname: string; expiresAt: number; uploadId: string;
};
type Ticket = VerifiedKnowledgeDocumentUpload & { purpose: string; actorId: string; workspaceId: string; storeFingerprint: string };
const purpose = "knowledge-document-upload-v1";
const ticketTtlMs = 5 * 60_000;
const verified = new WeakSet<VerifiedKnowledgeDocumentUpload>();
const extensions: Record<string, readonly string[]> = {
  "application/pdf": [".pdf"], "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/plain": [".txt"], "text/markdown": [".md"], "text/csv": [".csv"], "application/json": [".json"],
  "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"],
};

export function parseKnowledgeDocumentUploadMetadata(body: Record<string, unknown>): KnowledgeDocumentUploadMetadata {
  const fileName = knowledgeText(body.fileName, "fileName", 255);
  const mimeType = knowledgeText(body.mimeType, "mimeType", 150).toLowerCase();
  if (/[\u0000-\u001f\u007f/\\]/.test(fileName) || !Object.hasOwn(extensions, mimeType) || !extensions[mimeType].includes(path.extname(fileName).toLowerCase())) {
    throw new KnowledgeCenterError("UNSUPPORTED_DOCUMENT", "The document type and filename must match a supported format.", 415);
  }
  if (!Number.isSafeInteger(body.sizeBytes) || Number(body.sizeBytes) <= 0 || Number(body.sizeBytes) > maxMediaUploadBytes) {
    throw new KnowledgeCenterError("PAYLOAD_TOO_LARGE", "Documents must be 10 MB or smaller.", 413);
  }
  if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) throw new KnowledgeCenterError("INVALID_DOCUMENT", "A document checksum is required.");
  const sourceId = body.sourceId === undefined ? undefined : knowledgeId(body.sourceId, "sourceId");
  if (!sourceId && body.expectedVersion !== undefined) throw new KnowledgeCenterError("VALIDATION_ERROR", "expectedVersion requires a sourceId.");
  return {
    fileName, mimeType, sizeBytes: Number(body.sizeBytes), sha256: body.sha256,
    areaId: knowledgeId(body.areaId, "areaId"), name: knowledgeText(body.name ?? fileName, "name", 200),
    ...(body.alt === undefined ? {} : { alt: knowledgeText(body.alt, "alt", 1000, false) }),
    ...(sourceId ? { sourceId, expectedVersion: knowledgeRevision(body.expectedVersion) } : {}),
  };
}

function privateToken() {
  const token = getPrivateMediaBlobToken();
  if (!token) throw new KnowledgeCenterError("PRIVATE_STORAGE_UNAVAILABLE", "Private document storage is not configured.", 503);
  return token;
}

function storeFingerprint() {
  // @vercel/blob 2.8 uses the fourth '_' segment as the store ID when issuing
  // client tokens. Bind that stable identity, so routine key rotation neither
  // strands old reservations nor redirects cleanup to a different store.
  const token = privateToken();
  const [, , , storeId = "", secret = ""] = token.split("_");
  if (!token.startsWith("vercel_blob_rw_") || !/^[a-zA-Z0-9-]+$/.test(storeId) || !secret) {
    throw new KnowledgeCenterError("PRIVATE_STORAGE_UNAVAILABLE", "The private document store credential is invalid.", 503);
  }
  return createHash("sha256").update("novalure-private-blob-store-v1\0").update(storeId).digest("hex");
}

export async function createKnowledgeDocumentUploadTicket(session: UploadScope, input: KnowledgeDocumentUploadMetadata) {
  const metadata = parseKnowledgeDocumentUploadMetadata(input);
  const actorId = knowledgeId(session.userId, "actorId"), workspaceId = knowledgeId(session.workspaceId, "workspaceId");
  const expiresAt = Date.now() + ticketTtlMs;
  const uploadId = randomUUID();
  const pathname = `${workspaceId}/knowledge-staging-${actorId}/${expiresAt}-${uploadId}${path.extname(metadata.fileName).toLowerCase()}`;
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: privateToken(), pathname, maximumSizeInBytes: metadata.sizeBytes, allowedContentTypes: [metadata.mimeType],
    validUntil: expiresAt, addRandomSuffix: false, allowOverwrite: false,
  });
  const claims: Ticket = { purpose, actorId, workspaceId, uploadId, metadata, pathname, expiresAt, storeFingerprint: storeFingerprint() };
  return { ticket: encryptAuthValue(claims), pathname, clientToken };
}

export function verifyKnowledgeDocumentUploadTicket(session: UploadScope, value: unknown): VerifiedKnowledgeDocumentUpload {
  if (typeof value !== "string" || value.length > 16_000) throw new KnowledgeCenterError("INVALID_UPLOAD", "The document upload authorization is invalid.", 403);
  const claims = decryptAuthValue<Ticket>(value);
  if (!claims || claims.purpose !== purpose || claims.actorId !== session.userId || claims.workspaceId !== session.workspaceId || claims.storeFingerprint !== storeFingerprint() ||
      !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= Date.now() || claims.expiresAt > Date.now() + ticketTtlMs ||
      !claims.metadata || typeof claims.metadata !== "object") {
    throw new KnowledgeCenterError("INVALID_UPLOAD", "The document upload authorization expired or does not match this workspace session.", 403);
  }
  const actorId = knowledgeId(claims.actorId), workspaceId = knowledgeId(claims.workspaceId), uploadId = knowledgeId(claims.uploadId);
  const metadata = parseKnowledgeDocumentUploadMetadata(claims.metadata);
  const expected = `${workspaceId}/knowledge-staging-${actorId}/${claims.expiresAt}-${uploadId}${path.extname(metadata.fileName).toLowerCase()}`;
  if (claims.pathname !== expected) throw new KnowledgeCenterError("INVALID_UPLOAD", "The document storage reference is invalid.", 403);
  const upload = { metadata, pathname: expected, expiresAt: claims.expiresAt, uploadId };
  verified.add(upload);
  return upload;
}

/** Bound both advertised metadata and actual streaming bytes before parsing. */
export async function readKnowledgeUploadBytes(stream: ReadableStream<Uint8Array>, metadata: Pick<KnowledgeDocumentUploadMetadata, "sizeBytes" | "sha256">) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const hash = createHash("sha256");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > metadata.sizeBytes || length > maxMediaUploadBytes) {
        await reader.cancel().catch(() => undefined);
        throw new KnowledgeCenterError("PAYLOAD_TOO_LARGE", "The uploaded document exceeds its authorized size.", 413);
      }
      chunks.push(value); hash.update(value);
    }
  } finally { reader.releaseLock(); }
  if (length !== metadata.sizeBytes || hash.digest("hex") !== metadata.sha256) throw new KnowledgeCenterError("DOCUMENT_CHANGED", "The uploaded document does not match its authorized bytes.", 409);
  return Uint8Array.from(Buffer.concat(chunks));
}

export async function readKnowledgeDocumentUpload(upload: VerifiedKnowledgeDocumentUpload) {
  if (!verified.has(upload)) throw new KnowledgeCenterError("INVALID_UPLOAD", "An authorized private document upload is required.", 403);
  const blob = await get(upload.pathname, { access: "private", token: privateToken(), useCache: false, abortSignal: AbortSignal.timeout(30_000) });
  if (!blob || blob.statusCode !== 200) throw new KnowledgeCenterError("DOCUMENT_UNAVAILABLE", "The private upload is not available. Please retry the upload.", 404);
  if (blob.blob.size !== upload.metadata.sizeBytes || blob.blob.contentType.split(";", 1)[0].trim().toLowerCase() !== upload.metadata.mimeType) {
    await blob.stream.cancel().catch(() => undefined);
    throw new KnowledgeCenterError("DOCUMENT_CHANGED", "The private upload does not match its authorized document.", 409);
  }
  const bytes = await readKnowledgeUploadBytes(blob.stream, upload.metadata);
  const file = new File([bytes], upload.metadata.fileName, { type: upload.metadata.mimeType });
  const parts = upload.pathname.split("/");
  bindVerifiedPrivateKnowledgeUpload(file, { workspaceId: parts[0], actorId: parts[1].slice("knowledge-staging-".length), pathname: upload.pathname });
  return file;
}

export async function discardKnowledgeDocumentUpload(upload: VerifiedKnowledgeDocumentUpload) {
  if (!verified.has(upload)) return;
  await del(upload.pathname, { token: privateToken() });
}

/** Only expired, server-recorded staging paths are cleanup candidates. Active
 * grants remain reserved even after finalization, so they cannot reupload bytes
 * into a released quota slot. Cleanup is also available as a manual batch. */
export async function discardExpiredKnowledgeDocumentUpload(session: UploadScope, upload: { uploadId: string; pathname: string; expiresAt: number; actorId: string; storeFingerprint: string }, deleteBlob: (pathname: string, token: string) => Promise<void> = async (pathname, token) => { await del(pathname, { token }); }) {
  const workspaceId = knowledgeId(session.workspaceId), actorId = knowledgeId(upload.actorId), uploadId = knowledgeId(upload.uploadId);
  const prefix = `${workspaceId}/knowledge-staging-${actorId}/${upload.expiresAt}-${uploadId}`;
  if (!Number.isSafeInteger(upload.expiresAt) || upload.expiresAt + 60_000 >= Date.now() ||
      upload.storeFingerprint !== storeFingerprint() || !Object.values(extensions).flat().some((extension) => upload.pathname === `${prefix}${extension}`)) {
    throw new KnowledgeCenterError("INVALID_UPLOAD", "The expired private upload reference is invalid.", 403);
  }
  await deleteBlob(upload.pathname, privateToken());
}

export function knowledgeDocumentUploadStoreFingerprint() { return storeFingerprint(); }
